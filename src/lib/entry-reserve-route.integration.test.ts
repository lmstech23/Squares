import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";

// The direct-payment Entry Ticket reservation route, against a REAL database.
//
// WHY THE ROUTE AND NOT A HELPER. Almost everything this change promises is a
// NEGATIVE — no Contribution, no supporter, no grant, no pass, no square — and
// a negative can only be proven by running the real handler against a real
// database and then looking at every table it might have touched. A test of an
// extracted helper would prove the helper.
//
// No Supabase mock: this route is contributor-facing and unauthenticated.
//
//   npm run test:db:up && npm run test:integration:reserve

const url = process.env.TEST_DATABASE_URL;
const prisma = url ? new PrismaClient({ datasources: { db: { url } } }) : null;

// Relative, with the extension, and GUARDED ON `url` — the same shape every
// other route test here uses. A bare `@/` specifier at module scope would break
// `npm test`, which runs this file without the alias loader and expects it to
// skip rather than fail to load.
const { POST } = url
  ? await import("../app/api/board/[slug]/entry/reserve/route.ts")
  : { POST: null as never };

const CUTOFF = new Date(Date.now() + 20 * 864e5);

describe(
  "entry reservation route (integration)",
  { skip: !url && "TEST_DATABASE_URL not set" },
  () => {
    const db = prisma!;
    let hostId = "";
    let boardId = "";
    let slug = "";

    async function seedBoard(over: Record<string, unknown> = {}) {
      slug = "res-" + randomUUID().slice(0, 8);
      const board = await db.board.create({
        data: {
          hostId,
          gameName: "Reserve Test",
          slug,
          boardType: "fundraiser",
          squarePrice: 5000,
          totalSquares: 0,
          timezone: "America/New_York",
          campaignEndsAt: new Date(Date.now() + 30 * 864e5),
          cashModeEnabled: true,
          hostZelle: "host@example.com",
          // What this board accepts. Zelle only - the route now requires the
          // rail to be listed AND the handle to exist.
          acceptedPaymentMethods: ["zelle"],
          entryChildPriceCents: 1500,
          entryAdultEarlyPriceCents: 4000,
          entryAdultRegularPriceCents: 5000,
          earlyBirdEndsAt: CUTOFF,
          ...over,
        },
      });
      boardId = board.boardId;
      await db.event.create({
        data: {
          boardId,
          startsAt: new Date(Date.now() + 40 * 864e5),
          timezone: "America/New_York",
        },
      });
      return board;
    }

    const call = async (body: Record<string, unknown>) => {
      const res = await POST(
        new Request("http://test/api", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
        { params: Promise.resolve({ slug }) }
      );
      return { status: res.status, data: await res.json() };
    };

    const goodBody = (over: Record<string, unknown> = {}) => ({
      lines: [
        { tier: "ADULT", quantity: 2 },
        { tier: "CHILD", quantity: 1 },
      ],
      buyerName: "Taylor Smith",
      buyerEmail: "taylor@example.com",
      buyerPhone: "678-555-0142",
      paymentRail: "zelle",
      ...over,
    });

    before(async () => {
      const host = await db.host.create({
        data: { email: "res-" + randomUUID() + "@example.com" },
      });
      hostId = host.id;
    });

    async function wipe() {
      if (!boardId) return;
      await db.entryReservationLine.deleteMany({
        where: { reservation: { boardId } },
      });
      await db.entryReservation.deleteMany({ where: { boardId } });
      await db.contribution.deleteMany({ where: { boardId } });
      await db.square.deleteMany({ where: { boardId } });
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

    // ---- the happy path, and what it must NOT have created -----------------

    test("reserves, locks the price per tier line, and returns a code", async () => {
      await seedBoard();
      const { status, data } = await call(goodBody());
      assert.equal(status, 200, JSON.stringify(data));

      assert.match(data.referenceCode, /^[0-9A-HJKMNP-TV-Z]{5}$/);
      assert.equal(data.totalCents, 2 * 4000 + 1500);
      assert.equal(data.handle, "host@example.com");
      assert.equal(data.railLabel, "Zelle");

      const rows = await db.entryReservationLine.findMany({
        where: { reservation: { boardId } },
        orderBy: { tier: "asc" },
      });
      assert.equal(rows.length, 2, "one line per tier, not one per pass");

      const adult = rows.find((r) => r.tier === "ADULT")!;
      const child = rows.find((r) => r.tier === "CHILD")!;
      assert.equal(adult.quantity, 2);
      assert.equal(adult.unitPriceCents, 4000);
      assert.equal(adult.priceBasis, "EARLY", "stored, so confirmation never re-quotes");
      assert.equal(child.quantity, 1);
      assert.equal(child.unitPriceCents, 1500);
      assert.equal(child.priceBasis, "FLAT");

      // Nothing is paid yet, and nothing claims to be.
      assert.equal(adult.quantityConfirmed, 0);
      assert.equal(adult.contributionId, null);
    });

    // THE CENTRAL ASSERTION OF THIS ROUTE. Everything it must not do.
    test("creates NO contribution, supporter, grant, pass or square", async () => {
      await seedBoard();
      const { status } = await call(goodBody());
      assert.equal(status, 200);

      assert.equal(await db.contribution.count({ where: { boardId } }), 0);
      assert.equal(await db.square.count({ where: { boardId } }), 0);

      const event = await db.event.findFirstOrThrow({ where: { boardId } });
      assert.equal(await db.eventSupporter.count({ where: { eventId: event.id } }), 0);
      assert.equal(await db.admissionGrant.count({ where: { eventId: event.id } }), 0);
      assert.equal(
        await db.admissionPass.count({ where: { supporter: { eventId: event.id } } }),
        0
      );
    });

    test("the reservation is pending, with no resolution timestamps", async () => {
      await seedBoard();
      await call(goodBody());
      const r = await db.entryReservation.findFirstOrThrow({ where: { boardId } });
      assert.equal(r.status, "pending");
      assert.equal(r.resolvedAt, null);
      assert.equal(r.releasedAt, null);
      assert.equal(r.paymentRail, "zelle");
    });

    // No hold, no expiry: an entry ticket blocks nobody, so two reservations
    // for the same tiers are simply two reservations.
    test("a second reservation is independent and gets its own code", async () => {
      await seedBoard();
      const a = await call(goodBody());
      const b = await call(goodBody({ buyerEmail: "other@example.com" }));
      assert.equal(a.status, 200);
      assert.equal(b.status, 200);
      assert.notEqual(a.data.referenceCode, b.data.referenceCode);
      assert.equal(await db.entryReservation.count({ where: { boardId } }), 2);
    });

    // ---- the help checkbox --------------------------------------------------
    //
    // The route's only job here is to keep the answer. It is read at CONFIRM,
    // where it is copied onto the AdmissionGrant — without this column the box
    // is ticked and the answer discarded, which is how both entry paths came to
    // record a definite "not interested" for people who had said yes.

    test("an opted-in reservation keeps the answer", async () => {
      await seedBoard();
      const res = await call(goodBody({ wantsToHelp: true }));
      assert.equal(res.status, 200);
      const r = await db.entryReservation.findFirstOrThrow({ where: { boardId } });
      assert.equal(r.wantsToHelp, true);
    });

    // AN ABSENT ANSWER AND A DECLINED ONE ARE THE SAME STORED VALUE, exactly as
    // they are on the grant and the ledger. A board with no sign-up sheet does
    // not render the checkbox and sends no field; that is not an error.
    test("an absent or false answer stores false, and is not an error", async () => {
      await seedBoard();
      assert.equal((await call(goodBody())).status, 200);
      const absent = await db.entryReservation.findFirstOrThrow({ where: { boardId } });
      assert.equal(absent.wantsToHelp, false);

      assert.equal(
        (await call(goodBody({ buyerEmail: "b@example.com", wantsToHelp: false }))).status,
        200
      );
      const explicit = await db.entryReservation.findFirstOrThrow({
        where: { boardId, contributorEmail: "b@example.com" },
      });
      assert.equal(explicit.wantsToHelp, false);
    });

    // COERCED, NOT VALIDATED. Anything but an explicit `true` is false, and
    // nothing is rejected: interest claims nothing (invariant 36), so a junk
    // value can only ever fail to show someone a sign-up link.
    test("a non-boolean answer is coerced to false, not rejected", async () => {
      await seedBoard();
      const res = await call(goodBody({ wantsToHelp: "yes please" }));
      assert.equal(res.status, 200);
      const r = await db.entryReservation.findFirstOrThrow({ where: { boardId } });
      assert.equal(r.wantsToHelp, false);
    });

    // ---- pricing ------------------------------------------------------------

    test("after the cutoff the adult line locks at the regular price", async () => {
      await seedBoard({ earlyBirdEndsAt: new Date(Date.now() - 864e5) });
      const { data } = await call(goodBody());
      assert.equal(data.totalCents, 2 * 5000 + 1500);
      const adult = await db.entryReservationLine.findFirstOrThrow({
        where: { reservation: { boardId }, tier: "ADULT" },
      });
      assert.equal(adult.priceBasis, "REGULAR");
      assert.equal(adult.unitPriceCents, 5000);
    });

    test("a tier the board does not offer is refused, never substituted", async () => {
      await seedBoard({
        entryAdultEarlyPriceCents: null,
        entryAdultRegularPriceCents: null,
      });
      const { status } = await call(goodBody({ lines: [{ tier: "ADULT", quantity: 1 }] }));
      assert.equal(status, 400);
      assert.equal(await db.entryReservation.count({ where: { boardId } }), 0);
    });

    // ---- guards -------------------------------------------------------------

    test("a board that is not open is refused", async () => {
      await seedBoard({ status: "closing" });
      const { status } = await call(goodBody());
      assert.equal(status, 409);
      assert.equal(await db.entryReservation.count({ where: { boardId } }), 0);
    });

    test("a campaign past its end date is refused even while status is open", async () => {
      await seedBoard({ campaignEndsAt: new Date(Date.now() - 864e5) });
      const { status } = await call(goodBody());
      assert.equal(status, 409);
      assert.equal(await db.entryReservation.count({ where: { boardId } }), 0);
    });

    test("a rail the host has not configured is refused, and named", async () => {
      await seedBoard();
      const { status, data } = await call(goodBody({ paymentRail: "venmo" }));
      assert.equal(status, 503);
      assert.match(data.error, /Venmo/);
      assert.equal(await db.entryReservation.count({ where: { boardId } }), 0);
    });

    test("direct payment switched off is refused", async () => {
      await seedBoard({ cashModeEnabled: false });
      const { status } = await call(goodBody());
      assert.equal(status, 403);
    });

    test("an unknown rail is refused", async () => {
      await seedBoard();
      assert.equal((await call(goodBody({ paymentRail: "bitcoin" }))).status, 400);
      assert.equal((await call(goodBody({ paymentRail: undefined }))).status, 400);
    });

    test("both identity keys are required", async () => {
      await seedBoard();
      assert.equal((await call(goodBody({ buyerName: "  " }))).status, 400);
      assert.equal((await call(goodBody({ buyerEmail: "nope" }))).status, 400);
      assert.equal((await call(goodBody({ buyerPhone: null }))).status, 400);
      assert.equal(await db.entryReservation.count({ where: { boardId } }), 0);
    });

    test("an empty or zero-quantity purchase is refused", async () => {
      await seedBoard();
      assert.equal((await call(goodBody({ lines: [] }))).status, 400);
      assert.equal(
        (await call(goodBody({ lines: [{ tier: "ADULT", quantity: 0 }] }))).status,
        400
      );
      assert.equal(await db.entryReservation.count({ where: { boardId } }), 0);
    });

    // A board with no entry pricing must be untouched by the whole feature.
    test("a board offering no entry tickets is refused", async () => {
      await seedBoard({
        entryChildPriceCents: null,
        entryAdultEarlyPriceCents: null,
        entryAdultRegularPriceCents: null,
      });
      const { status } = await call(goodBody());
      assert.equal(status, 400);
    });
  }
);
