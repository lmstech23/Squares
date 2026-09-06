import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";
import { contributorRows } from "./contributor-rows.ts";

// The host board page contributor list, over REAL rows.
//
// THE DEFECT. The list was built from Square rows alone, so a donation - which
// takes no square - appeared nowhere. A host who had just taken a donation saw
// "Nobody has claimed a ticket yet" on a card titled Contributors, and read it
// as nothing having happened.
//
// The queries live in the page; this asserts them AND the fold together, by
// running the same `where` clauses against real rows and folding the results.
// The filters matter as much as the merge: a voided contribution still reads
// `confirmed`, so a status-only filter would show someone as a contributor
// after their money was reversed.
//
//   npm run test:db:up && npm run test:integration:contributors

const url = process.env.TEST_DATABASE_URL;
const prisma = url ? new PrismaClient({ datasources: { db: { url } } }) : null;

describe(
  "contributor rows (integration)",
  { skip: !url && "TEST_DATABASE_URL not set" },
  () => {
    const db = prisma!;
    let hostId: string;
    let boardId = "";
    const PRICE = 5000;

    /** The two queries the page runs, verbatim. */
    async function rows() {
      const claimed = await db.square.findMany({
        where: {
          boardId,
          paymentStatus: { in: ["paid", "reserved_cash"] },
          playerEmail: { not: null },
        },
        select: {
          playerName: true,
          playerEmail: true,
          paymentStatus: true,
          claimedAt: true,
        },
      });
      const donations = await db.contribution.findMany({
        where: {
          boardId,
          status: { in: ["confirmed", "pending"] },
          voidedAt: null,
          donationAmountCents: { gt: 0 },
          contributorEmail: { not: null },
        },
        select: {
          contributorName: true,
          contributorEmail: true,
          status: true,
          createdAt: true,
        },
      });
      return contributorRows(claimed, donations);
    }

    async function ticket(email: string, name: string, paid: boolean) {
      const sq = await db.square.findFirstOrThrow({
        where: { boardId, paymentStatus: "open" },
        orderBy: { position: "asc" },
      });
      await db.square.update({
        where: { squareId: sq.squareId },
        data: {
          paymentStatus: paid ? "paid" : "reserved_cash",
          paymentMethod: "cash",
          playerName: name,
          playerEmail: email,
          pricePaidCents: PRICE,
          batchId: randomUUID(),
          claimedAt: new Date(),
        },
      });
    }

    async function donation(
      email: string,
      name: string,
      opts: { status?: string; voided?: boolean; squareCents?: number } = {}
    ) {
      const sqc = opts.squareCents ?? 0;
      await db.contribution.create({
        data: {
          boardId,
          status: (opts.status ?? "confirmed") as never,
          paymentMethod: "cash",
          squareAmountCents: sqc,
          donationAmountCents: 2500,
          totalPaidCents: 2500 + sqc,
          contributorName: name,
          contributorEmail: email,
          confirmedAt: new Date(),
          voidedAt: opts.voided ? new Date() : null,
        },
      });
    }

    before(async () => {
      const h = await db.host.create({
        data: { email: "cr-" + randomUUID() + "@example.com" },
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
          gameName: "Contributors",
          slug: "cr-" + randomUUID().slice(0, 8),
          boardType: "fundraiser",
          squarePrice: PRICE,
          totalSquares: 6,
          timezone: "America/New_York",
          campaignEndsAt: new Date(Date.now() + 7 * 864e5),
        },
      });
      boardId = b.boardId;
      await db.square.createMany({
        data: Array.from({ length: 6 }, (_, i) => ({
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

    // THE REPORTED BUG.
    test("a donation with no tickets appears as a contributor", async () => {
      await donation("donor@example.com", "Donor");
      const r = await rows();
      assert.equal(r.length, 1, "the list is not empty");
      assert.equal(r[0].tickets, 0, "no inventory taken");
      assert.equal(r[0].donated, true);
      assert.equal(r[0].status, "CONFIRMED");
    });

    test("a pending donation shows AWAITING", async () => {
      await donation("donor@example.com", "Donor", { status: "pending" });
      assert.equal((await rows())[0].status, "AWAITING");
    });

    // Same aggregation the square-only version used.
    test("tickets and a donation from one person are ONE row", async () => {
      await ticket("both@example.com", "Both", true);
      await ticket("both@example.com", "Both", true);
      await donation("both@example.com", "Both");

      const r = await rows();
      assert.equal(r.length, 1);
      assert.equal(r[0].tickets, 2);
      assert.equal(r[0].donated, true);
      assert.equal(r[0].status, "CONFIRMED");
    });

    test("case differences in the email still collapse to one row", async () => {
      await ticket("Mixed@Example.com", "Person", true);
      await donation("mixed@example.COM", "Person");
      const r = await rows();
      assert.equal(r.length, 1);
      assert.equal(r[0].tickets, 1);
      assert.equal(r[0].donated, true);
    });

    // A host chasing money must not see a green row with something unpaid
    // behind it - the same rule the squares already followed.
    test("a confirmed ticket plus a pending donation is MIXED", async () => {
      await ticket("m@example.com", "M", true);
      await donation("m@example.com", "M", { status: "pending" });
      assert.equal((await rows())[0].status, "MIXED");
    });

    test("a reserved ticket plus a confirmed donation is MIXED", async () => {
      await ticket("m2@example.com", "M2", false);
      await donation("m2@example.com", "M2");
      assert.equal((await rows())[0].status, "MIXED");
    });

    // A VOID LEAVES status READING confirmed. Filtering on status alone would
    // list someone as a contributor after their money was reversed.
    test("a voided donation is not a contributor, despite status = confirmed", async () => {
      await donation("void@example.com", "Voided", { voided: true });
      assert.deepEqual(await rows(), []);
    });

    test("a released donation is not a contributor", async () => {
      await donation("rel@example.com", "Released", { status: "released" });
      assert.deepEqual(await rows(), []);
    });

    // Donate-on-top: one purchase, tickets and a gift. The square already puts
    // them in the list; the marker is what says they also gave.
    test("a mixed contribution marks the row as donated", async () => {
      await ticket("top@example.com", "OnTop", true);
      await donation("top@example.com", "OnTop", { squareCents: PRICE });
      const r = await rows();
      assert.equal(r.length, 1);
      assert.equal(r[0].tickets, 1);
      assert.equal(r[0].donated, true);
    });

    test("a ticket buyer who never donated is not marked", async () => {
      await ticket("plain@example.com", "Plain", true);
      const r = await rows();
      assert.equal(r[0].donated, false);
      assert.equal(r[0].tickets, 1);
    });

    test("no contributions at all yields an empty list", async () => {
      assert.deepEqual(await rows(), []);
    });
  }
);
