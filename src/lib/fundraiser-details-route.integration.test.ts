import { test, describe, before, after, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";

// The fundraiser edit route, exercised end to end against a REAL database.
//
// WHY THE ROUTE AND NOT A HELPER. What changed here is a guard — whether the
// resize runs at all, and whether totalSquares follows the rows. Both live
// inside the handler, inside its $transaction. A test of an extracted copy
// would prove the copy. This imports and calls PATCH.
//
// TWO PIECES OF SCAFFOLDING MAKE THAT POSSIBLE, both test-only:
//
//   scripts/test-alias-loader.mjs  resolves "@/..." and bare "next/server",
//                                  neither of which plain node understands
//   scripts/test-env-first.mjs     points DATABASE_URL at the test database
//                                  BEFORE src/lib/prisma.ts constructs its
//                                  singleton at module scope
//
// Only Supabase auth is faked, because createClient() calls next/headers
// cookies(), which throws outside a request scope. Everything else — Prisma,
// the transaction, the constraints — is real.
//
//   npm run test:db:up && npm run test:integration:route

const url = process.env.TEST_DATABASE_URL;
const prisma = url ? new PrismaClient({ datasources: { db: { url } } }) : null;

const SUPABASE_USER_ID = "test-user-" + randomUUID();

// Must be registered before the route module is imported, so the handler picks
// up the fake rather than the real client.
if (url) {
  mock.module("@/lib/supabase/server", {
    namedExports: {
      createClient: async () => ({
        auth: {
          getUser: async () => ({ data: { user: { id: SUPABASE_USER_ID } } }),
        },
      }),
    },
  });
}

const { PATCH } = url
  ? await import("../app/api/host/boards/[id]/fundraiser-details/route.ts")
  : { PATCH: null as never };

describe(
  "PATCH fundraiser-details (integration)",
  { skip: !url && "TEST_DATABASE_URL not set" },
  () => {
    const db = prisma!;
    let hostId: string;
    let boardId = "";
    let eventId = "";

    const PRICE = 200; // $2, matching the production test boards
    const GOAL = 20_000; // $200 -> 100 tickets

    async function call(body: Record<string, unknown>) {
      const req = new Request("http://localhost/api/host/boards/" + boardId + "/fundraiser-details", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const res = await PATCH(req, { params: Promise.resolve({ id: boardId }) });
      return { status: res.status, json: await res.json() };
    }

    /** A board matching the production shape: 100 rows, goal $200 at $2. */
    async function seedBoard(
      positions?: number[],
      goal: number = GOAL,
      handles: Record<string, string | null> = { hostZelle: "555-0100", hostVenmo: "@host" }
    ) {
      const board = await db.board.create({
        data: {
          hostId,
          gameName: "Homecoming",
          slug: "route-" + randomUUID().slice(0, 8),
          boardType: "fundraiser",
          // DERIVED FROM THE HANDLES, exactly as creation now does it.
          //
          // This was a bare ["card"] — chosen only to satisfy
          // boards_fundraiser_accepts_something, back when the column meant
          // nothing. It describes a board no host can create: card listed on a
          // host with no Stripe account, so nothing on it could ever take
          // money. Once the save rule required one OFFERABLE method, every
          // handle test on this fixture failed — correctly, against a board
          // that should not exist.
          acceptedPaymentMethods: (["zelle", "cashapp", "venmo", "paypal"] as const).filter(
            (r) =>
              handles[
                { zelle: "hostZelle", cashapp: "hostCashapp", venmo: "hostVenmo", paypal: "hostPaypal" }[r]
              ]
          ),
          squarePrice: PRICE,
          fundraisingGoalCents: goal,
          totalSquares: 100,
          timezone: "America/New_York",
          campaignEndsAt: new Date(Date.now() + 7 * 864e5),
          ...handles,
        },
      });
      // THE OWNER GRANT. Since the authorization switch, `Board.hostId` is
      // the record of who created a board and NOT the answer to "may they
      // act" — that is the collaborator row. Board creation writes one in the
      // same transaction, so a board without it is a board no host can
      // create, and a fixture lacking it tests a state that cannot exist.
      await db.boardCollaborator.create({
        data: {
          boardId: board.boardId,
          hostId,
          role: "OWNER",
          status: "active",
          acceptedAt: new Date(),
        },
      });
      boardId = board.boardId;
      const event = await db.event.create({
        data: {
          boardId,
          name: "Tailgate",
          venue: "Lot C",
          startsAt: new Date(Date.now() + 14 * 864e5),
          timezone: "America/New_York",
        },
      });
      eventId = event.id;
      const pos = positions ?? Array.from({ length: 100 }, (_, i) => i);
      await db.square.createMany({
        data: pos.map((position) => ({
          boardId,
          position,
          paymentStatus: "open" as const,
        })),
      });
    }

    /** Surfaces the server's message on an unexpected non-200. */
    function status200(r: { status: number; json: { error?: string } }) {
      if (r.status !== 200) throw new Error("expected 200, got " + r.status + ": " + r.json.error);
      return r.status;
    }

    const rowCount = () => db.square.count({ where: { boardId } });
    const storedTotal = async () =>
      (await db.board.findUniqueOrThrow({
        where: { boardId },
        select: { totalSquares: true },
      })).totalSquares;
    const idSet = async () =>
      new Set(
        (await db.square.findMany({ where: { boardId }, select: { squareId: true } }))
          .map((s) => s.squareId)
      );

    before(async () => {
      const host = await db.host.create({
        data: { email: "route-" + randomUUID() + "@example.com", supabaseUserId: SUPABASE_USER_ID },
      });
      hostId = host.id;
    });

    beforeEach(async () => {
      if (!boardId) return;
      await db.square.deleteMany({ where: { boardId } });
      // Contributions were never cleaned here because no test made one - the
      // lock tests use a paid SQUARE. The FK is Restrict, so the board delete
      // below fails and the failure surfaces in the NEXT test's beforeEach,
      // not in the test that left the row.
      await db.contribution.deleteMany({ where: { boardId } });
      await db.event.deleteMany({ where: { boardId } });
      // Collaborator rows hold a Restrict reference to the board, so they
      // go first — otherwise the board delete fails and the failure
      // surfaces in the NEXT test's beforeEach rather than here.
      await db.boardCollaborator.deleteMany({ where: { boardId } });
      await db.board.deleteMany({ where: { boardId } });
      boardId = "";
    });

    after(async () => {
      if (boardId) {
        await db.square.deleteMany({ where: { boardId } });
        await db.event.deleteMany({ where: { boardId } });
      // Collaborator rows hold a Restrict reference to the board, so they
      // go first — otherwise the board delete fails and the failure
      // surfaces in the NEXT test's beforeEach rather than here.
      await db.boardCollaborator.deleteMany({ where: { boardId } });
      await db.board.deleteMany({ where: { boardId } });
      }
      if (hostId) await db.host.deleteMany({ where: { id: hostId } });
      await db.$disconnect();
    });

    // THE REPRODUCTION, exactly as reported against production: the second
    // Homecoming board, zero paid squares, goal $200 at $2, 100 rows. Raising
    // the goal to $300 used to produce 150 rows with totalSquares still 100.
    test("goal $200 -> $300 grows to 150 rows AND totalSquares follows", async () => {
      await seedBoard();
      assert.equal(await rowCount(), 100);
      assert.equal(await storedTotal(), 100);

      const { status } = await call({ fundraisingGoalCents: 30_000 });
      assert.equal(status, 200);

      assert.equal(await rowCount(), 150);
      assert.equal(await storedTotal(), 150, "the column that three screens read");
    });

    // RAFFLE OFF: THE SAME EDIT MUST MOVE NOTHING.
    //
    // `inventoryLocked` is false whenever no square has been PAID for, which on
    // a board that sells no squares is true for its entire life. Without the
    // raffleEnabled clause in the route this is the edit that silently
    // materialises a grid on a board whose contributors are never shown one.
    //
    // The goal still SAVES. It just stops driving inventory.
    test("raffle off: a goal change saves and resizes nothing", async () => {
      await seedBoard();
      await db.board.update({ where: { boardId }, data: { raffleEnabled: false } });
      const before = await rowCount();
      assert.equal(before, 100, "the board still holds its pre-existing rows");

      const { status } = await call({ fundraisingGoalCents: 30_000 });
      assert.equal(status, 200);

      assert.equal(await rowCount(), before, "no row was created or deleted");
      assert.equal(await storedTotal(), 100, "totalSquares did not move either");

      const saved = await db.board.findUnique({
        where: { boardId },
        select: { fundraisingGoalCents: true },
      });
      assert.equal(saved!.fundraisingGoalCents, 30_000, "the goal itself still saved");
    });

    // A board that never had squares must not GROW them, which is the shape a
    // raffle-off board created through the new flow will actually have.
    test("raffle off with zero rows: a goal change creates none", async () => {
      await seedBoard([]);
      await db.board.update({ where: { boardId }, data: { raffleEnabled: false } });
      assert.equal(await rowCount(), 0);

      const { status } = await call({ fundraisingGoalCents: 50_000 });
      assert.equal(status, 200);
      assert.equal(await rowCount(), 0, "still no grid");
    });

    test("goal $200 -> $100 shrinks to 50 rows AND totalSquares follows", async () => {
      await seedBoard();
      const { status } = await call({ fundraisingGoalCents: 10_000 });
      assert.equal(status, 200);
      assert.equal(await rowCount(), 50);
      assert.equal(await storedTotal(), 50);
    });

    // A venue typo is the ordinary reason to open this dialog, and the form
    // always sends the goal alongside it. That used to run the resize.
    test("a venue-only save creates and deletes NOTHING", async () => {
      await seedBoard();
      const before = await idSet();

      const { status } = await call({
        name: "Tailgate",
        venue: "Armstrong Stadium lot D",
        fundraisingGoalCents: GOAL, // unchanged, exactly as the form sends it
      });
      assert.equal(status, 200);

      const after = await idSet();
      assert.equal(after.size, 100);
      assert.deepEqual([...after].sort(), [...before].sort(), "not one row touched");
      assert.equal(await storedTotal(), 100);

      const ev = await db.event.findUniqueOrThrow({ where: { id: eventId } });
      assert.equal(ev.venue, "Armstrong Stadium lot D", "the edit still saved");
    });

    // THE DISCRIMINATING CASE for the second half of the fix.
    //
    // The test above passes on the OLD code too: recomputing 100 from an
    // unchanged $200 at $2 produces 100, so nothing moves and nothing is
    // observable. It only looks like a proof.
    //
    // This board is the shape that exposes it, and production has one — goal
    // $300 at $2 derives 150 while the board holds 100 rows, because it was
    // created before inventory was derived. On the old code, correcting the
    // venue silently created FIFTY tickets. The goal is unchanged; the resize
    // must not run.
    test("a venue-only save does not resize a board whose rows already differ", async () => {
      await seedBoard(undefined, 30_000); // $300 at $2 derives 150; 100 rows exist
      const before = await idSet();

      const { status } = await call({
        venue: "Armstrong Stadium lot D",
        fundraisingGoalCents: 30_000, // unchanged, exactly as the form sends it
      });
      assert.equal(status, 200);

      assert.equal(await rowCount(), 100, "fifty tickets were NOT invented");
      assert.deepEqual([...(await idSet())].sort(), [...before].sort());
      assert.equal(await storedTotal(), 100);
    });

    // Cents, not strings. Re-sending the same goal as a float must not count.
    test("re-sending the identical goal does not resize", async () => {
      await seedBoard();
      const before = await idSet();
      const { status } = await call({ fundraisingGoalCents: GOAL });
      assert.equal(status, 200);
      assert.deepEqual([...(await idSet())].sort(), [...before].sort());
    });

    test("a price change alone resizes and updates totalSquares", async () => {
      await seedBoard();
      const { status } = await call({ squarePrice: 400 }); // $4 -> 50 tickets
      assert.equal(status, 200);
      assert.equal(await rowCount(), 50);
      assert.equal(await storedTotal(), 50);
      const b = await db.board.findUniqueOrThrow({ where: { boardId } });
      assert.equal(b.squarePrice, 400);
    });

    // SAME TRANSACTION, proven by making the resize fail at the database.
    //
    // The board has 100 rows but a gap: positions 0..98 and 120. Growing to
    // 150 tries to insert positions 100..149, and 120 already exists, so the
    // unique index on (board_id, position) rejects the batch. If the goal
    // write, the row writes and the totalSquares write were not one
    // transaction, at least one of them would survive the rollback.
    test("a failed resize rolls back the goal AND totalSquares", async () => {
      const positions = [...Array.from({ length: 99 }, (_, i) => i), 120];
      await seedBoard(positions);
      assert.equal(await rowCount(), 100);

      const { status } = await call({ fundraisingGoalCents: 30_000 });
      assert.equal(status, 500, "the constraint violation surfaced");

      const b = await db.board.findUniqueOrThrow({ where: { boardId } });
      assert.equal(b.fundraisingGoalCents, GOAL, "goal did not survive the rollback");
      assert.equal(b.totalSquares, 100, "totalSquares did not survive the rollback");
      assert.equal(await rowCount(), 100, "no rows survived the rollback");
    });

    // Invariant 16. A confirmed square shuts the gate; the goal still saves.
    test("after a confirmed square the goal saves but nothing resizes", async () => {
      await seedBoard();
      const first = await db.square.findFirstOrThrow({ where: { boardId } });
      await db.square.update({
        where: { squareId: first.squareId },
        data: { paymentStatus: "paid", pricePaidCents: PRICE, batchId: randomUUID() },
      });

      const { status } = await call({ fundraisingGoalCents: 30_000 });
      assert.equal(status, 200);

      const b = await db.board.findUniqueOrThrow({ where: { boardId } });
      assert.equal(b.fundraisingGoalCents, 30_000, "aspirational, never locked");
      assert.equal(await rowCount(), 100);
      assert.equal(b.totalSquares, 100);
    });

    // ---- direct-payment handles ------------------------------------------
    //
    // Immutable until now because nothing wrote them, not because anything
    // protected them. A mistyped Cash App tag sends real money to a stranger.

    const handles = async () =>
      await db.board.findUniqueOrThrow({
        where: { boardId },
        select: { hostVenmo: true, hostZelle: true, hostCashapp: true, hostPaypal: true },
      });

    test("each handle edits independently", async () => {
      await seedBoard();
      assert.equal(status200(await call({ hostVenmo: "@corrected" })), 200);
      let h = await handles();
      assert.equal(h.hostVenmo, "@corrected");
      assert.equal(h.hostZelle, "555-0100", "the others are untouched");

      assert.equal(status200(await call({ hostZelle: "host@example.com" })), 200);
      h = await handles();
      assert.equal(h.hostZelle, "host@example.com");
      assert.equal(h.hostVenmo, "@corrected");

      assert.equal(status200(await call({ hostCashapp: "$daali" })), 200);
      assert.equal((await handles()).hostCashapp, "$daali");

      assert.equal(status200(await call({ hostPaypal: "paypal.me/daali" })), 200);
      assert.equal((await handles()).hostPaypal, "paypal.me/daali");
    });

    // Trimmed, and empty means absent - the same normalisation as creation.
    test("whitespace is trimmed and an empty string clears the field", async () => {
      await seedBoard();
      await call({ hostVenmo: "  @spaced  " });
      assert.equal((await handles()).hostVenmo, "@spaced");
      await call({ hostVenmo: "   " });
      assert.equal((await handles()).hostVenmo, null);
    });

    test("clearing one handle while another remains succeeds", async () => {
      await seedBoard();
      const { status } = await call({ hostVenmo: null });
      assert.equal(status, 200);
      const h = await handles();
      assert.equal(h.hostVenmo, null, "the host stopped using Venmo");
      assert.equal(h.hostZelle, "555-0100", "and can still be paid");
    });

    // Creation refuses a board with no handle. An edit must not be able to
    // produce the state creation refuses to create.
    test("clearing the LAST handle is refused and writes nothing", async () => {
      await seedBoard(undefined, GOAL, { hostZelle: "555-0100" });
      const { status, json } = await call({ hostZelle: null });
      assert.equal(status, 400);
      assert.match(json.error, /at least one way to receive payment/);
      assert.equal((await handles()).hostZelle, "555-0100", "unchanged");
    });

    test("clearing all four at once is refused", async () => {
      await seedBoard();
      const { status, json } = await call({
        hostVenmo: null, hostZelle: null, hostCashapp: null, hostPaypal: null,
      });
      assert.equal(status, 400);
      assert.match(json.error, /at least one way to receive payment/);
      const h = await handles();
      assert.equal(h.hostZelle, "555-0100");
      assert.equal(h.hostVenmo, "@host");
    });

    // THE POINT OF THE WHOLE CHANGE. A wrong handle is most urgent while money
    // is moving, so there is no lock and no gate on contribution state.
    test("handles edit with confirmed contributions present", async () => {
      await seedBoard();
      const first = await db.square.findFirstOrThrow({ where: { boardId } });
      await db.square.update({
        where: { squareId: first.squareId },
        data: { paymentStatus: "paid", pricePaidCents: PRICE, batchId: randomUUID() },
      });
      // Everything else on this board is now locked. Handles are not.
      const { status } = await call({ hostZelle: "corrected@example.com" });
      assert.equal(status, 200);
      assert.equal((await handles()).hostZelle, "corrected@example.com");
    });

    test("handles edit after the campaign has closed", async () => {
      await seedBoard();
      await db.board.update({ where: { boardId }, data: { status: "closed" } });
      const { status } = await call({ hostCashapp: "$late-fix" });
      assert.equal(status, 200);
      assert.equal((await handles()).hostCashapp, "$late-fix");
    });

    // A save that never mentions handles must leave all four alone.
    test("a save omitting handles leaves all four untouched", async () => {
      await seedBoard();
      const before = await handles();
      const { status } = await call({ venue: "Lot D" });
      assert.equal(status, 200);
      assert.deepEqual(await handles(), before);
    });

    // ---- cause description -------------------------------------------------
    //
    // v2 §11 lists the description as always editable. Until this change
    // nothing could edit it: set at creation, reachable by no route.
    test("causeDescription saves, and an empty value clears it", async () => {
      await seedBoard();
      assert.equal(status200(await call({ causeDescription: "  Band uniforms  " })), 200);
      let b = await db.board.findUniqueOrThrow({ where: { boardId } });
      assert.equal(b.causeDescription, "Band uniforms", "trimmed");

      assert.equal(status200(await call({ causeDescription: "" })), 200);
      b = await db.board.findUniqueOrThrow({ where: { boardId } });
      assert.equal(b.causeDescription, null);
    });

    // THE TRAP THIS ROUTE CARRIES. `name` here is the EVENT name. The campaign
    // title is Board.gameName and belongs to /details, which is the only route
    // that appends to titleHistory. If the consolidated edit panel ever sent
    // the title here it would rename the event and skip the audit record, so
    // this asserts the two stay separate.
    test("`name` writes the EVENT name and never the campaign title", async () => {
      await seedBoard();
      const before = await db.board.findUniqueOrThrow({ where: { boardId } });
      assert.equal(status200(await call({ name: "Tailgate 2026" })), 200);

      const ev = await db.event.findUniqueOrThrow({ where: { id: eventId } });
      assert.equal(ev.name, "Tailgate 2026");
      const after = await db.board.findUniqueOrThrow({ where: { boardId } });
      assert.equal(after.gameName, before.gameName, "the campaign title is untouched");
      assert.equal(after.titleHistory, null, "and no audit record was written here");
    });

    // The 1,000 cap is reached by the resize path too, and is refused rather
    // than silently clamped — but only when a resize is actually on the table.
    test("a goal that would exceed 1,000 tickets is refused", async () => {
      await seedBoard();
      const { status, json } = await call({ fundraisingGoalCents: 100_000_00 });
      assert.equal(status, 400);
      assert.match(json.error, /1,000 tickets/);
      assert.equal(await rowCount(), 100, "nothing was written");
    });

    // ====================================================================
    // ACCEPTED PAYMENT METHODS — through the real route, real transaction.
    //
    // Before this, `acceptedPaymentMethods` was written in exactly one place:
    // board creation, deriving `card` from `host.stripeChargesEnabled`. Because
    // that is a HOST-level flag, connecting Stripe once turned card on for
    // every fundraiser that host would ever run, and nothing anywhere could
    // turn it off — which is how a no-prize direct-payment board came to serve
    // a live Stripe checkout for $80.
    //
    // THE SAVE RULE: at least one method must be OFFERABLE afterwards, not
    // merely selected. The two cases it separates are the first two tests.
    // ====================================================================

    /** Read back exactly what the column holds. */
    const methodsNow = async () =>
      (await db.board.findUniqueOrThrow({
        where: { boardId },
        select: { acceptedPaymentMethods: true },
      })).acceptedPaymentMethods;

    const handlesNow = async () =>
      db.board.findUniqueOrThrow({
        where: { boardId },
        select: { hostZelle: true, hostVenmo: true, hostCashapp: true, hostPaypal: true },
      });

    // THE PERMITTED CASE. Ticking a rail before its handle exists is a real
    // flow — "I'll paste my Venmo username when I find it."
    test("Zelle offerable, Venmo ticked with no handle: saves", async () => {
      await seedBoard(undefined, GOAL, { hostZelle: "555-0100", hostVenmo: null });
      const r = await call({
        acceptedPaymentMethods: ["zelle", "venmo"],
        hostZelle: "555-0100",
        hostVenmo: null,
      });
      status200(r);
      assert.deepEqual(await methodsNow(), ["zelle", "venmo"], "both stored");
      assert.equal((await handlesNow()).hostVenmo, null, "Venmo simply is not live yet");
    });

    // THE REFUSED CASE. Every method selected is unusable, so the board could
    // take no money at all.
    test("only Venmo ticked with no handle: refused, and nothing is written", async () => {
      await seedBoard(undefined, GOAL, { hostZelle: "555-0100", hostVenmo: null });
      const before = await methodsNow();

      // THE HANDLES ARE LEFT ALONE, deliberately. Clearing them too would trip
      // the older "add at least one way to receive payment" guard first, and
      // this test would pass while proving nothing about the methods rule. The
      // Zelle handle stays stored and simply is not selected - which is exactly
      // the state the rule has to catch: handles on file, none of them ticked.
      const r = await call({ acceptedPaymentMethods: ["venmo"] });
      assert.equal(r.status, 400);
      assert.match(r.json.error!, /at least one payment method/i);
      assert.deepEqual(await methodsNow(), before, "the column did not move");
      assert.equal((await handlesNow()).hostZelle, "555-0100", "nor did the handle");
    });

    // ONE TRANSACTION. A host pasting a handle and ticking its rail in the same
    // save must never get one without the other — and the rule is checked
    // against the handles AS THEY WILL BE, not as they are.
    test("a handle and its rail land together in one save", async () => {
      await seedBoard(undefined, GOAL, { hostZelle: "555-0100", hostVenmo: null });
      status200(
        await call({
          acceptedPaymentMethods: ["zelle", "venmo"],
          hostZelle: "555-0100",
          hostVenmo: "@newhandle",
        })
      );
      assert.deepEqual(await methodsNow(), ["zelle", "venmo"]);
      assert.equal((await handlesNow()).hostVenmo, "@newhandle");
    });

    // The rule reads the POST-save handles. Ticking only Venmo is fine when the
    // same request supplies the handle that makes it offerable.
    test("ticking only Venmo saves when the same request supplies its handle", async () => {
      await seedBoard(undefined, GOAL, { hostZelle: "555-0100", hostVenmo: null });
      status200(
        await call({
          acceptedPaymentMethods: ["venmo"],
          hostZelle: null,
          hostVenmo: "@newhandle",
        })
      );
      assert.deepEqual(await methodsNow(), ["venmo"]);
    });

    test("an empty selection is refused", async () => {
      await seedBoard();
      const r = await call({ acceptedPaymentMethods: [] });
      assert.equal(r.status, 400);
      assert.match(r.json.error!, /at least one payment method/i);
    });

    test("an unknown method is refused before anything is written", async () => {
      await seedBoard();
      const before = await methodsNow();
      const r = await call({ acceptedPaymentMethods: ["zelle", "bitcoin"] });
      assert.equal(r.status, 400);
      assert.match(r.json.error!, /Unrecognized payment method/i);
      assert.deepEqual(await methodsNow(), before);
    });

    test("the stored order is stable regardless of how it was sent", async () => {
      await seedBoard(undefined, GOAL, { hostZelle: "555-0100", hostCashapp: "$h" });
      status200(await call({ acceptedPaymentMethods: ["cashapp", "zelle"] }));
      assert.deepEqual(await methodsNow(), ["zelle", "cashapp"]);
    });

    // CARD IS AN EXPLICIT CHOICE NOW. This board's host has no Stripe account
    // in the test database, so card can never be offerable here — and a save
    // that leaves card as the only selection has to fail.
    test("card alone with no Stripe account is refused", async () => {
      await seedBoard();
      const r = await call({ acceptedPaymentMethods: ["card"] });
      assert.equal(r.status, 400);
      assert.match(r.json.error!, /at least one payment method/i);
    });

    // NOT LOCKED AFTER CONTRIBUTIONS BEGIN. Invariant 16 locks the terms of the
    // deal — what a contributor buys and for how much. How the host receives
    // money is not a term, and a frozen Zelle account mid-campaign is exactly
    // the correction this has to allow.
    test("methods stay editable after a confirmed contribution", async () => {
      await seedBoard(undefined, GOAL, { hostZelle: "555-0100", hostCashapp: "$h" });
      await db.contribution.create({
        data: {
          boardId,
          status: "confirmed",
          paymentMethod: "cash",
          squareAmountCents: 5000,
          donationAmountCents: 0,
          totalPaidCents: 5000,
          contributorName: "Payer",
          contributorEmail: "payer@example.com",
          confirmedAt: new Date(),
        },
      });

      status200(await call({ acceptedPaymentMethods: ["cashapp"] }));
      assert.deepEqual(await methodsNow(), ["cashapp"], "switched rails mid-campaign");
    });

    test("handles stay editable after a confirmed contribution, as before", async () => {
      await seedBoard(undefined, GOAL, { hostZelle: "555-0100", hostCashapp: "$h" });
      await db.contribution.create({
        data: {
          boardId, status: "confirmed", paymentMethod: "cash",
          squareAmountCents: 5000, donationAmountCents: 0, totalPaidCents: 5000,
          contributorName: "Payer", contributorEmail: "payer@example.com",
          confirmedAt: new Date(),
        },
      });
      status200(await call({ acceptedPaymentMethods: ["zelle"], hostZelle: "555-0199" }));
      assert.equal((await handlesNow()).hostZelle, "555-0199");
    });

    // A save that says nothing about payment methods must not touch them. Most
    // edits — a goal, a cause, an event name — are exactly that.
    test("a save that omits the field leaves the column alone", async () => {
      await seedBoard(undefined, GOAL, { hostZelle: "555-0100" });
      const before = await methodsNow();
      status200(await call({ causeDescription: "New cause" }));
      assert.deepEqual(await methodsNow(), before);
    });

    // xv8yuwhd's stopgap value must survive an ordinary edit untouched. It was
    // set by hand and is the live board's intended state.
    test("an unrelated edit preserves a hand-set selection", async () => {
      await seedBoard(undefined, GOAL, { hostZelle: "555-0100", hostCashapp: "$h" });
      status200(await call({ acceptedPaymentMethods: ["zelle", "cashapp"] }));
      status200(await call({ fundraisingGoalCents: 30_000 }));
      assert.deepEqual(await methodsNow(), ["zelle", "cashapp"]);
    });

    // Clearing the last handle while its rail is the only selection is the same
    // failure as never having one, and is caught by the same rule.
    test("clearing the last usable handle is refused", async () => {
      await seedBoard(undefined, GOAL, { hostZelle: "555-0100", hostVenmo: null });
      status200(await call({ acceptedPaymentMethods: ["zelle"] }));
      const r = await call({ hostZelle: null, hostVenmo: null, hostCashapp: null, hostPaypal: null });
      assert.equal(r.status, 400);
      assert.equal((await handlesNow()).hostZelle, "555-0100", "unchanged");
    });

  }
);
