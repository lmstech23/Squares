import { test, describe, before, after, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";

// PATCH /api/host/boards/[id]/details, against a REAL database.
//
// Two things are under test and neither can be checked without the row:
//
//   - a fundraiser saves `{ gameName }` alone, and does NOT overwrite its null
//     team columns
//   - titleHistory (JSONB, previously written by nothing and read by nothing)
//     appends after the first confirmed contribution, and appends AGAIN rather
//     than overwriting -- v2 §11
//
// Scaffolding as in fundraiser-details-route.integration.test.ts. Only Supabase
// auth is faked; CURRENT_USER is mutable so ownership can be tested by
// switching identity rather than by trusting the route's own query.
//
//   npm run test:db:up && npm run test:integration:details

const url = process.env.TEST_DATABASE_URL;
const prisma = url ? new PrismaClient({ datasources: { db: { url } } }) : null;

const OWNER_UID = "owner-" + randomUUID();
const STRANGER_UID = "stranger-" + randomUUID();
let CURRENT_USER = OWNER_UID;

if (url) {
  mock.module("@/lib/supabase/server", {
    namedExports: {
      createClient: async () => ({
        auth: { getUser: async () => ({ data: { user: { id: CURRENT_USER } } }) },
      }),
    },
  });
}

const { PATCH } = url
  ? await import("../app/api/host/boards/[id]/details/route.ts")
  : { PATCH: null as never };

describe(
  "PATCH details (integration)",
  { skip: !url && "TEST_DATABASE_URL not set" },
  () => {
    const db = prisma!;
    let ownerId: string;
    let strangerId: string;
    let boardId = "";

    async function call(body: Record<string, unknown>, id: string = boardId) {
      const req = new Request("http://localhost/api/host/boards/" + id + "/details", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const res = await PATCH(req, { params: Promise.resolve({ id }) });
      return { status: res.status, json: await res.json() };
    }

    async function seed(boardType: "fundraiser" | "game") {
      const board = await db.board.create({
        data: {
          hostId: ownerId,
          gameName: boardType === "fundraiser" ? "QT'13 Homecoming 2026" : "Week 4",
          slug: "det-" + randomUUID().slice(0, 8),
          boardType,
          squarePrice: 5000,
          totalSquares: 4,
          timezone: "America/New_York",
          ...(boardType === "fundraiser"
            ? { campaignEndsAt: new Date(Date.now() + 7 * 864e5) }
            : { teamCol: "Hampton", teamRow: "Howard" }),
        },
      });
      boardId = board.boardId;
      await db.square.createMany({
        data: Array.from({ length: 4 }, (_, i) => ({
          boardId,
          position: i,
          paymentStatus: "open" as const,
        })),
      });
    }

    /** One confirmed square -- the trigger for the title-history rule. */
    async function confirmOne() {
      const sq = await db.square.findFirstOrThrow({ where: { boardId } });
      await db.square.update({
        where: { squareId: sq.squareId },
        data: { paymentStatus: "paid", pricePaidCents: 5000, batchId: randomUUID() },
      });
    }

    const row = () =>
      db.board.findUniqueOrThrow({
        where: { boardId },
        select: { gameName: true, teamCol: true, teamRow: true, titleHistory: true },
      });

    before(async () => {
      const a = await db.host.create({
        data: { email: "owner-" + randomUUID() + "@example.com", supabaseUserId: OWNER_UID },
      });
      const b = await db.host.create({
        data: { email: "str-" + randomUUID() + "@example.com", supabaseUserId: STRANGER_UID },
      });
      ownerId = a.id;
      strangerId = b.id;
    });

    beforeEach(async () => {
      CURRENT_USER = OWNER_UID;
      if (!boardId) return;
      await db.square.deleteMany({ where: { boardId } });
      await db.board.deleteMany({ where: { boardId } });
      boardId = "";
    });

    after(async () => {
      if (boardId) {
        await db.square.deleteMany({ where: { boardId } });
        await db.board.deleteMany({ where: { boardId } });
      }
      await db.host.deleteMany({ where: { id: { in: [ownerId, strangerId] } } });
      await db.$disconnect();
    });

    // ---- the bug -----------------------------------------------------------
    //
    // The dialog sent `{ gameName }` alone and the route demanded all three.
    // Save enabled and then failed; before that it never enabled at all.

    test("a fundraiser saves the title alone", async () => {
      await seed("fundraiser");
      const { status } = await call({ gameName: "QT'13 Homecoming 2026 Fundraiser" });
      assert.equal(status, 200);
      assert.equal((await row()).gameName, "QT'13 Homecoming 2026 Fundraiser");
    });

    test("a fundraiser title save leaves the team columns NULL", async () => {
      await seed("fundraiser");
      await call({ gameName: "Renamed" });
      const r = await row();
      assert.equal(r.teamCol, null, "not overwritten with an empty string");
      assert.equal(r.teamRow, null);
    });

    test("an empty fundraiser title is refused", async () => {
      await seed("fundraiser");
      const { status } = await call({ gameName: "   " });
      assert.equal(status, 400);
      assert.equal((await row()).gameName, "QT'13 Homecoming 2026");
    });

    // ---- title history, v2 §11 ---------------------------------------------

    test("no confirmed contribution: the title saves and titleHistory stays NULL", async () => {
      await seed("fundraiser");
      const { status } = await call({ gameName: "Early Correction" });
      assert.equal(status, 200);
      const r = await row();
      assert.equal(r.gameName, "Early Correction");
      assert.equal(r.titleHistory, null, "nobody had relied on the old title");
    });

    test("after a confirmed contribution: one entry, with the previous title", async () => {
      await seed("fundraiser");
      await confirmOne();
      const { status } = await call({ gameName: "QT'13 Homecoming 2026 Fundraiser" });
      assert.equal(status, 200);

      const r = await row();
      assert.equal(r.gameName, "QT'13 Homecoming 2026 Fundraiser");
      const hist = r.titleHistory as Array<{ from: string; to: string; at: string }>;
      assert.ok(Array.isArray(hist));
      assert.equal(hist.length, 1);
      assert.equal(hist[0].from, "QT'13 Homecoming 2026");
      assert.equal(hist[0].to, "QT'13 Homecoming 2026 Fundraiser");
      assert.ok(!Number.isNaN(Date.parse(hist[0].at)), "a real timestamp");
    });

    // APPENDS, never overwrites. This is the assertion that a read-modify-write
    // in JavaScript would eventually fail; the route appends in one statement.
    test("a second change appends rather than overwriting", async () => {
      await seed("fundraiser");
      await confirmOne();
      await call({ gameName: "Second" });
      await call({ gameName: "Third" });

      const hist = (await row()).titleHistory as Array<{ from: string; to: string }>;
      assert.equal(hist.length, 2);
      assert.deepEqual(
        hist.map((h) => [h.from, h.to]),
        [
          ["QT'13 Homecoming 2026", "Second"],
          ["Second", "Third"],
        ],
        "in order, each carrying what the title was"
      );
    });

    test("re-saving the SAME title writes no history entry", async () => {
      await seed("fundraiser");
      await confirmOne();
      const { status } = await call({ gameName: "QT'13 Homecoming 2026" });
      assert.equal(status, 200);
      assert.equal((await row()).titleHistory, null, "nothing changed, so nothing to record");
    });

    // ---- Game Day regression ------------------------------------------------

    test("Game Day still requires all three fields", async () => {
      await seed("game");
      const { status, json } = await call({ gameName: "Week 5" });
      assert.equal(status, 400);
      assert.match(json.error, /gameName, teamCol, and teamRow are all required/);
      assert.equal((await row()).gameName, "Week 4", "nothing written");
    });

    test("Game Day still rejects an empty team name", async () => {
      await seed("game");
      const { status } = await call({ gameName: "Week 5", teamCol: "", teamRow: "Howard" });
      assert.equal(status, 400);
    });

    test("Game Day saves all three, and writes NO title history", async () => {
      await seed("game");
      await confirmOne(); // even with money in, Game Day is unchanged -- v2 §11
      const { status } = await call({
        gameName: "Week 5",
        teamCol: "Hampton Pirates",
        teamRow: "Howard Bison",
      });
      assert.equal(status, 200);
      const r = await row();
      assert.equal(r.gameName, "Week 5");
      assert.equal(r.teamCol, "Hampton Pirates");
      assert.equal(r.teamRow, "Howard Bison");
      assert.equal(r.titleHistory, null, "v2 §11 narrows fundraiser behaviour only");
    });

    // ---- ownership ----------------------------------------------------------
    //
    // NOTE: this route answers 404, not 403. It does not distinguish "not
    // yours" from "does not exist", which is the stricter behaviour -- it does
    // not confirm the board id is real to someone who does not own it.
    test("another host cannot edit this board", async () => {
      await seed("fundraiser");
      CURRENT_USER = STRANGER_UID;
      const { status } = await call({ gameName: "Hijacked" });
      assert.equal(status, 404);
      assert.equal((await row()).gameName, "QT'13 Homecoming 2026");
    });
  }
);
