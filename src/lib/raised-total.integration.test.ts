import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";
import { boardTotals } from "./contributions.ts";

// "Raised" on every surface a contributor or host reads.
//
// THE DEFECT THIS PINS. The public progress bar, the host board page and the
// final total written at close all summed Square.pricePaidCents over paid
// squares. A donation has no square, so every one of them silently excluded
// donation money while the host donations page - which already used
// boardTotals - included it. CLAUDE.md states the rule: "raisedCents is the
// sum of totalPaidCents over confirmed contributions and includes donations."
//
// finalRaisedCents is WRITE-ONCE, so on that surface the old formula did not
// merely display a wrong number, it froze one.
//
//   npm run test:db:up && npm run test:integration:raised

const url = process.env.TEST_DATABASE_URL;
const prisma = url ? new PrismaClient({ datasources: { db: { url } } }) : null;

describe(
  "raised totals (integration)",
  { skip: !url && "TEST_DATABASE_URL not set" },
  () => {
    const db = prisma!;
    let hostId: string;
    let boardId = "";

    async function seed() {
      const board = await db.board.create({
        data: {
          hostId,
          gameName: "Raised",
          slug: "rai-" + randomUUID().slice(0, 8),
          boardType: "fundraiser",
          squarePrice: 5000,
          totalSquares: 4,
          timezone: "America/New_York",
          campaignEndsAt: new Date(Date.now() + 7 * 864e5),
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

    /** A confirmed ticket purchase: the square AND its ledger row. */
    async function ticket(cents: number) {
      const sq = await db.square.findFirstOrThrow({
        where: { boardId, paymentStatus: "open" },
        orderBy: { position: "asc" },
      });
      const c = await db.contribution.create({
        data: {
          boardId,
          status: "confirmed",
          paymentMethod: "cash",
          squareAmountCents: cents,
          donationAmountCents: 0,
          totalPaidCents: cents,
          contributorName: "Buyer",
          confirmedAt: new Date(),
        },
      });
      await db.square.update({
        where: { squareId: sq.squareId },
        data: {
          paymentStatus: "paid",
          pricePaidCents: cents,
          batchId: randomUUID(),
          contributionId: c.id,
        },
      });
    }

    /** A donation. NO SQUARE - that is the whole point. */
    async function donation(cents: number, opts: { status?: string; voided?: boolean } = {}) {
      await db.contribution.create({
        data: {
          boardId,
          status: (opts.status ?? "confirmed") as never,
          paymentMethod: "cash",
          squareAmountCents: 0,
          donationAmountCents: cents,
          totalPaidCents: cents,
          contributorName: "Donor",
          confirmedAt: new Date(),
          voidedAt: opts.voided ? new Date() : null,
        },
      });
    }

    /** The OLD formula, kept so the divergence is asserted, not asserted about. */
    async function squaresOnly() {
      const agg = await db.square.aggregate({
        where: { boardId, paymentStatus: "paid" },
        _sum: { pricePaidCents: true },
      });
      return agg._sum.pricePaidCents ?? 0;
    }

    before(async () => {
      const h = await db.host.create({
        data: { email: "rai-" + randomUUID() + "@example.com" },
      });
      hostId = h.id;
    });

    beforeEach(async () => {
      if (!boardId) return;
      await db.square.deleteMany({ where: { boardId } });
      await db.contribution.deleteMany({ where: { boardId } });
      await db.board.deleteMany({ where: { boardId } });
      boardId = "";
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

    test("tickets only: the two formulas agree", async () => {
      await seed();
      await ticket(5000);
      await ticket(4000); // early bird
      assert.equal((await boardTotals(boardId)).raisedCents, 9000);
      assert.equal(await squaresOnly(), 9000, "no donations, so nothing diverges");
    });

    // THE BUG, stated as a number.
    test("a donation is counted, and the old formula misses it entirely", async () => {
      await seed();
      await ticket(5000);
      await donation(50_000); // a $500 gift

      const totals = await boardTotals(boardId);
      assert.equal(totals.raisedCents, 55_000);
      assert.equal(totals.donationCents, 50_000);
      assert.equal(await squaresOnly(), 5000, "the old number: the gift is invisible");
    });

    // Invariant 57 / 49 as amended: prize math reads the square basis and must
    // NOT follow raised now that raised includes donations.
    test("donations reach raised but never the prize basis", async () => {
      await seed();
      await ticket(5000);
      await donation(50_000);
      const totals = await boardTotals(boardId);
      assert.equal(totals.prizeBasisCents, 5000, "squares only");
      assert.notEqual(totals.prizeBasisCents, totals.raisedCents);
    });

    test("a pending donation is not counted until it is confirmed", async () => {
      await seed();
      await donation(2500, { status: "pending" });
      assert.equal((await boardTotals(boardId)).raisedCents, 0);
    });

    // A void leaves status reading `confirmed`. Testing status alone would
    // resurrect the money.
    test("a voided donation is not counted, despite status = confirmed", async () => {
      await seed();
      await donation(2500, { voided: true });
      assert.equal((await boardTotals(boardId)).raisedCents, 0);
    });

    test("a released donation is not counted", async () => {
      await seed();
      await donation(2500, { status: "released" });
      assert.equal((await boardTotals(boardId)).raisedCents, 0);
    });
  }
);
