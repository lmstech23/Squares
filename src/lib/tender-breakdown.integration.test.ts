import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";

// The close-flow deposit breakdown, against a real database — payment-method
// addendum v1.2.8 §7.
//
// THE PROPERTY THIS FILE EXISTS FOR: the breakdown totals the SAME POPULATION
// as the ledger header. Not "a similar filter" - the same one, because
// tenderBreakdown imports countsTowardRaised rather than restating it. The
// board below deliberately contains every row that must NOT count: a voided
// one, a pending one and a released one. If the two numbers ever disagree, a
// host is reconciling a deposit against a total that does not exist.
//
// AND: money with no recorded method reads "Unspecified", never "Cash".
//
//   npm run test:db:up && npm run test:integration:breakdown

const url = process.env.TEST_DATABASE_URL;
const prisma = url ? new PrismaClient({ datasources: { db: { url } } }) : null;

const { tenderBreakdown } = url
  ? await import("./tender-breakdown.ts")
  : ({} as never);
const { boardTotals } = url ? await import("./contributions.ts") : ({} as never);

describe(
  "tender breakdown (integration)",
  { skip: !url && "TEST_DATABASE_URL not set" },
  () => {
    const db = prisma!;
    let hostId = "";
    let boardId = "";

    // Counted: 1000 + 610 + 500 + 330.
    const COUNTED = 2440;

    async function row(over: Record<string, unknown>) {
      await db.contribution.create({
        data: {
          boardId,
          status: "confirmed",
          settlement: "OFFLINE",
          squareAmountCents: 0,
          donationAmountCents: 0,
          totalPaidCents: 0,
          contributorName: "Breakdown Fixture",
          contributorEmail: "bd@example.invalid",
          confirmedAt: new Date(),
          ...over,
        } as never,
      });
    }

    before(async () => {
      const host = await db.host.create({
        data: { email: "bd-" + randomUUID() + "@example.invalid" },
      });
      hostId = host.id;
      const board = await db.board.create({
        data: {
          hostId,
          gameName: "Breakdown Fixture",
          slug: "bdn-" + randomUUID().slice(0, 8),
          boardType: "fundraiser",
          acceptedPaymentMethods: ["card", "zelle"],
          hostZelle: "host@example.invalid",
          squarePrice: 5000,
          totalSquares: 4,
          timezone: "America/New_York",
          campaignEndsAt: new Date(Date.now() + 30 * 864e5),
        },
      });
      boardId = board.boardId;

      // --- counted ---
      await row({ settlement: "STRIPE", tender: "CARD", donationAmountCents: 1000, totalPaidCents: 1000 });
      await row({ tender: "ZELLE", donationAmountCents: 610, totalPaidCents: 610 });
      await row({ tender: "CASH", donationAmountCents: 330, totalPaidCents: 330 });
      // The historical shape: confirmed money, no recorded method.
      await row({ tender: null, donationAmountCents: 500, totalPaidCents: 500 });

      // --- must NOT count ---
      await row({
        tender: "CASH",
        donationAmountCents: 999,
        totalPaidCents: 999,
        voidedAt: new Date(),
        voidedByHostId: hostId,
        voidReason: "fixture",
      });
      await row({ status: "pending", tender: null, donationAmountCents: 700, totalPaidCents: 700, confirmedAt: null });
      await row({
        settlement: "STRIPE",
        tender: "CARD",
        status: "released",
        donationAmountCents: 400,
        totalPaidCents: 400,
        confirmedAt: null,
        releasedAt: new Date(),
      });
    });

    after(async () => {
      if (boardId) {
        await db.contribution.deleteMany({ where: { boardId } });
        await db.board.deleteMany({ where: { boardId } });
      }
      if (hostId) await db.host.deleteMany({ where: { id: hostId } });
      await db.$disconnect();
    });

    test("the breakdown total equals the ledger header total", async () => {
      const breakdown = await tenderBreakdown(boardId);
      const totals = await boardTotals(boardId);
      assert.equal(
        breakdown.totalCents,
        totals.raisedCents,
        "the deposit list and the header must be the same money"
      );
      assert.equal(breakdown.totalCents, COUNTED);
    });

    test("voided, pending and released money is excluded from both", async () => {
      const breakdown = await tenderBreakdown(boardId);
      const totals = await boardTotals(boardId);
      // 999 voided + 700 pending + 400 released never appear in either number.
      assert.equal(totals.raisedCents, COUNTED);
      assert.equal(breakdown.totalCents, COUNTED);
      assert.equal(
        breakdown.rows.reduce((n, r) => n + r.cents, 0),
        COUNTED,
        "the rows sum to the same total they are presented under"
      );
    });

    test("grouped by how it arrived, biggest first", async () => {
      const { rows } = await tenderBreakdown(boardId);
      assert.deepEqual(
        rows.map((r) => [r.label, r.cents]),
        [
          ["Card", 1000],
          ["Zelle", 610],
          ["Unspecified", 500],
          ["Cash", 330],
        ]
      );
    });

    test("money with no recorded method is Unspecified, never Cash", async () => {
      const { rows, unspecifiedCents } = await tenderBreakdown(boardId);
      const nullRow = rows.find((r) => r.tender === null);
      assert.ok(nullRow, "the historical rows get their own line");
      assert.equal(nullRow.label, "Unspecified");
      assert.notEqual(nullRow.label, "Cash");
      assert.equal(unspecifiedCents, 500);
      // And the real cash line is its own, separate money.
      assert.equal(rows.find((r) => r.tender === "CASH")?.cents, 330);
    });

    test("a board with nothing confirmed produces no rows and no total", async () => {
      const empty = await db.board.create({
        data: {
          hostId,
          gameName: "Empty",
          slug: "bde-" + randomUUID().slice(0, 8),
          boardType: "fundraiser",
          acceptedPaymentMethods: ["card"],
          squarePrice: 5000,
          totalSquares: 1,
          timezone: "America/New_York",
          campaignEndsAt: new Date(Date.now() + 30 * 864e5),
        },
        select: { boardId: true },
      });
      const breakdown = await tenderBreakdown(empty.boardId);
      assert.deepEqual(breakdown.rows, []);
      assert.equal(breakdown.totalCents, 0);
      assert.equal(breakdown.totalCents, (await boardTotals(empty.boardId)).raisedCents);
      await db.board.deleteMany({ where: { boardId: empty.boardId } });
    });
  }
);
