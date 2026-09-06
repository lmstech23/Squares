import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";
import { boardCounters } from "./board-counters.ts";

// The four host counters, over REAL rows.
//
// THE BUG. All four counted squares, so a donation - which takes no square -
// moved nothing. A donor could sit at AWAITING in the contributor list while
// the AWAITING box above it read 0, and the host read her own board as broken.
//
// The page query is run verbatim here, not paraphrased: `squareAmountCents: 0`
// is what keeps a mixed purchase from being counted twice, and that filter
// lives in the query rather than in the counting function.
//
//   npm run test:db:up && npm run test:integration:counters

const url = process.env.TEST_DATABASE_URL;
const prisma = url ? new PrismaClient({ datasources: { db: { url } } }) : null;

describe(
  "board counters (integration)",
  { skip: !url && "TEST_DATABASE_URL not set" },
  () => {
    const db = prisma!;
    let hostId: string;
    let boardId = "";
    const PRICE = 5000;
    const SIZE = 10;

    /** Exactly what the host page does. */
    async function counters() {
      const board = await db.board.findUniqueOrThrow({
        where: { boardId },
        select: { squares: { select: { paymentStatus: true } } },
      });
      const donations = await db.contribution.findMany({
        where: {
          boardId,
          status: { in: ["confirmed", "pending"] },
          squareAmountCents: 0,
          donationAmountCents: { gt: 0 },
        },
        select: { status: true, paymentMethod: true, voidedAt: true },
      });
      return boardCounters(board.squares, donations);
    }

    async function squares(status: string, n: number) {
      const open = await db.square.findMany({
        where: { boardId, paymentStatus: "open" },
        orderBy: { position: "asc" },
        take: n,
      });
      await db.square.updateMany({
        where: { squareId: { in: open.map((s) => s.squareId) } },
        data: {
          paymentStatus: status as never,
          pricePaidCents: PRICE,
          batchId: randomUUID(),
        },
      });
      return open.map((s) => s.squareId);
    }

    async function contribution(opts: {
      status: string;
      method?: "cash" | "stripe";
      squareCents?: number;
      voided?: boolean;
    }) {
      const sqc = opts.squareCents ?? 0;
      await db.contribution.create({
        data: {
          boardId,
          status: opts.status as never,
          paymentMethod: opts.method ?? "cash",
          squareAmountCents: sqc,
          donationAmountCents: 2500,
          totalPaidCents: 2500 + sqc,
          contributorName: "Person",
          contributorEmail: "p@example.com",
          confirmedAt: opts.status === "confirmed" ? new Date() : null,
          voidedAt: opts.voided ? new Date() : null,
        },
      });
    }

    before(async () => {
      const h = await db.host.create({
        data: { email: "cnt-" + randomUUID() + "@example.com" },
      });
      hostId = h.id;
    });

    beforeEach(async () => {
      if (boardId) {
        await db.square.deleteMany({ where: { boardId } });
        await db.contribution.deleteMany({ where: { boardId } });
        await db.board.deleteMany({ where: { boardId } });
      }
      const b = await db.board.create({
        data: {
          hostId,
          gameName: "Counters",
          slug: "cnt-" + randomUUID().slice(0, 8),
          boardType: "fundraiser",
          squarePrice: PRICE,
          totalSquares: SIZE,
          timezone: "America/New_York",
          campaignEndsAt: new Date(Date.now() + 7 * 864e5),
        },
      });
      boardId = b.boardId;
      await db.square.createMany({
        data: Array.from({ length: SIZE }, (_, i) => ({
          boardId,
          position: i,
          paymentStatus: "open" as const,
        })),
      });
    });

    after(async () => {
      if (boardId) {
        await db.square.deleteMany({ where: { boardId } });
        await db.contribution.deleteMany({ where: { boardId } });
        await db.board.deleteMany({ where: { boardId } });
      }
      if (hostId) await db.host.deleteMany({ where: { id: hostId } });
      await db.$disconnect();
    });

    // ---- TICKET-ONLY: unchanged, and still quantity-based -------------------

    test("tickets only: the four still partition the board", async () => {
      await squares("paid", 3);
      await squares("reserved_cash", 2);
      await squares("pending", 1);

      const c = await counters();
      assert.deepEqual(c, { confirmed: 3, awaiting: 2, inCheckout: 1, open: 4 });
      assert.equal(c.confirmed + c.awaiting + c.inCheckout + c.open, SIZE);
    });

    // THE COUNTING RULE, stated as a number. One person, three tickets, three.
    test("one purchase of 3 tickets counts 3, not 1", async () => {
      const ids = await squares("paid", 3);
      const batch = randomUUID();
      await db.square.updateMany({
        where: { squareId: { in: ids } },
        data: { batchId: batch, playerEmail: "one@example.com" },
      });
      assert.equal((await counters()).confirmed, 3);
    });

    // ---- DONATION-ONLY: the bug ---------------------------------------------

    test("a confirmed donation moves CONFIRMED", async () => {
      await contribution({ status: "confirmed" });
      const c = await counters();
      assert.equal(c.confirmed, 1, "was 0 before this change");
      assert.equal(c.open, SIZE, "and took no inventory");
    });

    test("a pending CASH donation moves AWAITING PAYMENT", async () => {
      await contribution({ status: "pending", method: "cash" });
      assert.equal((await counters()).awaiting, 1);
    });

    test("a pending STRIPE donation moves IN CHECKOUT", async () => {
      await contribution({ status: "pending", method: "stripe" });
      const c = await counters();
      assert.equal(c.inCheckout, 1);
      assert.equal(c.awaiting, 0, "not confused with a declared direct payment");
    });

    // A void leaves `status` reading confirmed. Counting on status alone would
    // keep reversed money in CONFIRMED.
    test("a voided donation counts nowhere, despite status = confirmed", async () => {
      await contribution({ status: "confirmed", voided: true });
      assert.deepEqual(await counters(), {
        confirmed: 0,
        awaiting: 0,
        inCheckout: 0,
        open: SIZE,
      });
    });

    test("a released donation counts nowhere", async () => {
      await contribution({ status: "released", method: "stripe" });
      assert.equal((await counters()).inCheckout, 0);
    });

    // ---- MIXED: counted once, through the squares ---------------------------

    test("a mixed purchase counts its tickets and NOT again as a donation", async () => {
      await squares("paid", 2);
      // Tickets plus a donation on top: one purchase, squareAmountCents > 0.
      await contribution({ status: "confirmed", squareCents: PRICE * 2 });

      const c = await counters();
      assert.equal(c.confirmed, 2, "two tickets, not three");
      assert.equal(c.open, SIZE - 2);
    });

    test("a pending mixed purchase does not inflate IN CHECKOUT", async () => {
      await squares("pending", 2);
      await contribution({ status: "pending", method: "stripe", squareCents: PRICE * 2 });
      assert.equal((await counters()).inCheckout, 2);
    });

    // ---- OPEN is inventory, always ------------------------------------------

    test("donations never change OPEN", async () => {
      await contribution({ status: "confirmed" });
      await contribution({ status: "pending", method: "cash" });
      await contribution({ status: "pending", method: "stripe" });
      assert.equal((await counters()).open, SIZE);
    });

    // ---- and the row stops summing, which is the point of the new layout ----

    test("with a donation the four no longer sum to the board size", async () => {
      await squares("paid", 1);
      await contribution({ status: "confirmed" });

      const c = await counters();
      assert.equal(c.confirmed, 2, "one ticket plus one donation");
      assert.equal(
        c.confirmed + c.awaiting + c.inCheckout + c.open,
        SIZE + 1,
        "exceeds the board size - the row is two groups, not a total"
      );
    });
  }
);
