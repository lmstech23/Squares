import { test, describe, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";

// Tender at the four confirm paths, THROUGH THE ROUTES, against a real
// database — payment-method addendum v1.2.6 §4.
//
// THE PICKER IS NOT THE BOUNDARY. It cannot offer CARD and cannot submit an
// empty selection, but that is UX. The integrity boundary is the route, and the
// only way to know a route holds on its own is to send it something the picker
// can never produce. Every rejection case below bypasses the client entirely
// and posts the body by hand.
//
// GAME DAY CONFIRMS WITH NO TENDER, and that case is pinned here on purpose.
// The confirm-cash branch is conditional on board type; a conditional with no
// test is what someone simplifies away later without knowing why it existed.
//
//   npm run test:db:up && npm run test:integration:tender

const url = process.env.TEST_DATABASE_URL;
const prisma = url ? new PrismaClient({ datasources: { db: { url } } }) : null;

let currentHost: { id: string } | null = null;

if (url) {
  mock.module("@/lib/auth", {
    namedExports: {
      getHost: async () => currentHost,
      // BOTH RESOLVERS: requireBoardAccess uses the non-redirecting one, and a
      // mock providing only getHost fails at import.
      getHostOrNull: async () => currentHost,
    },
  });
}

const cashDonation = url
  ? await import("../app/api/host/boards/[id]/cash-donation/route.ts")
  : ({} as never);
const confirmCash = url
  ? await import("../app/api/host/boards/[id]/confirm-cash/route.ts")
  : ({} as never);
const entryReservation = url
  ? await import("../app/api/host/boards/[id]/entry-reservation/route.ts")
  : ({} as never);

const MISSING = /Choose how the money arrived/;
const CARD_REFUSED = /Card is not a host-recorded method/;

describe(
  "tender at the four confirm paths (integration)",
  { skip: !url && "TEST_DATABASE_URL not set" },
  () => {
    const db = prisma!;
    let hostId = "";
    let boardId = "";
    let gameBoardId = "";
    let eventId = "";

    const PRICE = 5000;

    function req(id: string, path: string, method: string, body: unknown) {
      return new Request(`http://localhost/api/host/boards/${id}/${path}`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    }
    const params = (id: string) => ({ params: Promise.resolve({ id }) });

    const recordDonation = async (body: unknown, id = boardId) => {
      const res = await cashDonation.POST(req(id, "cash-donation", "POST", body), params(id));
      assert.ok(res, "the route returned no response");
      return { status: res.status, json: await res.json() };
    };
    const confirmDeclared = async (body: unknown, id = boardId) => {
      const res = await cashDonation.PATCH(req(id, "cash-donation", "PATCH", body), params(id));
      assert.ok(res, "the route returned no response");
      return { status: res.status, json: await res.json() };
    };
    const confirmSquare = async (body: unknown, id = boardId) => {
      const res = await confirmCash.POST(req(id, "confirm-cash", "POST", body), params(id));
      assert.ok(res, "the route returned no response");
      return { status: res.status, json: await res.json() };
    };
    const resolveReservation = async (body: unknown, id = boardId) => {
      const res = await entryReservation.PATCH(
        req(id, "entry-reservation", "PATCH", body),
        params(id)
      );
      assert.ok(res, "the route returned no response");
      return { status: res.status, json: await res.json() };
    };

    /** A board plus the OWNER grant: since the authorization switch, the
     *  collaborator row is what answers "may they act". */
    async function seedBoard(boardType: "fundraiser" | "game") {
      const board = await db.board.create({
        data: {
          hostId,
          gameName: boardType === "game" ? "Tender Game Day" : "Tender Fundraiser",
          slug: "tdr-" + randomUUID().slice(0, 8),
          boardType,
          acceptedPaymentMethods: boardType === "game" ? [] : ["card", "zelle"],
          hostZelle: boardType === "game" ? null : "host@example.invalid",
          squarePrice: PRICE,
          totalSquares: 6,
          cashModeEnabled: true,
          ...(boardType === "fundraiser"
            ? {
                timezone: "America/New_York",
                campaignEndsAt: new Date(Date.now() + 30 * 864e5),
              }
            : { teamRow: "Ravens", teamCol: "Falcons" }),
        },
      });
      await db.boardCollaborator.create({
        data: {
          boardId: board.boardId,
          hostId,
          role: "OWNER",
          status: "active",
          acceptedAt: new Date(),
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

    /** One square as cash-reserve leaves it. */
    async function reserveSquare(id: string) {
      const sq = await db.square.findFirstOrThrow({
        where: { boardId: id, paymentStatus: "open" },
        orderBy: { position: "asc" },
      });
      await db.square.update({
        where: { squareId: sq.squareId },
        data: {
          paymentStatus: "reserved_cash",
          paymentMethod: "cash",
          playerName: "Earl",
          playerEmail: "earl@example.invalid",
          pricePaidCents: PRICE,
        },
      });
      return sq.squareId;
    }

    /** A donation the CONTRIBUTOR declared: pending, offline, donation-only. */
    async function declaredDonation() {
      const row = await db.contribution.create({
        data: {
          boardId,
          status: "pending",
          settlement: "OFFLINE",
          squareAmountCents: 0,
          donationAmountCents: 2500,
          totalPaidCents: 2500,
          contributorName: "Dana Declared",
          contributorEmail: "dana@example.invalid",
          contributorPhone: "+16785550142",
          paymentRail: "zelle",
        },
        select: { id: true },
      });
      return row.id;
    }

    /** 2 adult early at $40 + 1 child at $15 = $95, plus a $25 donation. */
    async function pendingReservation() {
      const r = await db.entryReservation.create({
        data: {
          boardId,
          eventId,
          referenceCode: "T" + randomUUID().replace(/[^0-9A-HJ-NP-TV-Z]/gi, "").slice(0, 4).toUpperCase(),
          contributorName: "Taylor Reserved",
          contributorEmail: "taylor@example.invalid",
          contributorPhone: "+16785550143",
          paymentRail: "zelle",
          donationAmountCents: 2500,
          lines: {
            create: [
              { tier: "ADULT", priceBasis: "EARLY", unitPriceCents: 4000, quantity: 2 },
              { tier: "CHILD", priceBasis: "FLAT", unitPriceCents: 1500, quantity: 1 },
            ],
          },
        },
        select: { id: true },
      });
      return r.id;
    }

    before(async () => {
      const host = await db.host.create({
        data: { email: "tender-" + randomUUID() + "@example.invalid" },
      });
      hostId = host.id;
      currentHost = { id: hostId };
      boardId = await seedBoard("fundraiser");
      gameBoardId = await seedBoard("game");
      const event = await db.event.create({
        data: {
          boardId,
          startsAt: new Date(Date.now() + 40 * 864e5),
          timezone: "America/New_York",
        },
      });
      eventId = event.id;
    });

    after(async () => {
      for (const id of [boardId, gameBoardId]) {
        if (!id) continue;
        await db.checkInLog.deleteMany({ where: { event: { boardId: id } } });
        await db.admissionPass.deleteMany({ where: { supporter: { event: { boardId: id } } } });
        await db.admissionGrant.deleteMany({ where: { event: { boardId: id } } });
        await db.eventSupporter.deleteMany({ where: { event: { boardId: id } } });
        await db.entryReservationLine.deleteMany({ where: { reservation: { boardId: id } } });
        await db.entryReservation.deleteMany({ where: { boardId: id } });
        await db.paymentReference.deleteMany({ where: { square: { boardId: id } } });
        await db.square.updateMany({ where: { boardId: id }, data: { contributionId: null } });
        await db.contribution.deleteMany({ where: { boardId: id } });
        await db.square.deleteMany({ where: { boardId: id } });
        await db.event.deleteMany({ where: { boardId: id } });
        await db.boardCollaborator.deleteMany({ where: { boardId: id } });
        await db.board.deleteMany({ where: { boardId: id } });
      }
      if (hostId) await db.host.deleteMany({ where: { id: hostId } });
      await db.$disconnect();
    });

    // ---- 1. Record donation — cash-donation POST ---------------------------

    test("record donation: a missing tender is refused by the route", async () => {
      const before = await db.contribution.count({ where: { boardId } });
      const out = await recordDonation({
        amountCents: 4000,
        donorName: "No Tender",
        donorEmail: "nt@example.invalid",
        donorPhone: "+16785550144",
      });
      assert.equal(out.status, 400);
      assert.match(out.json.error, MISSING);
      assert.equal(await db.contribution.count({ where: { boardId } }), before, "nothing was written");
    });

    test("record donation: CARD is refused by the route, with the picker bypassed", async () => {
      const out = await recordDonation({
        amountCents: 4000,
        donorName: "Card Attempt",
        donorEmail: "ca@example.invalid",
        donorPhone: "+16785550145",
        tender: "CARD",
      });
      assert.equal(out.status, 400);
      assert.match(out.json.error, CARD_REFUSED);
    });

    test("record donation: the tender, reference and recordedAt land on the row", async () => {
      const out = await recordDonation({
        amountCents: 4000,
        donorName: "Zelle Donor",
        donorEmail: "zd@example.invalid",
        donorPhone: "+16785550146",
        tender: "ZELLE",
        tenderReference: "memo 8891",
      });
      assert.equal(out.status, 200);
      const row = await db.contribution.findUniqueOrThrow({
        where: { id: out.json.contributionId },
      });
      assert.equal(row.tender, "ZELLE");
      assert.equal(row.tenderReference, "memo 8891");
      assert.notEqual(row.recordedAt, null);
      assert.equal(row.recordedByHostId, hostId);
      assert.equal(row.settlement, "OFFLINE");
      assert.equal(row.status, "confirmed");
    });

    // A DISPLAY RULE, NOT A DATA RULE. The picker hides the reference field for
    // cash; the route must still accept one, because an M4 correction can
    // legitimately produce a cash row with a note.
    test("record donation: a reference on a CASH row is accepted by the route", async () => {
      const out = await recordDonation({
        amountCents: 1500,
        donorName: "Cash With Note",
        donorEmail: "cwn@example.invalid",
        donorPhone: "+16785550147",
        tender: "CASH",
        tenderReference: "envelope from the bake sale",
      });
      assert.equal(out.status, 200);
      const row = await db.contribution.findUniqueOrThrow({
        where: { id: out.json.contributionId },
      });
      assert.equal(row.tender, "CASH");
      assert.equal(row.tenderReference, "envelope from the bake sale");
    });

    // ---- 2. Confirm a declared donation — cash-donation PATCH --------------

    test("confirm declared donation: a missing tender is refused and the row stays pending", async () => {
      const id = await declaredDonation();
      const out = await confirmDeclared({ contributionId: id });
      assert.equal(out.status, 400);
      assert.match(out.json.error, MISSING);
      const row = await db.contribution.findUniqueOrThrow({ where: { id } });
      assert.equal(row.status, "pending");
      assert.equal(row.tender, null);
    });

    test("confirm declared donation: CARD is refused and the row stays pending", async () => {
      const id = await declaredDonation();
      const out = await confirmDeclared({ contributionId: id, tender: "CARD" });
      assert.equal(out.status, 400);
      assert.match(out.json.error, CARD_REFUSED);
      const row = await db.contribution.findUniqueOrThrow({ where: { id } });
      assert.equal(row.status, "pending");
    });

    test("confirm declared donation: the tender lands on that row, and the declared rail is untouched", async () => {
      const id = await declaredDonation();
      const out = await confirmDeclared({
        contributionId: id,
        tender: "CASH",
        tenderReference: "  two twenties  ",
      });
      assert.equal(out.status, 200);
      const row = await db.contribution.findUniqueOrThrow({ where: { id } });
      assert.equal(row.status, "confirmed");
      assert.equal(row.tender, "CASH");
      assert.equal(row.tenderReference, "two twenties", "trimmed");
      assert.notEqual(row.recordedAt, null);
      // THE DISAGREEMENT IS THE INFORMATION: declared Zelle, handed over cash.
      assert.equal(row.paymentRail, "zelle");
      // Nobody recorded this row - the contributor declared it - so the
      // recorder stays null and is not invented at confirmation.
      assert.equal(row.recordedByHostId, null);
      assert.equal(row.confirmedByHostId, hostId);
    });

    // ---- 3. Confirm a cash-reserved square — confirm-cash POST -------------

    test("confirm square: a missing tender is refused and the square stays reserved", async () => {
      const squareId = await reserveSquare(boardId);
      const out = await confirmSquare({ squareId });
      assert.equal(out.status, 400);
      assert.match(out.json.error, MISSING);
      const sq = await db.square.findUniqueOrThrow({ where: { squareId } });
      assert.equal(sq.paymentStatus, "reserved_cash");
    });

    test("confirm square: CARD is refused and the square stays reserved", async () => {
      const squareId = await reserveSquare(boardId);
      const out = await confirmSquare({ squareId, tender: "CARD" });
      assert.equal(out.status, 400);
      assert.match(out.json.error, CARD_REFUSED);
      const sq = await db.square.findUniqueOrThrow({ where: { squareId } });
      assert.equal(sq.paymentStatus, "reserved_cash");
    });

    test("confirm square: the tender lands on the contribution written for that square", async () => {
      const squareId = await reserveSquare(boardId);
      const out = await confirmSquare({
        squareId,
        tender: "CHECK",
        tenderReference: "check 1042",
      });
      assert.equal(out.status, 200);
      const sq = await db.square.findUniqueOrThrow({ where: { squareId } });
      assert.equal(sq.paymentStatus, "paid");
      assert.ok(sq.contributionId, "the square points at its ledger row");
      const row = await db.contribution.findUniqueOrThrow({
        where: { id: sq.contributionId! },
      });
      assert.equal(row.tender, "CHECK");
      assert.equal(row.tenderReference, "check 1042");
      assert.notEqual(row.recordedAt, null);
      assert.equal(row.recordedByHostId, hostId);
      assert.equal(row.squareAmountCents, PRICE);
    });

    // ---- 4. Confirm an entry reservation — entry-reservation PATCH ---------

    test("confirm reservation: a missing tender is refused and it stays pending", async () => {
      const id = await pendingReservation();
      const out = await resolveReservation({ reservationId: id, action: "confirm" });
      assert.equal(out.status, 400);
      assert.match(out.json.error, MISSING);
      const r = await db.entryReservation.findUniqueOrThrow({ where: { id } });
      assert.equal(r.status, "pending");
    });

    test("confirm reservation: CARD is refused and it stays pending", async () => {
      const id = await pendingReservation();
      const out = await resolveReservation({
        reservationId: id,
        action: "confirm",
        tender: "CARD",
      });
      assert.equal(out.status, 400);
      assert.match(out.json.error, CARD_REFUSED);
      const r = await db.entryReservation.findUniqueOrThrow({ where: { id } });
      assert.equal(r.status, "pending");
    });

    // ONE TENDER FOR THE WHOLE RESERVATION: every line resolves into one
    // contribution, so the selection covers all three passes and the donation.
    test("confirm reservation: one tender lands on the single contribution for every line", async () => {
      const id = await pendingReservation();
      const out = await resolveReservation({
        reservationId: id,
        action: "confirm",
        tender: "VENMO",
        tenderReference: "@taylor",
      });
      assert.equal(out.status, 200);
      const row = await db.contribution.findUniqueOrThrow({
        where: { id: out.json.contributionId },
      });
      assert.equal(row.tender, "VENMO");
      assert.equal(row.tenderReference, "@taylor");
      assert.notEqual(row.recordedAt, null);
      assert.equal(row.recordedByHostId, hostId);
      assert.equal(row.entryAmountCents, 9500);
      assert.equal(row.donationAmountCents, 2500);
      const lines = await db.entryReservationLine.findMany({ where: { reservationId: id } });
      assert.ok(
        lines.every((l) => l.contributionId === row.id),
        "every line points at the one contribution the tender is on"
      );
    });

    // ---- 5. Game Day is out of scope and stays that way --------------------

    // THE CONDITIONAL THIS PINS. confirm-cash asks for a tender only on a
    // fundraiser board, because Game Day writes no contribution for a tender to
    // live on. Without this test the branch reads like an oversight.
    test("Game Day: confirming a cash square succeeds with no tender, and writes no contribution", async () => {
      const squareId = await reserveSquare(gameBoardId);
      const out = await confirmSquare({ squareId }, gameBoardId);
      assert.equal(out.status, 200, JSON.stringify(out.json));
      const sq = await db.square.findUniqueOrThrow({ where: { squareId } });
      assert.equal(sq.paymentStatus, "paid");
      assert.equal(
        await db.contribution.count({ where: { boardId: gameBoardId } }),
        0,
        "Game Day writes no ledger row, which is why it needs no tender"
      );
    });
  }
);
