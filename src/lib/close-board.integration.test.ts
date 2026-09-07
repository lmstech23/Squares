import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";

// The close guard, against a REAL database.
//
// There was no coverage of closeBoard at all before this. It is the piece the
// pilot depends on on its last day, and the specific thing being defended is
// subtle: a direct-payment ticket reservation has NO Contribution until the
// host confirms it, so a guard written against pending contributions finds
// nothing and the board finalizes with reservations outstanding.
//
//   npm run test:db:up && npm run test:integration:close

const url = process.env.TEST_DATABASE_URL;
const prisma = url ? new PrismaClient({ datasources: { db: { url } } }) : null;

const { closeBoard } = url
  ? await import("./close-board.ts")
  : ({} as never);

describe(
  "close guard (integration)",
  { skip: !url && "TEST_DATABASE_URL not set" },
  () => {
    const db = prisma!;
    let hostId = "";
    let boardId = "";
    let eventId = "";

    /** Campaign already ended, so a scheduled close is due. */
    async function seed(over: Record<string, unknown> = {}) {
      const board = await db.board.create({
        data: {
          hostId,
          gameName: "Close Test",
          slug: "cls-" + randomUUID().slice(0, 8),
          boardType: "fundraiser",
          squarePrice: 5000,
          totalSquares: 0,
          timezone: "America/New_York",
          campaignEndsAt: new Date(Date.now() - 864e5),
          acceptedPaymentMethods: ["zelle"],
          hostZelle: "host@example.com",
          entryChildPriceCents: 1500,
          entryAdultRegularPriceCents: 5000,
          ...over,
        },
      });
      boardId = board.boardId;
      const ev = await db.event.create({
        data: {
          boardId,
          startsAt: new Date(Date.now() + 20 * 864e5),
          timezone: "America/New_York",
        },
      });
      eventId = ev.id;
      return board;
    }

    async function reserve() {
      const r = await db.entryReservation.create({
        data: {
          boardId,
          eventId,
          referenceCode: "H82K4",
          contributorName: "Taylor Smith",
          contributorEmail: "taylor@example.com",
          contributorPhone: "+16785550142",
          paymentRail: "zelle",
          lines: {
            create: [
              { tier: "CHILD", priceBasis: "FLAT", unitPriceCents: 1500, quantity: 2 },
            ],
          },
        },
        select: { id: true },
      });
      return r.id;
    }

    /** A reserved_cash square, the thing that DOES auto-release. */
    async function reservedSquare() {
      await db.square.create({
        data: {
          boardId,
          position: 0,
          paymentStatus: "reserved_cash",
          playerName: "Someone",
          playerEmail: "s@example.com",
          pricePaidCents: 5000,
          batchId: randomUUID(),
          claimedAt: new Date(),
        },
      });
    }

    /** Close and return the status, asserting the call itself succeeded. */
    const closeStatus = async (hostInitiated: boolean) => {
      const out = await closeBoard(boardId, { hostInitiated });
      assert.ok(out.ok, `closeBoard failed: ${JSON.stringify(out)}`);
      return out.status;
    };

    const boardRow = () =>
      db.board.findUniqueOrThrow({
        where: { boardId },
        select: { status: true, finalRaisedCents: true },
      });

    before(async () => {
      const h = await db.host.create({
        data: { email: "cls-" + randomUUID() + "@example.com" },
      });
      hostId = h.id;
    });

    async function wipe() {
      if (!boardId) return;
      await db.admissionPass.deleteMany({ where: { supporter: { eventId } } });
      await db.admissionGrant.deleteMany({ where: { eventId } });
      await db.eventSupporter.deleteMany({ where: { eventId } });
      await db.entryReservationLine.deleteMany({ where: { reservation: { boardId } } });
      await db.entryReservation.deleteMany({ where: { boardId } });
      await db.square.deleteMany({ where: { boardId } });
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

    // ---- the guard ---------------------------------------------------------

    test("a clean board finalizes", async () => {
      await seed();
      const out = await closeBoard(boardId, { hostInitiated: true });
      assert.equal(out.ok && out.status, "closed");
      const b = await boardRow();
      assert.equal(b.status, "closed");
      assert.notEqual(b.finalRaisedCents, null, "the total sealed");
    });

    test("a pending reservation blocks a host-initiated close", async () => {
      await seed();
      await reserve();
      const out = await closeBoard(boardId, { hostInitiated: true });
      assert.equal(out.ok && out.status, "closing");
      assert.equal(out.ok && out.status === "closing" && out.blockedBy.reservations, 1);

      const b = await boardRow();
      assert.equal(b.status, "closing", "sales stopped");
      assert.equal(b.finalRaisedCents, null, "NOTHING SEALED");
    });

    // THE CASE THAT MATTERS MOST. On a scheduled close nobody is watching, and
    // the money may already be in the host's account.
    test("a pending reservation survives a SCHEDULED close and blocks it", async () => {
      await seed();
      const id = await reserve();
      const out = await closeBoard(boardId, { hostInitiated: false });
      assert.equal(out.ok && out.status, "closing");
      assert.equal(out.ok && out.status === "closing" && out.blockedBy.reservations, 1);

      const r = await db.entryReservation.findUniqueOrThrow({ where: { id } });
      assert.equal(r.status, "pending", "NOT auto-released");
      assert.equal(r.releasedAt, null);
      assert.equal((await boardRow()).finalRaisedCents, null);
    });

    // The asymmetry, stated as a test so nobody "fixes" it into consistency.
    test("a reserved_cash SQUARE still auto-releases on a scheduled close", async () => {
      await seed();
      await reservedSquare();
      const out = await closeBoard(boardId, { hostInitiated: false });
      assert.equal(out.ok && out.status, "closed", "nothing left to block it");
      const sq = await db.square.findFirstOrThrow({ where: { boardId } });
      assert.equal(sq.paymentStatus, "open", "released: a square proves no money moved");
      assert.equal(sq.releaseReason, "expired");
    });

    test("a reserved_cash square blocks a HOST-initiated close, as before", async () => {
      await seed();
      await reservedSquare();
      const out = await closeBoard(boardId, { hostInitiated: true });
      assert.equal(out.ok && out.status, "closing");
      assert.equal(out.ok && out.status === "closing" && out.blockedBy.awaiting, 1);
    });

    // ---- resolving unblocks it ---------------------------------------------

    test("releasing the reservation lets the board finalize", async () => {
      await seed();
      const id = await reserve();
      assert.equal(await closeStatus(true), "closing");

      const { releaseEntryReservation } = await import("./entry-reservation.ts");
      await db.$transaction((tx) =>
        releaseEntryReservation(tx, { reservationId: id, reason: "never arrived" })
      );

      const out = await closeBoard(boardId, { hostInitiated: true });
      assert.equal(out.ok && out.status, "closed");
      assert.equal((await boardRow()).finalRaisedCents, 0, "released money counts for nothing");
    });

    test("confirming the reservation lets it finalize, and the money counts", async () => {
      await seed();
      const id = await reserve();
      const { confirmEntryReservation } = await import("./entry-reservation.ts");
      await db.$transaction((tx) =>
        confirmEntryReservation(tx, { reservationId: id, hostId })
      );

      const out = await closeBoard(boardId, { hostInitiated: true });
      assert.equal(out.ok && out.status, "closed");
      // 2 child at $15. Confirmed before the seal, so it is in the total.
      assert.equal((await boardRow()).finalRaisedCents, 3000);
    });

    test("several reservations are counted, not collapsed", async () => {
      await seed();
      await reserve();
      await db.entryReservation.create({
        data: {
          boardId, eventId, referenceCode: "K93M5",
          contributorName: "Other", contributorEmail: "o@example.com",
          contributorPhone: "+16785550143", paymentRail: "zelle",
          lines: { create: [{ tier: "CHILD", priceBasis: "FLAT", unitPriceCents: 1500, quantity: 1 }] },
        },
      });
      const out = await closeBoard(boardId, { hostInitiated: true });
      assert.equal(out.ok && out.status === "closing" && out.blockedBy.reservations, 2);
    });

    // A resolved or released reservation is history and must not block forever.
    test("an already-resolved reservation does not block", async () => {
      await seed();
      const id = await reserve();
      const { releaseEntryReservation } = await import("./entry-reservation.ts");
      await db.$transaction((tx) =>
        releaseEntryReservation(tx, { reservationId: id, reason: "x" })
      );
      assert.equal(await closeStatus(true), "closed");
    });

    // ---- the boundary this guard does NOT cover ----------------------------
    //
    // KNOWN GAP, ASSERTED SO IT IS NOT MISTAKEN FOR COVERAGE. A pending
    // CONTRIBUTION - a declared cash donation, or a live Stripe checkout - is
    // invisible to every step of close and does not block finalization. That
    // is a separate defect on its own track, and it predates reservations
    // entirely. This test exists so nobody reads the reservation guard as
    // having closed it.
    test("a pending CONTRIBUTION still does not block — separate track", async () => {
      await seed();
      await db.contribution.create({
        data: {
          boardId,
          status: "pending",
          paymentMethod: "cash",
          squareAmountCents: 0,
          donationAmountCents: 2500,
          totalPaidCents: 2500,
          contributorName: "Donor",
          contributorEmail: "d@example.com",
        },
      });
      const out = await closeBoard(boardId, { hostInitiated: true });
      assert.equal(out.ok && out.status, "closed", "documents the gap, does not endorse it");
      assert.equal((await boardRow()).finalRaisedCents, 0, "the pending donation is not in it");
    });
  }
);
