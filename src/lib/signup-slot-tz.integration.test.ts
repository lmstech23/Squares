import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";

// What a host TYPES versus what gets STORED, through the real routes and a real
// database.
//
// THE DEFECT. Both slot routes did `new Date(body.startsAt)` on a bare
// `datetime-local` string. That reads the wall clock as the RUNTIME's zone,
// which on Vercel is UTC — so 3:00 PM typed by a host in New York was stored as
// 3:00 PM UTC and rendered back to volunteers, correctly through `Intl`, as
// 11:00 AM. Four production shifts across four boards were written that way,
// every one off by exactly the zone's offset.
//
// The form looked right the whole time, because the editor refilled itself with
// `iso.slice(0, 16)` — the same UTC clock it had written. Only the public sheet
// disagreed. That is why these assertions are about STORED INSTANTS and about
// what a volunteer would read, never about what the form echoes back.
//
//   npm run test:db:up && npm run test:integration:slot-tz

const url = process.env.TEST_DATABASE_URL;
const prisma = url ? new PrismaClient({ datasources: { db: { url } } }) : null;

const mod = url ? await import("./zoned-time.ts") : ({} as never);
const { parseZoned, formatZoned } = mod;

const NY = "America/New_York";

describe(
  "sign-up slot timezone (integration)",
  { skip: !url && "TEST_DATABASE_URL not set" },
  () => {
    const db = prisma!;
    let hostId = "";
    let boardId = "";
    let eventId = "";
    let sheetId = "";

    async function seed(timezone = NY) {
      const board = await db.board.create({
        data: {
          hostId,
          gameName: "Slot TZ",
          slug: "stz-" + randomUUID().slice(0, 8),
          boardType: "fundraiser",
          squarePrice: 5000,
          totalSquares: 0,
          timezone,
          acceptedPaymentMethods: ["zelle"],
          hostZelle: "host@example.com",
        },
      });
      boardId = board.boardId;
      const ev = await db.event.create({
        data: {
          boardId,
          // 11:00 AM in the board's zone on the event day.
          startsAt: new Date("2026-10-24T15:00:00.000Z"),
          timezone,
        },
      });
      eventId = ev.id;
      const sheet = await db.signupSheet.create({
        data: { eventId, title: "Volunteer Sign-Up" },
      });
      sheetId = sheet.id;
    }

    /**
     * What the route does with a form submission, exercised through the same
     * parse the route uses rather than through HTTP — the routes call getHost()
     * and there is no session here. The PARSE is the thing that was broken; the
     * write below is the route's, verbatim.
     */
    async function createShift(
      name: string,
      date: string,
      start: string,
      end: string | null,
      timezone = NY
    ) {
      const startsAt = parseZoned(`${date}T${start}`, timezone, "earlier");
      const endsAt = end ? parseZoned(`${date}T${end}`, timezone, "later") : null;
      return db.signupSlot.create({
        data: { sheetId, slotType: "SHIFT", name, capacity: 2, startsAt, endsAt, sortOrder: 0 },
      });
    }

    /** Exactly what `timeLabel` in the host panel and the public sheet render. */
    const asVolunteerSees = (d: Date | null, timezone = NY) =>
      d
        ? new Intl.DateTimeFormat("en-US", {
            month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
            timeZone: timezone,
          }).format(d)
        : "";

    before(async () => {
      const h = await db.host.create({
        data: { email: "stz-" + randomUUID() + "@example.com" },
      });
      hostId = h.id;
    });

    async function wipe() {
      if (!boardId) return;
      await db.signupSlot.deleteMany({ where: { sheet: { eventId } } });
      await db.signupSheet.deleteMany({ where: { eventId } });
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

    // ---- create -------------------------------------------------------------

    // THE REGRESSION, stated as the host's own sentence. This failed before the
    // fix: it stored 19:00Z and volunteers were told 3:00 PM... in UTC, which
    // reads as 11:00 AM Eastern.
    test("3:00 PM typed by the host is 3:00 PM to a volunteer", async () => {
      await seed();
      const slot = await createShift("Main gate", "2026-10-24", "15:00", "18:00");

      assert.equal(slot.startsAt!.toISOString(), "2026-10-24T19:00:00.000Z");
      assert.match(asVolunteerSees(slot.startsAt), /3:00 PM/);
      assert.match(asVolunteerSees(slot.endsAt), /6:00 PM/);
    });

    // The exact shape of the four production rows, asserted so it cannot come
    // back: the stored UTC clock must NOT equal the typed wall clock.
    test("the stored UTC clock is NOT the typed wall clock", async () => {
      await seed();
      const slot = await createShift("Check-in", "2026-10-24", "09:11", "12:11");

      assert.notEqual(slot.startsAt!.toISOString().slice(11, 16), "09:11",
        "storing the typed clock verbatim is the bug");
      assert.equal(slot.startsAt!.toISOString(), "2026-10-24T13:11:00.000Z");
      assert.match(asVolunteerSees(slot.startsAt), /9:11 AM/);
    });

    test("an open-ended shift stores a start and no end", async () => {
      await seed();
      const slot = await createShift("Cleanup", "2026-10-24", "20:00", null);
      assert.equal(slot.startsAt!.toISOString(), "2026-10-25T00:00:00.000Z");
      assert.equal(slot.endsAt, null);
      assert.match(asVolunteerSees(slot.startsAt), /Oct 24, 8:00 PM/);
    });

    // An evening shift crosses the UTC date line. The volunteer's day must not.
    test("an 8 PM shift is still on the event day for a volunteer", async () => {
      await seed();
      const slot = await createShift("Late gate", "2026-10-24", "20:00", "23:00");
      assert.equal(slot.startsAt!.toISOString().slice(0, 10), "2026-10-25", "UTC has rolled");
      assert.equal(formatZoned(slot.startsAt, NY)!.date, "2026-10-24", "the host's day has not");
    });

    // ---- edit ---------------------------------------------------------------

    // THE OTHER HALF. The editor refilled from the raw ISO string, so opening a
    // correctly-stored slot showed the UTC clock — and saving it again would
    // shift it a second time. Fixing only the route would have made this worse.
    test("the edit box refills with the time the list shows", async () => {
      await seed();
      const slot = await createShift("Main gate", "2026-10-24", "15:00", "18:00");

      const refill = formatZoned(slot.startsAt, NY)!;
      assert.deepEqual(refill, { date: "2026-10-24", time: "15:00" });
      assert.match(asVolunteerSees(slot.startsAt), /3:00 PM/);

      // The old behaviour, kept as a comparison so the difference is explicit.
      assert.equal(slot.startsAt!.toISOString().slice(11, 16), "19:00");
      assert.notEqual(slot.startsAt!.toISOString().slice(11, 16), refill.time);
    });

    // Re-saving an untouched slot must be a no-op. Under the old pairing it
    // moved the time by the offset on every save.
    test("editing without changing the time does not move it", async () => {
      await seed();
      const slot = await createShift("Main gate", "2026-10-24", "15:00", "18:00");
      const before = slot.startsAt!.toISOString();

      // What the form now sends back after a name-only edit.
      const refill = formatZoned(slot.startsAt, NY)!;
      const resaved = parseZoned(`${refill.date}T${refill.time}`, NY, "earlier");

      assert.equal(resaved!.toISOString(), before, "idempotent");
    });

    test("ten consecutive re-saves do not drift", async () => {
      await seed();
      const slot = await createShift("Main gate", "2026-10-24", "15:00", "18:00");
      let at = slot.startsAt!;
      for (let i = 0; i < 10; i++) {
        const r = formatZoned(at, NY)!;
        at = parseZoned(`${r.date}T${r.time}`, NY, "earlier")!;
      }
      assert.equal(at.toISOString(), "2026-10-24T19:00:00.000Z");
    });

    // ---- other zones --------------------------------------------------------

    test("a board in another zone stores that zone's wall clock", async () => {
      await seed("America/Los_Angeles");
      const slot = await createShift("Gate", "2026-10-24", "15:00", null, "America/Los_Angeles");
      assert.equal(slot.startsAt!.toISOString(), "2026-10-24T22:00:00.000Z");
      assert.match(asVolunteerSees(slot.startsAt, "America/Los_Angeles"), /3:00 PM/);
    });

    // ---- DST ----------------------------------------------------------------

    test("a shift on the fall-back night is two real hours, not one", async () => {
      await seed();
      const slot = await createShift("Overnight", "2026-11-01", "01:00", "02:00");
      assert.equal(
        slot.endsAt!.getTime() - slot.startsAt!.getTime(),
        2 * 3600_000,
        "the hour is lived twice and both are staffed"
      );
    });

    test("a shift starting in the spring-forward gap moves forward, not back", async () => {
      await seed();
      const slot = await createShift("Early", "2026-03-08", "02:30", null);
      assert.equal(formatZoned(slot.startsAt, NY)!.time, "03:30");
      assert.ok(slot.startsAt!.getTime() > Date.parse("2026-03-08T06:00:00.000Z"));
    });

    // ---- the CHECK constraints still hold ------------------------------------

    test("a SHIFT with no start is refused by the database", async () => {
      await seed();
      await assert.rejects(
        () =>
          db.signupSlot.create({
            data: { sheetId, slotType: "SHIFT", name: "No time", capacity: 1, sortOrder: 0 },
          }),
        /constraint/i,
        "the S1 CHECK is the backstop and is unchanged"
      );
    });

    test("an ITEM carrying a time is refused by the database", async () => {
      await seed();
      await assert.rejects(
        () =>
          db.signupSlot.create({
            data: {
              sheetId, slotType: "ITEM", name: "Water", capacity: 1, sortOrder: 0,
              startsAt: new Date("2026-10-24T19:00:00.000Z"),
            },
          }),
        /constraint/i
      );
    });
  }
);
