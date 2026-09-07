import { test, describe, before, after, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";

// Resolving a reservation, against a REAL database.
//
// The seam itself is unit-tested in entry-reservation.test.ts. This proves the
// whole path: that confirming turns grouped lines into the RIGHT passes at the
// RIGHT prices, writes exactly one ledger row, and that releasing writes no
// money at all.
//
//   npm run test:db:up && npm run test:integration:reservation

const url = process.env.TEST_DATABASE_URL;
const prisma = url ? new PrismaClient({ datasources: { db: { url } } }) : null;

const { confirmEntryReservation, releaseEntryReservation, ReservationNotPending } = url
  ? await import("./entry-reservation.ts")
  : ({} as never);

describe(
  "entry reservation resolution (integration)",
  { skip: !url && "TEST_DATABASE_URL not set" },
  () => {
    const db = prisma!;
    let hostId = "";
    let boardId = "";
    let eventId = "";

    async function seed(over: Record<string, unknown> = {}) {
      const board = await db.board.create({
        data: {
          hostId,
          gameName: "Resolve Test",
          slug: "rsv-" + randomUUID().slice(0, 8),
          boardType: "fundraiser",
          squarePrice: 5000,
          totalSquares: 0,
          timezone: "America/New_York",
          campaignEndsAt: new Date(Date.now() + 30 * 864e5),
          entryChildPriceCents: 1500,
          entryAdultEarlyPriceCents: 4000,
          entryAdultRegularPriceCents: 5000,
          earlyBirdEndsAt: new Date(Date.now() + 20 * 864e5),
          ...over,
        },
      });
      boardId = board.boardId;
      const event = await db.event.create({
        data: {
          boardId,
          startsAt: new Date(Date.now() + 40 * 864e5),
          timezone: "America/New_York",
        },
      });
      eventId = event.id;
      return board;
    }

    /** 2 adult early at $40 + 1 child at $15 = $95. */
    async function reserve(
      lines = [
        { tier: "ADULT" as const, priceBasis: "EARLY" as const, unitPriceCents: 4000, quantity: 2 },
        { tier: "CHILD" as const, priceBasis: "FLAT" as const, unitPriceCents: 1500, quantity: 1 },
      ]
    ) {
      const r = await db.entryReservation.create({
        data: {
          boardId,
          eventId,
          referenceCode: "H82K4",
          contributorName: "Taylor Smith",
          contributorEmail: "taylor@example.com",
          contributorPhone: "+16785550142",
          paymentRail: "zelle",
          lines: { create: lines },
        },
        select: { id: true },
      });
      return r.id;
    }

    before(async () => {
      const h = await db.host.create({
        data: { email: "rsv-" + randomUUID() + "@example.com" },
      });
      hostId = h.id;
    });

    async function wipe() {
      if (!boardId) return;
      await db.checkInLog.deleteMany({ where: { eventId } });
      await db.admissionPass.deleteMany({ where: { supporter: { eventId } } });
      await db.admissionGrant.deleteMany({ where: { eventId } });
      await db.eventSupporter.deleteMany({ where: { eventId } });
      await db.entryReservationLine.deleteMany({ where: { reservation: { boardId } } });
      await db.entryReservation.deleteMany({ where: { boardId } });
      await db.contribution.deleteMany({ where: { boardId } });
      await db.event.deleteMany({ where: { boardId } });
      await db.board.deleteMany({ where: { boardId } });
      boardId = "";
    }
    beforeEach(wipe);
    after(async () => {
      await wipe();
      if (hostId) await db.host.deleteMany({ where: { id: hostId } });
      await db.$disconnect();
    });

    // ---- confirm ------------------------------------------------------------

    // THE END-TO-END SEAM CHECK. Grouped lines in, correct passes at correct
    // prices out, with the sum assertion in confirmEntryPurchase live.
    test("confirm mints one pass per unit, each at its stored price", async () => {
      await seed();
      const id = await reserve();
      const out = await db.$transaction((tx) =>
        confirmEntryReservation(tx, { reservationId: id, hostId })
      );
      assert.equal(out.passesMinted, 3, "2 adult + 1 child, not 2 lines");

      const passes = await db.admissionPass.findMany({
        where: { supporter: { eventId } },
        select: { tier: true, priceBasis: true, pricePaidCents: true, squareId: true },
      });
      assert.equal(passes.length, 3);
      assert.equal(passes.filter((p) => p.tier === "ADULT").length, 2);
      assert.equal(passes.filter((p) => p.tier === "CHILD").length, 1);
      for (const p of passes) {
        assert.equal(p.pricePaidCents, p.tier === "ADULT" ? 4000 : 1500);
        assert.equal(p.squareId, null, "standalone passes hold no square");
      }
      assert.equal(
        passes.reduce((n, p) => n + (p.pricePaidCents ?? 0), 0),
        9500
      );
    });

    test("confirm writes exactly one contribution, all entry money", async () => {
      await seed();
      const id = await reserve();
      await db.$transaction((tx) =>
        confirmEntryReservation(tx, { reservationId: id, hostId })
      );
      const rows = await db.contribution.findMany({ where: { boardId } });
      assert.equal(rows.length, 1, "one per reservation, not one per line");
      const c = rows[0];
      assert.equal(c.entryAmountCents, 9500);
      assert.equal(c.squareAmountCents, 0);
      assert.equal(c.donationAmountCents, 0);
      assert.equal(c.totalPaidCents, 9500);
      assert.equal(c.status, "confirmed");
      assert.equal(c.paymentMethod, "cash");
      assert.equal(c.confirmedByHostId, hostId);
      assert.equal(c.postCloseAt, null, "the board is open");
    });

    test("confirm marks every line paid and points it at the contribution", async () => {
      await seed();
      const id = await reserve();
      await db.$transaction((tx) =>
        confirmEntryReservation(tx, { reservationId: id, hostId })
      );
      const lines = await db.entryReservationLine.findMany({
        where: { reservationId: id },
      });
      for (const l of lines) {
        assert.equal(l.quantityConfirmed, l.quantity);
        assert.notEqual(l.contributionId, null, "the paid-has-contribution CHECK");
      }
      const r = await db.entryReservation.findUniqueOrThrow({ where: { id } });
      assert.equal(r.status, "resolved");
      assert.notEqual(r.resolvedAt, null);
      assert.equal(r.releasedAt, null);
    });

    test("the supporter is created only now, and is active", async () => {
      await seed();
      const id = await reserve();
      assert.equal(await db.eventSupporter.count({ where: { eventId } }), 0);

      await db.$transaction((tx) =>
        confirmEntryReservation(tx, { reservationId: id, hostId })
      );
      const s = await db.eventSupporter.findFirstOrThrow({ where: { eventId } });
      assert.equal(s.status, "active");

      const g = await db.admissionGrant.findFirstOrThrow({ where: { eventId } });
      assert.equal(g.source, "STANDALONE");
      assert.equal(g.donateAdmissions, false, "a standalone grant never donates");
    });

    test("confirming twice is refused and writes nothing the second time", async () => {
      await seed();
      const id = await reserve();
      await db.$transaction((tx) =>
        confirmEntryReservation(tx, { reservationId: id, hostId })
      );
      await assert.rejects(
        () =>
          db.$transaction((tx) =>
            confirmEntryReservation(tx, { reservationId: id, hostId })
          ),
        (e: unknown) => e instanceof ReservationNotPending
      );
      assert.equal(await db.contribution.count({ where: { boardId } }), 1);
      assert.equal(await db.admissionPass.count({ where: { supporter: { eventId } } }), 3);
    });

    // RULING 5. The board sealed before the host confirmed. The money is
    // recorded and the passes minted regardless; the stamp says it sits outside
    // the published total, which is not amended.
    test("confirming on a sealed board records the money and marks it post-close", async () => {
      await seed({ status: "closed", finalRaisedCents: 12345 });
      const id = await reserve();
      const out = await db.$transaction((tx) =>
        confirmEntryReservation(tx, { reservationId: id, hostId })
      );
      assert.equal(out.postClose, true);

      const c = await db.contribution.findFirstOrThrow({ where: { boardId } });
      assert.notEqual(c.postCloseAt, null);
      assert.equal(c.entryAmountCents, 9500, "the money is real and recorded");

      const b = await db.board.findUniqueOrThrow({ where: { boardId } });
      assert.equal(b.finalRaisedCents, 12345, "the sealed total did not move");
      assert.equal(
        await db.admissionPass.count({ where: { supporter: { eventId } } }),
        3,
        "and the passes were still minted"
      );
    });

    // A reservation taken before the cutoff and confirmed after it is still
    // owed the early price. The stored basis is what decides, not the clock.
    test("a stored EARLY line still mints at the early price after the cutoff", async () => {
      await seed({ earlyBirdEndsAt: new Date(Date.now() - 864e5) });
      const id = await reserve();
      await db.$transaction((tx) =>
        confirmEntryReservation(tx, { reservationId: id, hostId })
      );
      const adults = await db.admissionPass.findMany({
        where: { supporter: { eventId }, tier: "ADULT" },
      });
      assert.equal(adults.length, 2);
      for (const p of adults) {
        assert.equal(p.pricePaidCents, 4000, "not 5000 — the price was locked");
        assert.equal(p.priceBasis, "EARLY");
      }
      const c = await db.contribution.findFirstOrThrow({ where: { boardId } });
      assert.equal(c.entryAmountCents, 9500);
    });

    // ---- release ------------------------------------------------------------

    test("release writes no money and mints nothing", async () => {
      await seed();
      const id = await reserve();
      const { released } = await db.$transaction((tx) =>
        releaseEntryReservation(tx, { reservationId: id, reason: "never arrived" })
      );
      assert.equal(released, true);

      assert.equal(await db.contribution.count({ where: { boardId } }), 0);
      assert.equal(await db.eventSupporter.count({ where: { eventId } }), 0);
      assert.equal(await db.admissionPass.count({ where: { supporter: { eventId } } }), 0);
    });

    // Nothing is deleted: "what did this person reserve and what happened to
    // it" has to stay answerable.
    test("a released reservation keeps its code, lines and prices", async () => {
      await seed();
      const id = await reserve();
      await db.$transaction((tx) =>
        releaseEntryReservation(tx, { reservationId: id, reason: "never arrived" })
      );
      const r = await db.entryReservation.findUniqueOrThrow({
        where: { id },
        include: { lines: true },
      });
      assert.equal(r.status, "released");
      assert.equal(r.referenceCode, "H82K4");
      assert.equal(r.releaseReason, "never arrived");
      assert.notEqual(r.releasedAt, null);
      assert.equal(r.lines.length, 2);
      assert.equal(r.lines.find((l) => l.tier === "ADULT")!.unitPriceCents, 4000);
    });

    test("releasing an already-resolved reservation changes nothing", async () => {
      await seed();
      const id = await reserve();
      await db.$transaction((tx) =>
        confirmEntryReservation(tx, { reservationId: id, hostId })
      );
      const { released } = await db.$transaction((tx) =>
        releaseEntryReservation(tx, { reservationId: id, reason: "too late" })
      );
      assert.equal(released, false);
      const r = await db.entryReservation.findUniqueOrThrow({ where: { id } });
      assert.equal(r.status, "resolved", "confirm is not undone by a late release");
    });

    test("a single-tier reservation confirms cleanly", async () => {
      await seed();
      const id = await reserve([
        { tier: "CHILD" as const, priceBasis: "FLAT" as const, unitPriceCents: 1500, quantity: 4 },
      ]);
      const out = await db.$transaction((tx) =>
        confirmEntryReservation(tx, { reservationId: id, hostId })
      );
      assert.equal(out.passesMinted, 4);
      const c = await db.contribution.findFirstOrThrow({ where: { boardId } });
      assert.equal(c.entryAmountCents, 6000);
    });
  }
);

void mock;
