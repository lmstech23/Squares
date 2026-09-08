import { test, describe, before, after, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";

// Winner notification and resend, through the REAL routes and a real database.
//
// WHY THE ROUTES. What changed is where a text goes, and that is decided by one
// route writing a JSONB value and another reading it back. A test of the parser
// alone proves the parser; these prove that notify stores the phone, that resend
// sends to the STORED one, and that editing the square afterwards cannot move
// the destination.
//
// Supabase auth is faked because createClient() calls next/headers cookies().
// Prisma, the transaction, the JSONB lock and the constraints are all real.
// sendEmail and sendSms are stubbed to record their arguments.
//
//   npm run test:db:up && npm run test:integration:winner

const url = process.env.TEST_DATABASE_URL;
const prisma = url ? new PrismaClient({ datasources: { db: { url } } }) : null;

const SUPABASE_USER_ID = "winner-" + randomUUID();
const emails: { to: string; subject: string }[] = [];
const texts: { to: string; body: string }[] = [];

if (url) {
  mock.module("@/lib/supabase/server", {
    namedExports: {
      createClient: async () => ({
        auth: { getUser: async () => ({ data: { user: { id: SUPABASE_USER_ID } } }) },
      }),
    },
  });
  mock.module("@/lib/email", {
    namedExports: {
      sendEmail: async (to: string, subject: string) => {
        emails.push({ to, subject });
      },
    },
  });
  mock.module("@/lib/twilio", {
    namedExports: {
      sendSms: async (to: string, body: string) => {
        texts.push({ to, body });
      },
    },
  });
}

const notify = url
  ? (await import("../app/api/host/boards/[id]/notify-winner/route.ts")).POST
  : (null as never);
const resend = url
  ? (await import("../app/api/host/boards/[id]/resend-winner-sms/route.ts")).POST
  : (null as never);

describe(
  "winner notification pinning (integration)",
  { skip: !url && "TEST_DATABASE_URL not set" },
  () => {
    const db = prisma!;
    let hostId = "";
    let boardId = "";
    const ORIGINAL = "+16785550001";
    const CHANGED = "+16785559999";

    // Both handlers share a signature but not a response type, so the helper
    // takes the shape rather than one of them — typing it as `typeof notify`
    // makes passing `resend` an error about NextResponse generics, which says
    // nothing useful about the test.
    type Handler = (
      request: Request,
      ctx: { params: Promise<{ id: string }> }
    ) => Promise<Response>;

    const call = async (fn: Handler, body: Record<string, unknown>) => {
      const req = new Request("http://test/api", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const res = await fn(req, { params: Promise.resolve({ id: boardId }) });
      return { status: res.status, json: await res.json() };
    };

    /** A closed Game Day board with numbers, scores, and one paid winner. */
    async function seed(phone: string | null = ORIGINAL) {
      const b = await db.board.create({
        data: {
          hostId,
          gameName: "Winner Test",
          slug: "win-" + randomUUID().slice(0, 8),
          boardType: "game",
          squarePrice: 1000,
          totalSquares: 100,
          status: "closed",
          timezone: "America/New_York",
          periodLabels: ["H1", "Final"],
          // Identity grids: position 0 wins when both scores end in 0.
          rowNumbers: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
          colNumbers: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
          scoresTeamA: [10, 20],
          scoresTeamB: [20, 30],
        },
      });
      boardId = b.boardId;
      await db.boardCollaborator.create({
        data: { boardId, hostId, role: "OWNER", status: "active", acceptedAt: new Date() },
      });
      await db.square.createMany({
        data: Array.from({ length: 100 }, (_, i) => ({
          boardId,
          position: i,
          paymentStatus: "open" as const,
        })),
      });
      // The winning square for H1 (10 % 10 = 0, 20 % 10 = 0 -> position 0).
      await db.square.updateMany({
        where: { boardId, position: 0 },
        data: {
          paymentStatus: "paid",
          playerName: "Winner",
          playerEmail: "winner@example.com",
          playerPhone: phone,
          smsOptIn: true,
          pricePaidCents: 1000,
          batchId: randomUUID(),
        },
      });
    }

    const storedFor = async (label: string) => {
      const b = await db.board.findUniqueOrThrow({
        where: { boardId },
        select: { winnerNotifiedByPeriod: true },
      });
      return (b.winnerNotifiedByPeriod as Record<string, unknown>)[label];
    };

    before(async () => {
      const h = await db.host.create({
        data: { supabaseUserId: SUPABASE_USER_ID, email: "win-" + randomUUID() + "@example.com" },
      });
      hostId = h.id;
    });

    beforeEach(async () => {
      emails.length = 0;
      texts.length = 0;
      if (boardId) {
        await db.boardCollaborator.deleteMany({ where: { boardId } });
        await db.square.deleteMany({ where: { boardId } });
        await db.board.deleteMany({ where: { boardId } });
        boardId = "";
      }
    });

    after(async () => {
      if (boardId) {
        await db.boardCollaborator.deleteMany({ where: { boardId } });
        await db.square.deleteMany({ where: { boardId } });
        await db.board.deleteMany({ where: { boardId } });
      }
      if (hostId) await db.host.deleteMany({ where: { id: hostId } });
      await db.$disconnect();
    });

    // ---- 1. initial notify stores both squareId and phone -------------------

    test("1. notify stores the square AND the phone", async () => {
      await seed();
      const r = await call(notify, { periodLabel: "H1" });
      assert.equal(r.status, 200);

      const stored = (await storedFor("H1")) as Record<string, unknown>;
      const sq = await db.square.findFirstOrThrow({ where: { boardId, position: 0 } });
      assert.equal(stored.squareId, sq.squareId);
      assert.equal(stored.phone, ORIGINAL);
      assert.equal(typeof stored.notifiedAt, "string");
      // It is a record, not the former bare string.
      assert.equal(typeof stored, "object");
    });

    // ---- 2. resend uses the stored phone ------------------------------------

    test("2. resend sends to the stored phone", async () => {
      await seed();
      await call(notify, { periodLabel: "H1" });

      const r = await call(resend, { periodLabel: "H1" });
      assert.equal(r.status, 200);
      assert.equal(texts.length, 1);
      assert.equal(texts[0].to, ORIGINAL);
    });

    // ---- 3. THE DEFECT, as its own assertion --------------------------------
    //
    // Change the square's phone AFTER notification. The old code re-read
    // `playerPhone` here and texted CHANGED.
    test("3. editing the square's phone after notify does NOT move the destination", async () => {
      await seed();
      await call(notify, { periodLabel: "H1" });

      await db.square.updateMany({
        where: { boardId, position: 0 },
        data: { playerPhone: CHANGED },
      });

      const r = await call(resend, { periodLabel: "H1" });
      assert.equal(r.status, 200);
      assert.equal(texts.length, 1);
      assert.equal(texts[0].to, ORIGINAL, "the number notified, not the number now");
      assert.notEqual(texts[0].to, CHANGED);

      const sq = await db.square.findFirstOrThrow({ where: { boardId, position: 0 } });
      assert.equal(sq.playerPhone, CHANGED, "the square really did change");
    });

    // ---- 4. resend requires an initial notification --------------------------

    test("4. resend refuses a period that was never notified", async () => {
      await seed();
      const r = await call(resend, { periodLabel: "H1" });
      assert.equal(r.status, 400);
      assert.match(r.json.error!, /not yet notified/i);
      assert.equal(texts.length, 0);
    });

    test("4b. and refuses a DIFFERENT period from the one notified", async () => {
      await seed();
      await call(notify, { periodLabel: "H1" });
      const r = await call(resend, { periodLabel: "Final" });
      assert.equal(r.status, 400);
      assert.match(r.json.error!, /not yet notified/i);
      assert.equal(texts.length, 0);
    });

    // ---- 5. malformed stored notification fails closed -----------------------

    // THE FORMER SHAPE IS MALFORMED, not a legacy value. If this fell back to
    // reading the square it would text CHANGED — the exact behaviour removed.
    test("5. a bare-string record fails closed and sends nothing", async () => {
      await seed();
      const sq = await db.square.findFirstOrThrow({ where: { boardId, position: 0 } });
      await db.board.update({
        where: { boardId },
        data: { winnerNotifiedByPeriod: { H1: sq.squareId } },
      });
      await db.square.updateMany({
        where: { boardId, position: 0 },
        data: { playerPhone: CHANGED },
      });

      const r = await call(resend, { periodLabel: "H1" });
      assert.equal(r.status, 409);
      assert.match(r.json.error!, /unreadable/i);
      assert.equal(texts.length, 0, "no fallback to the square");
    });

    test("5b. a record missing squareId fails closed", async () => {
      await seed();
      await db.board.update({
        where: { boardId },
        data: { winnerNotifiedByPeriod: { H1: { phone: CHANGED } } },
      });
      const r = await call(resend, { periodLabel: "H1" });
      assert.equal(r.status, 409);
      assert.equal(texts.length, 0);
    });

    // A winner notified with no phone: notify sends an EMAIL and needs only an
    // email address, so this is a real state, not corruption.
    test("5c. a winner notified with no phone gets a clear refusal, not a fallback", async () => {
      await seed(null);
      const n = await call(notify, { periodLabel: "H1" });
      assert.equal(n.status, 200);
      assert.equal((await storedFor("H1") as Record<string, unknown>).phone, null);

      await db.square.updateMany({
        where: { boardId, position: 0 },
        data: { playerPhone: CHANGED },
      });

      const r = await call(resend, { periodLabel: "H1" });
      assert.equal(r.status, 400);
      assert.match(r.json.error!, /no phone number was on file/i);
      assert.equal(texts.length, 0, "the number added later is not the notified one");
    });

    // ---- 6. the winner lock still holds --------------------------------------

    test("6. a second notify cannot replace the winner", async () => {
      await seed();
      await call(notify, { periodLabel: "H1" });
      const first = await storedFor("H1");

      const again = await call(notify, { periodLabel: "H1" });
      assert.equal(again.status, 400);
      assert.match(again.json.error!, /already notified/i);
      assert.deepEqual(await storedFor("H1"), first, "the record is untouched");
      assert.equal(emails.length, 1, "and no second email went out");
    });

    // The lock survives a score change, which is what it is for.
    test("6b. changing the score after notify does not move the locked winner", async () => {
      await seed();
      await call(notify, { periodLabel: "H1" });
      const before = (await storedFor("H1")) as Record<string, unknown>;

      await db.board.update({
        where: { boardId },
        data: { scoresTeamA: [13, 20], scoresTeamB: [27, 30] },
      });

      const again = await call(notify, { periodLabel: "H1" });
      assert.equal(again.status, 400);
      const after = (await storedFor("H1")) as Record<string, unknown>;
      assert.equal(after.squareId, before.squareId);
      assert.equal(after.phone, before.phone);
    });

    // Opt-in is read LIVE, deliberately: the phone is pinned, consent is not.
    test("7. a player who opted out since being notified is not texted", async () => {
      await seed();
      await call(notify, { periodLabel: "H1" });
      await db.square.updateMany({
        where: { boardId, position: 0 },
        data: { smsOptIn: false },
      });

      const r = await call(resend, { periodLabel: "H1" });
      assert.equal(r.status, 400);
      assert.match(r.json.error!, /opt in/i);
      assert.equal(texts.length, 0);
    });
  }
);
