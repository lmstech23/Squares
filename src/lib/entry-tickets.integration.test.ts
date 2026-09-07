import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";
import { boardTotals } from "./contributions.ts";
import { pricingLocks } from "./board-lock.ts";
import { quoteEntry } from "./entry-pricing.ts";
import { confirmEntryPurchase, EntryAmountMismatch } from "./entry-purchase.ts";
import { mintPasses } from "./confirm-square.ts";

// Standalone Entry Tickets, end to end, against a REAL database.
//
// The Hampton values below are ONE BOARD'S CONFIGURATION used as test data.
// Nothing in the implementation knows them, and the optionality tests here
// prove a board that configures none of it is unaffected.
//
//   npm run test:db:up && npm run test:integration:entry

const url = process.env.TEST_DATABASE_URL;
const prisma = url ? new PrismaClient({ datasources: { db: { url } } }) : null;

const CUTOFF = new Date("2026-09-28T03:59:59.000Z");
const BEFORE = new Date("2026-09-20T12:00:00.000Z");

describe(
  "standalone entry tickets (integration)",
  { skip: !url && "TEST_DATABASE_URL not set" },
  () => {
    const db = prisma!;
    let hostId: string;
    let boardId = "";
    let eventId = "";

    /** Hampton: $15 child, $40 early adult, $50 regular adult, $5,000 goal. */
    const HAMPTON = {
      entryChildPriceCents: 1500,
      entryAdultEarlyPriceCents: 4000,
      entryAdultRegularPriceCents: 5000,
      earlyBirdEndsAt: CUTOFF,
      fundraisingGoalCents: 500_000,
    };

    async function seedBoard(entry: Record<string, unknown> = HAMPTON) {
      const b = await db.board.create({
        data: {
          hostId,
          gameName: "Entry",
          slug: "en-" + randomUUID().slice(0, 8),
          boardType: "fundraiser",
          squarePrice: 5000,
          totalSquares: 4,
          timezone: "America/New_York",
          campaignEndsAt: new Date(Date.now() + 30 * 864e5),
          ...entry,
        },
      });
      boardId = b.boardId;
      const ev = await db.event.create({
        data: { boardId, startsAt: new Date(Date.now() + 40 * 864e5), timezone: "America/New_York" },
      });
      eventId = ev.id;
      await db.square.createMany({
        data: Array.from({ length: 4 }, (_, i) => ({
          boardId,
          position: i,
          paymentStatus: "open" as const,
        })),
      });
      return b;
    }

    const CONTACT = { name: "Chris", email: "chris@example.com", phone: "6785551234" };

    /** A whole standalone purchase, confirmed, as the route will do it. */
    async function buyEntry(
      lines: { tier: "CHILD" | "ADULT"; quantity: number }[],
      now: Date = BEFORE,
      contact = CONTACT
    ) {
      const board = await db.board.findUniqueOrThrow({ where: { boardId } });
      const quote = quoteEntry(board, lines, now);
      assert.ok(quote.ok, "quote failed");
      return db.$transaction(async (tx) => {
        const c = await tx.contribution.create({
          data: {
            boardId,
            status: "confirmed",
            paymentMethod: "cash",
            squareAmountCents: 0,
            donationAmountCents: 0,
            entryAmountCents: quote.totalCents,
            totalPaidCents: quote.totalCents,
            contributorName: contact.name,
            contributorEmail: contact.email,
            contributorPhone: contact.phone,
            confirmedAt: new Date(),
          },
        });
        const r = await confirmEntryPurchase(tx, {
          eventId,
          contributionId: c.id,
          entryAmountCents: quote.totalCents,
          passes: quote.passes,
          contact,
        });
        return { contribution: c, ...r };
      });
    }

    before(async () => {
      const h = await db.host.create({
        data: { email: "en-" + randomUUID() + "@example.com" },
      });
      hostId = h.id;
    });

    beforeEach(async () => {
      if (boardId) {
        await db.admissionPass.deleteMany({ where: { supporter: { eventId } } });
        await db.admissionGrant.deleteMany({ where: { eventId } });
        await db.supporterAccessToken.deleteMany({ where: { supporter: { eventId } } });
        await db.eventSupporter.deleteMany({ where: { eventId } });
        await db.event.deleteMany({ where: { boardId } });
        await db.square.deleteMany({ where: { boardId } });
        await db.contribution.deleteMany({ where: { boardId } });
        await db.board.deleteMany({ where: { boardId } });
        boardId = "";
      }
    });

    after(async () => {
      if (boardId) {
        await db.admissionPass.deleteMany({ where: { supporter: { eventId } } });
        await db.admissionGrant.deleteMany({ where: { eventId } });
        await db.supporterAccessToken.deleteMany({ where: { supporter: { eventId } } });
        await db.eventSupporter.deleteMany({ where: { eventId } });
        await db.event.deleteMany({ where: { boardId } });
        await db.square.deleteMany({ where: { boardId } });
        await db.contribution.deleteMany({ where: { boardId } });
        await db.board.deleteMany({ where: { boardId } });
      }
      if (hostId) await db.host.deleteMany({ where: { id: hostId } });
      await db.$disconnect();
    });

    // ================================================================ §21 ===
    //
    // THE HIGHEST-PRIORITY MIXED PATH. A supporter who already holds
    // square-derived passes buys Entry Tickets.
    test("§21 — square passes, then 2 adult early + 1 child", async () => {
      await seedBoard();

      // Existing square-derived passes for the same person.
      const sup = await db.eventSupporter.create({
        data: {
          eventId,
          emailKey: CONTACT.email,
          phoneKey: "+16785551234",
          name: CONTACT.name,
          email: CONTACT.email,
          phone: CONTACT.phone,
        },
      });
      const squares = await db.square.findMany({ where: { boardId }, take: 2 });
      const batchId = randomUUID();
      await db.square.updateMany({
        where: { squareId: { in: squares.map((s) => s.squareId) } },
        data: { paymentStatus: "paid", pricePaidCents: 5000, batchId },
      });
      const squareContribution = await db.contribution.create({
        data: {
          boardId, status: "confirmed", paymentMethod: "cash",
          squareAmountCents: 10000, donationAmountCents: 0, entryAmountCents: 0,
          totalPaidCents: 10000, contributorName: CONTACT.name,
          contributorEmail: CONTACT.email, contributorPhone: CONTACT.phone,
          confirmedAt: new Date(),
        },
      });
      await db.square.updateMany({
        where: { squareId: { in: squares.map((s) => s.squareId) } },
        data: { contributionId: squareContribution.id },
      });
      await db.$transaction((tx) =>
        mintPasses(tx, sup.id, squares.map((s) => s.squareId))
      );

      const before = await boardTotals(boardId);
      assert.equal(before.prizeBasisCents, 10000);

      const { contribution } = await buyEntry(
        [{ tier: "ADULT", quantity: 2 }, { tier: "CHILD", quantity: 1 }],
        BEFORE
      );

      // --- the money
      assert.equal(contribution.entryAmountCents, 9500);
      assert.equal(contribution.totalPaidCents, 9500);

      const after = await boardTotals(boardId);
      assert.equal(after.raisedCents, before.raisedCents + 9500, "raised +$95");
      assert.equal(
        after.prizeBasisCents,
        before.prizeBasisCents,
        "PRIZE BASIS UNCHANGED — the assertion this whole design exists to hold"
      );
      assert.equal(after.entryCents, 9500);

      // --- the passes
      const entryPasses = await db.admissionPass.findMany({
        where: { eventSupporterId: sup.id, squareId: null },
        orderBy: { sequenceNumber: "asc" },
      });
      assert.equal(entryPasses.length, 3);
      assert.equal(entryPasses.filter((p) => p.tier === "ADULT" && p.priceBasis === "EARLY" && p.pricePaidCents === 4000).length, 2);
      assert.equal(entryPasses.filter((p) => p.tier === "CHILD" && p.priceBasis === "FLAT" && p.pricePaidCents === 1500).length, 1);
      assert.equal(
        entryPasses.reduce((n, p) => n + (p.pricePaidCents ?? 0), 0),
        9500
      );

      // --- sequence numbers monotonic and unreused ACROSS both kinds
      const all = await db.admissionPass.findMany({
        where: { eventSupporterId: sup.id },
        orderBy: { sequenceNumber: "asc" },
        select: { sequenceNumber: true },
      });
      assert.equal(all.length, 5, "2 square-derived + 3 entry");
      assert.deepEqual(all.map((p) => p.sequenceNumber), [1, 2, 3, 4, 5]);

      // --- locks
      const locks = await pricingLocks(boardId);
      assert.equal(locks.adultEarlyLocked, true);
      assert.equal(locks.childLocked, true);
      assert.equal(locks.cutoffLocked, true, "shared cutoff locked by the entry sale");
      assert.equal(
        locks.adultRegularLocked,
        false,
        "Adult Regular independently editable until one is confirmed"
      );
    });

    // ================================================== optionality (§22) ===

    test("a board with no entry pricing is unaffected", async () => {
      await seedBoard({
        entryChildPriceCents: null,
        entryAdultEarlyPriceCents: null,
        entryAdultRegularPriceCents: null,
        earlyBirdEndsAt: null,
        fundraisingGoalCents: null,
      });
      const squares = await db.square.findMany({ where: { boardId }, take: 1 });
      await db.square.update({
        where: { squareId: squares[0].squareId },
        data: { paymentStatus: "paid", pricePaidCents: 5000, batchId: randomUUID() },
      });
      await db.contribution.create({
        data: {
          boardId, status: "confirmed", paymentMethod: "cash",
          squareAmountCents: 5000, donationAmountCents: 0,
          totalPaidCents: 5000, contributorName: "X", contributorEmail: "x@e.com",
          contributorPhone: "6785550000", confirmedAt: new Date(),
        },
      });
      const t = await boardTotals(boardId);
      assert.equal(t.raisedCents, 5000);
      assert.equal(t.entryCents, 0);
      assert.equal(t.prizeBasisCents, 5000);
      const locks = await pricingLocks(boardId);
      assert.equal(locks.childLocked, false);
      assert.equal(locks.adultEarlyLocked, false);
      assert.equal(locks.cutoffLocked, false, "no early-bird product at all");
    });

    test("a donation-only board still works and reports no entry money", async () => {
      await seedBoard({
        entryChildPriceCents: null,
        entryAdultEarlyPriceCents: null,
        entryAdultRegularPriceCents: null,
        earlyBirdEndsAt: null,
      });
      await db.contribution.create({
        data: {
          boardId, status: "confirmed", paymentMethod: "cash",
          squareAmountCents: 0, donationAmountCents: 2500, totalPaidCents: 2500,
          contributorName: "D", contributorEmail: "d@e.com",
          contributorPhone: "6785550001", confirmedAt: new Date(),
        },
      });
      const t = await boardTotals(boardId);
      assert.equal(t.raisedCents, 2500);
      assert.equal(t.entryCents, 0);
      assert.equal(t.prizeBasisCents, 0);
    });

    test("child-only ticketed event is valid and sells", async () => {
      await seedBoard({
        entryChildPriceCents: 1000,
        entryAdultEarlyPriceCents: null,
        entryAdultRegularPriceCents: null,
        earlyBirdEndsAt: null,
      });
      const { contribution } = await buyEntry([{ tier: "CHILD", quantity: 2 }]);
      assert.equal(contribution.entryAmountCents, 2000);
      const locks = await pricingLocks(boardId);
      assert.equal(locks.childLocked, true);
      assert.equal(locks.adultRegularLocked, false);
      assert.equal(locks.cutoffLocked, false, "a FLAT sale locks no deadline");
    });

    test("adult-regular-only is valid and sells at the regular price", async () => {
      await seedBoard({
        entryChildPriceCents: null,
        entryAdultEarlyPriceCents: null,
        entryAdultRegularPriceCents: 2500,
        earlyBirdEndsAt: null,
      });
      const { contribution } = await buyEntry([{ tier: "ADULT", quantity: 1 }]);
      assert.equal(contribution.entryAmountCents, 2500);
      const locks = await pricingLocks(boardId);
      assert.equal(locks.adultRegularLocked, true);
      assert.equal(locks.adultEarlyLocked, false);
    });

    // ================================================ board constraints =====

    test("adult early without adult regular is rejected", async () => {
      await assert.rejects(() =>
        seedBoard({
          entryChildPriceCents: null,
          entryAdultEarlyPriceCents: 4000,
          entryAdultRegularPriceCents: null,
          earlyBirdEndsAt: CUTOFF,
        })
      );
      boardId = "";
    });

    test("adult early without a cutoff is rejected", async () => {
      await assert.rejects(() =>
        seedBoard({
          entryChildPriceCents: null,
          entryAdultEarlyPriceCents: 4000,
          entryAdultRegularPriceCents: 5000,
          earlyBirdEndsAt: null,
        })
      );
      boardId = "";
    });

    test("adult early >= adult regular is rejected", async () => {
      await assert.rejects(() =>
        seedBoard({
          entryChildPriceCents: null,
          entryAdultEarlyPriceCents: 5000,
          entryAdultRegularPriceCents: 5000,
          earlyBirdEndsAt: CUTOFF,
        })
      );
      boardId = "";
    });

    test("a zero entry price is rejected", async () => {
      await assert.rejects(() =>
        seedBoard({
          entryChildPriceCents: 0,
          entryAdultEarlyPriceCents: null,
          entryAdultRegularPriceCents: null,
          earlyBirdEndsAt: null,
        })
      );
      boardId = "";
    });

    // ============================================ contribution constraints ==

    test("an entry-only contribution passes amount_positive", async () => {
      await seedBoard();
      const c = await db.contribution.create({
        data: {
          boardId, status: "confirmed", paymentMethod: "cash",
          squareAmountCents: 0, donationAmountCents: 0, entryAmountCents: 1500,
          totalPaidCents: 1500, contributorName: "E", contributorEmail: "e@e.com",
          contributorPhone: "6785550002", confirmedAt: new Date(),
        },
      });
      assert.equal(c.entryAmountCents, 1500);
    });

    test("a negative entry amount is rejected", async () => {
      await seedBoard();
      await assert.rejects(() =>
        db.contribution.create({
          data: {
            boardId, status: "pending", paymentMethod: "cash",
            squareAmountCents: 0, donationAmountCents: 2500, entryAmountCents: -1,
            totalPaidCents: 2499, contributorName: "N", contributorEmail: "n@e.com",
            contributorPhone: "6785550003",
          },
        })
      );
    });

    test("a total that ignores the entry amount is rejected", async () => {
      await seedBoard();
      await assert.rejects(() =>
        db.contribution.create({
          data: {
            boardId, status: "pending", paymentMethod: "cash",
            squareAmountCents: 0, donationAmountCents: 0, entryAmountCents: 1500,
            totalPaidCents: 0, contributorName: "M", contributorEmail: "m@e.com",
            contributorPhone: "6785550004",
          },
        })
      );
    });

    // ================================================== pass constraints ====

    test("a partially priced pass is rejected", async () => {
      await seedBoard();
      const sup = await db.eventSupporter.create({
        data: {
          eventId, emailKey: "p@e.com", phoneKey: "+16785550005",
          name: "P", email: "p@e.com", phone: "6785550005",
        },
      });
      await assert.rejects(() =>
        db.admissionPass.create({
          data: {
            eventSupporterId: sup.id, sequenceNumber: 1, token: randomUUID(),
            tier: "ADULT", // priceBasis and pricePaidCents missing
          },
        })
      );
    });

    test("a square-derived pass with all three null stays valid", async () => {
      await seedBoard();
      const sup = await db.eventSupporter.create({
        data: {
          eventId, emailKey: "q@e.com", phoneKey: "+16785550006",
          name: "Q", email: "q@e.com", phone: "6785550006",
        },
      });
      const p = await db.admissionPass.create({
        data: { eventSupporterId: sup.id, sequenceNumber: 1, token: randomUUID() },
      });
      assert.equal(p.tier, null);
      assert.equal(p.pricePaidCents, null);
    });

    test("a STANDALONE grant cannot donate admissions", async () => {
      await seedBoard();
      const sup = await db.eventSupporter.create({
        data: {
          eventId, emailKey: "r@e.com", phoneKey: "+16785550007",
          name: "R", email: "r@e.com", phone: "6785550007",
        },
      });
      await assert.rejects(() =>
        db.admissionGrant.create({
          data: {
            eventId, eventSupporterId: sup.id, source: "STANDALONE",
            donateAdmissions: true, squareBatchId: randomUUID(),
          },
        })
      );
    });

    // ======================================= reconciliation and immutability =

    test("a mismatched pass sum refuses to confirm", async () => {
      await seedBoard();
      const c = await db.contribution.create({
        data: {
          boardId, status: "confirmed", paymentMethod: "cash",
          squareAmountCents: 0, donationAmountCents: 0, entryAmountCents: 9999,
          totalPaidCents: 9999, contributorName: "Z", contributorEmail: "z@e.com",
          contributorPhone: "6785550008", confirmedAt: new Date(),
        },
      });
      await assert.rejects(
        () =>
          db.$transaction((tx) =>
            confirmEntryPurchase(tx, {
              eventId,
              contributionId: c.id,
              entryAmountCents: 9999,
              passes: [{ tier: "CHILD", priceBasis: "FLAT", pricePaidCents: 1500 }],
              contact: CONTACT,
            })
          ),
        EntryAmountMismatch
      );
      assert.equal(
        await db.admissionPass.count({ where: { supporter: { eventId } } }),
        0,
        "nothing minted"
      );
    });

    // §2 / §12: revenue is the ledger, never current pass state.
    test("voiding a pass changes no money and releases no lock", async () => {
      await seedBoard();
      const { contribution } = await buyEntry([{ tier: "ADULT", quantity: 1 }], BEFORE);
      const before = await boardTotals(boardId);

      const pass = await db.admissionPass.findFirstOrThrow({
        where: { supporter: { eventId } },
      });
      await db.admissionPass.update({
        where: { id: pass.id },
        data: { status: "void" },
      });

      const after = await boardTotals(boardId);
      assert.equal(after.raisedCents, before.raisedCents, "raised unmoved");
      assert.equal(after.entryCents, before.entryCents);
      const c = await db.contribution.findUniqueOrThrow({ where: { id: contribution.id } });
      assert.equal(c.entryAmountCents, 4000, "unchanged by the void");
      assert.equal(c.totalPaidCents, 4000);

      const locks = await pricingLocks(boardId);
      assert.equal(
        locks.adultEarlyLocked,
        true,
        "someone paid under those terms; the commercial fact does not unwind"
      );
      assert.equal(locks.cutoffLocked, true);
    });

    // A pending entry purchase must lock nothing.
    test("a pending entry contribution locks no pricing", async () => {
      await seedBoard();
      const c = await db.contribution.create({
        data: {
          boardId, status: "pending", paymentMethod: "stripe",
          squareAmountCents: 0, donationAmountCents: 0, entryAmountCents: 4000,
          totalPaidCents: 4000, contributorName: "Pend", contributorEmail: "pend@e.com",
          contributorPhone: "6785550009",
        },
      });
      void c;
      const locks = await pricingLocks(boardId);
      assert.equal(locks.adultEarlyLocked, false);
      assert.equal(locks.cutoffLocked, false);
    });
  }
);
