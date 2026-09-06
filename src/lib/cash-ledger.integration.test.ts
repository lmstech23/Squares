import { test, describe, before, after, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";

// Cash confirmation and the ledger, against a REAL database, through the route.
//
// THE DEFECT. confirm-cash wrote a ledger row only when the square carried no
// contributionId:
//
//     if (sq && !sq.contributionId) { ...create... }
//
// A non-null pointer does not mean "already recorded"; it means a row was once
// associated with this square. Two live paths leave a stale one behind, and on
// both the host confirmed real money, the square went `paid`, and nothing
// entered the ledger. Now that `raised` reads the ledger, that under-reports
// money a host actually collected.
//
// THE RECONCILIATION PROPERTY IS THE POINT OF THIS FILE. Every sequence ends
// with the same assertion:
//
//     SUM(pricePaidCents WHERE paid) === SUM(squareAmountCents WHERE confirmed
//                                            AND voidedAt IS NULL)
//
// That equality is what actually failed in production, and it is what catches
// the next variant of this rather than the two shapes already known.
//
//   npm run test:db:up && npm run test:integration:cash

const url = process.env.TEST_DATABASE_URL;
const prisma = url ? new PrismaClient({ datasources: { db: { url } } }) : null;

const HOST_UID = "cash-host-" + randomUUID();

if (url) {
  mock.module("@/lib/auth", {
    namedExports: {
      getHost: async () => (prisma ? currentHost : null),
    },
  });
}

let currentHost: { id: string } | null = null;

const { POST } = url
  ? await import("../app/api/host/boards/[id]/confirm-cash/route.ts")
  : { POST: null as never };

describe(
  "confirm-cash ledger (integration)",
  { skip: !url && "TEST_DATABASE_URL not set" },
  () => {
    const db = prisma!;
    let hostId: string;
    let otherBoardId = "";
    let boardId = "";

    const PRICE = 5000;

    async function confirmCash(squareId: string, id: string = boardId) {
      const req = new Request("http://localhost/api/host/boards/" + id + "/confirm-cash", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ squareId }),
      });
      const res = await POST(req, { params: Promise.resolve({ id }) });
      return { status: res.status, json: await res.json() };
    }

    async function seedBoard(): Promise<string> {
      const board = await db.board.create({
        data: {
          hostId,
          gameName: "Cash Ledger",
          slug: "cash-" + randomUUID().slice(0, 8),
          boardType: "fundraiser",
          squarePrice: PRICE,
          totalSquares: 6,
          timezone: "America/New_York",
          campaignEndsAt: new Date(Date.now() + 7 * 864e5),
          cashModeEnabled: true,
        },
      });
      await db.square.createMany({
        data: Array.from({ length: 6 }, (_, i) => ({
          boardId: board.boardId,
          position: i,
          paymentStatus: "open" as const,
        })),
      });
      return board.boardId;
    }

    /** `count` squares reserved for cash, as cash-reserve leaves them. */
    async function reserve(count: number, board: string = boardId) {
      const open = await db.square.findMany({
        where: { boardId: board, paymentStatus: "open" },
        orderBy: { position: "asc" },
        take: count,
      });
      const batchId = randomUUID();
      await db.square.updateMany({
        where: { squareId: { in: open.map((s) => s.squareId) } },
        data: {
          paymentStatus: "reserved_cash",
          paymentMethod: "cash",
          playerName: "Contributor",
          playerEmail: "c@example.com",
          pricePaidCents: PRICE,
          batchId,
          claimedAt: new Date(),
        },
      });
      return open.map((s) => s.squareId);
    }

    /** Point squares at a ledger row, the way a card checkout would have. */
    async function link(
      squareIds: string[],
      status: string,
      opts: { method?: "stripe" | "cash"; cents?: number; voided?: boolean; board?: string } = {}
    ) {
      const cents = opts.cents ?? PRICE * squareIds.length;
      const c = await db.contribution.create({
        data: {
          boardId: opts.board ?? boardId,
          status: status as never,
          paymentMethod: opts.method ?? "stripe",
          squareAmountCents: cents,
          donationAmountCents: 0,
          totalPaidCents: cents,
          contributorName: "Contributor",
          contributorEmail: "c@example.com",
          checkoutSessionId:
            (opts.method ?? "stripe") === "stripe"
              ? "cs_" + randomUUID().replace(/-/g, "")
              : null,
          confirmedAt: status === "confirmed" ? new Date() : null,
          releasedAt: status === "released" ? new Date() : null,
          voidedAt: opts.voided ? new Date() : null,
        },
      });
      await db.square.updateMany({
        where: { squareId: { in: squareIds } },
        data: { contributionId: c.id },
      });
      return c.id;
    }

    /**
     * THE REQUIRED PROPERTY. Confirmed square money and confirmed ledger money
     * are the same money, so the two sums must be equal after any sequence.
     */
    async function assertReconciled(board: string = boardId) {
      const squares = await db.square.aggregate({
        where: { boardId: board, paymentStatus: "paid" },
        _sum: { pricePaidCents: true },
      });
      const ledger = await db.contribution.aggregate({
        where: { boardId: board, status: "confirmed", voidedAt: null },
        _sum: { squareAmountCents: true },
      });
      assert.equal(
        ledger._sum.squareAmountCents ?? 0,
        squares._sum.pricePaidCents ?? 0,
        "ledger square money does not reconcile with paid squares"
      );
    }

    const statusOf = (squareId: string) =>
      db.square
        .findUniqueOrThrow({ where: { squareId }, select: { paymentStatus: true } })
        .then((s) => s.paymentStatus);

    const ledgerRows = (board: string = boardId) =>
      db.contribution.findMany({
        where: { boardId: board },
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          status: true,
          paymentMethod: true,
          squareAmountCents: true,
          checkoutSessionId: true,
          releasedAt: true,
          confirmedAt: true,
          _count: { select: { squares: true } },
        },
      });

    before(async () => {
      const h = await db.host.create({
        data: { email: "cash-" + randomUUID() + "@example.com", supabaseUserId: HOST_UID },
      });
      hostId = h.id;
      currentHost = { id: h.id };
      otherBoardId = await seedBoard();
    });

    beforeEach(async () => {
      if (!boardId) {
        boardId = await seedBoard();
        return;
      }
      await db.paymentReference.deleteMany({ where: { square: { boardId } } });
      await db.square.deleteMany({ where: { boardId } });
      await db.contribution.deleteMany({ where: { boardId } });
      await db.board.deleteMany({ where: { boardId } });
      boardId = await seedBoard();
    });

    after(async () => {
      for (const b of [boardId, otherBoardId]) {
        if (!b) continue;
        await db.paymentReference.deleteMany({ where: { square: { boardId: b } } });
        await db.square.deleteMany({ where: { boardId: b } });
        await db.contribution.deleteMany({ where: { boardId: b } });
        await db.board.deleteMany({ where: { boardId: b } });
      }
      if (hostId) await db.host.deleteMany({ where: { id: hostId } });
      await db.$disconnect();
    });

    // ---- baseline ----------------------------------------------------------

    test("a plain cash square writes its own confirmed row", async () => {
      const [sq] = await reserve(1);
      assert.equal((await confirmCash(sq)).status, 200);

      const rows = await ledgerRows();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].status, "confirmed");
      assert.equal(rows[0].paymentMethod, "cash");
      assert.equal(rows[0].squareAmountCents, PRICE);
      await assertReconciled();
    });

    // ---- THE CARD -> CASH REGRESSION --------------------------------------
    //
    // The exact live shape found in production: a square pointing at a
    // `released` stripe row, because the contributor abandoned Stripe and
    // switched to direct payment. The old guard skipped the ledger entirely.
    test("card -> cash: a released stripe pointer does not suppress the row", async () => {
      const [sq] = await reserve(1);
      const oldId = await link([sq], "released");

      assert.equal((await confirmCash(sq)).status, 200);

      const rows = await ledgerRows();
      assert.equal(rows.length, 2, "the old row survives, a new one is written");

      const old = rows.find((r) => r.id === oldId)!;
      assert.equal(old.status, "released", "provenance intact");
      assert.equal(old.paymentMethod, "stripe");
      assert.ok(old.checkoutSessionId, "still carries its Stripe session");
      assert.equal(old.confirmedAt, null, "never converted");
      assert.equal(old._count.squares, 0, "detached");

      const fresh = rows.find((r) => r.id !== oldId)!;
      assert.equal(fresh.status, "confirmed");
      assert.equal(fresh.paymentMethod, "cash");
      assert.equal(fresh.checkoutSessionId, null, "cash rows carry no session id");
      assert.equal(fresh.squareAmountCents, PRICE);

      await assertReconciled();
    });

    // The A1-backfill shape, and the same shape a pending card row leaves.
    test("a pending pointer does not suppress the row either", async () => {
      const [sq] = await reserve(1);
      const oldId = await link([sq], "pending");

      assert.equal((await confirmCash(sq)).status, 200);

      const rows = await ledgerRows();
      const old = rows.find((r) => r.id === oldId)!;
      assert.equal(old.status, "pending", "left alone for the expiry path");
      assert.equal(old._count.squares, 0);
      assert.equal(rows.find((r) => r.id !== oldId)!.status, "confirmed");
      await assertReconciled();
    });

    // ---- THE BATCH-LEVEL CASE ---------------------------------------------
    //
    // Why the pending row is NOT transitioned. One card checkout for three
    // squares is ONE row worth 3 x price. Cash confirmation is per square
    // (money doc §4), so flipping that row on the first confirmation would
    // count all three squares of money for one payment.
    test("confirming one square of a 3-square pending row counts ONE square", async () => {
      const ids = await reserve(3);
      await link(ids, "pending"); // squareAmountCents = 3 x PRICE

      assert.equal((await confirmCash(ids[0])).status, 200);

      const rows = await ledgerRows();
      const confirmed = rows.filter((r) => r.status === "confirmed");
      assert.equal(confirmed.length, 1);
      assert.equal(confirmed[0].squareAmountCents, PRICE, "one square, not three");

      const pending = rows.find((r) => r.status === "pending")!;
      assert.equal(pending._count.squares, 2, "the other two are still its");

      await assertReconciled();

      // And the remaining two resolve independently.
      assert.equal((await confirmCash(ids[1])).status, 200);
      assert.equal((await confirmCash(ids[2])).status, 200);
      const after = await ledgerRows();
      assert.equal(after.filter((r) => r.status === "confirmed").length, 3);
      assert.equal(after.find((r) => r.status === "pending")!._count.squares, 0);
      await assertReconciled();
    });

    // ---- IDEMPOTENCE -------------------------------------------------------

    test("confirming twice writes exactly one row and one payment reference", async () => {
      const [sq] = await reserve(1);
      assert.equal((await confirmCash(sq)).status, 200);
      assert.equal((await confirmCash(sq)).status, 409, "no longer reserved_cash");

      assert.equal((await ledgerRows()).length, 1);
      assert.equal(
        await db.paymentReference.count({ where: { squareId: sq } }),
        1
      );
      await assertReconciled();
    });

    // An exact-match confirmed row means the money is already on the books:
    // flip the square, write nothing.
    test("an exact confirmed cash row is not duplicated", async () => {
      const [sq] = await reserve(1);
      await link([sq], "confirmed", { method: "cash", cents: PRICE });

      assert.equal((await confirmCash(sq)).status, 200);
      assert.equal(await statusOf(sq), "paid");
      assert.equal((await ledgerRows()).length, 1, "no second row");
      await assertReconciled();
    });

    // ---- HARD STOPS --------------------------------------------------------
    //
    // Every one: 409, nothing written, AND THE SQUARE STAYS reserved_cash.
    // A refusal after the flip is the end state being fixed.

    /**
     * The board sums, for a before/after comparison.
     *
     * The hard-stop fixtures are DELIBERATELY CORRUPT - a confirmed row whose
     * amount, method or square count does not describe reality is exactly the
     * state being refused - so global reconciliation cannot hold in those
     * tests by construction. The honest property there is that the handler
     * CHANGED NOTHING: refusing must not make the divergence worse, and must
     * not quietly repair it either.
     */
    async function snapshot(board: string = boardId) {
      const squares = await db.square.aggregate({
        where: { boardId: board, paymentStatus: "paid" },
        _sum: { pricePaidCents: true },
      });
      const ledger = await db.contribution.aggregate({
        where: { boardId: board, status: "confirmed", voidedAt: null },
        _sum: { squareAmountCents: true },
      });
      return {
        paid: squares._sum.pricePaidCents ?? 0,
        ledger: ledger._sum.squareAmountCents ?? 0,
      };
    }

    async function assertRefused(
      squareId: string,
      expectRows: number,
      before: { paid: number; ledger: number }
    ) {
      assert.equal(await statusOf(squareId), "reserved_cash", "square not flipped");
      assert.equal((await ledgerRows()).length, expectRows, "nothing written");
      assert.deepEqual(await snapshot(), before, "refusing changed the books");
    }

    test("hard stop: confirmed row with a different amount", async () => {
      const [sq] = await reserve(1);
      await link([sq], "confirmed", { method: "cash", cents: PRICE + 1 });
      const before = await snapshot();
      assert.equal((await confirmCash(sq)).status, 409);
      await assertRefused(sq, 1, before);
    });

    test("hard stop: confirmed row that is not cash", async () => {
      const [sq] = await reserve(1);
      await link([sq], "confirmed", { method: "stripe", cents: PRICE });
      const before = await snapshot();
      assert.equal((await confirmCash(sq)).status, 409);
      await assertRefused(sq, 1, before);
    });

    test("hard stop: confirmed row covering more than one square", async () => {
      const ids = await reserve(2);
      await link(ids, "confirmed", { method: "cash", cents: PRICE * 2 });
      const before = await snapshot();
      assert.equal((await confirmCash(ids[0])).status, 409);
      await assertRefused(ids[0], 1, before);
    });

    test("hard stop: confirmed row that was voided", async () => {
      const [sq] = await reserve(1);
      await link([sq], "confirmed", { method: "cash", cents: PRICE, voided: true });
      const before = await snapshot();
      assert.equal((await confirmCash(sq)).status, 409);
      await assertRefused(sq, 1, before);
    });

    test("hard stop: pointer belongs to another board", async () => {
      const [sq] = await reserve(1);
      await link([sq], "pending", { board: otherBoardId });
      assert.equal((await confirmCash(sq)).status, 409);
      assert.equal(await statusOf(sq), "reserved_cash");
      assert.equal((await ledgerRows()).length, 0, "nothing written on this board");
      await assertReconciled();
    });

    // ---- RELEASE -> RECLAIM ------------------------------------------------
    //
    // A released square must not hand its old pointer to the next contributor.
    // The four release paths now clear it; this asserts the consequence.
    test("release -> reclaim: the next contributor gets their own row", async () => {
      const [sq] = await reserve(1);
      await link([sq], "pending");

      // Released back to open, as every release path now writes it.
      await db.square.update({
        where: { squareId: sq },
        data: {
          paymentStatus: "open",
          playerName: null,
          playerEmail: null,
          pricePaidCents: null,
          batchId: null,
          claimedAt: null,
          contributionId: null,
          releaseReason: "expired",
        },
      });

      const [again] = await reserve(1);
      assert.equal(again, sq, "the same square, claimed by someone new");
      assert.equal((await confirmCash(again)).status, 200);

      const confirmed = (await ledgerRows()).filter((r) => r.status === "confirmed");
      assert.equal(confirmed.length, 1);
      assert.equal(confirmed[0].squareAmountCents, PRICE);
      await assertReconciled();
    });

    // A stale pointer surviving a release is exactly what used to suppress the
    // next row, so it is asserted rather than assumed.
    test("a square released with a stale pointer would still suppress nothing", async () => {
      const [sq] = await reserve(1);
      await link([sq], "released");
      // Deliberately NOT cleared - the pre-fix state, to prove the handler
      // no longer depends on the release paths having done their part.
      await db.square.update({
        where: { squareId: sq },
        data: { paymentStatus: "open", pricePaidCents: null, batchId: null },
      });

      const [again] = await reserve(1);
      assert.equal((await confirmCash(again)).status, 200);
      await assertReconciled();
    });
  }
);
