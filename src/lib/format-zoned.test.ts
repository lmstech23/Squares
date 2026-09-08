import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { formatZoned, parseZoned } from "./zoned-time.ts";

// `formatZoned` is the inverse of `parseZoned`, and it exists because getting
// only one direction right is worse than getting neither.
//
// THE DEFECT IT REPLACES. The sign-up slot editor refilled its form with
// `iso.slice(0, 16)`, which drops the trailing `Z` and hands the UTC wall clock
// to a local-time input. That round-trips consistently, so the form looked
// correct — while every list rendering the same instant through `Intl` in the
// event's zone disagreed with it by the zone's offset. Four production shifts
// were stored four hours off before anyone noticed, because the only screen
// that showed the error was the public one.

const NY = "America/New_York";

describe("formatZoned — the wall clock a person in the zone reads", () => {
  test("an afternoon instant splits into date and time", () => {
    // 3:00 PM EDT on the Hampton event day.
    const at = new Date("2026-10-24T19:00:00.000Z");
    assert.deepEqual(formatZoned(at, NY), { date: "2026-10-24", time: "15:00" });
  });

  // THE SHAPE OF THE BUG, as an assertion. The slice returns the UTC clock;
  // formatZoned returns the zone's. They differ by the offset, and the second
  // one is what the host typed.
  test("it does NOT return the UTC wall clock", () => {
    const iso = "2026-10-24T09:11:00.000Z";
    assert.equal(iso.slice(11, 16), "09:11", "what the old form showed");
    assert.equal(formatZoned(new Date(iso), NY)!.time, "05:11", "what volunteers saw");
  });

  // `hourCycle: "h23"` is load-bearing. Without it en-US renders midnight as
  // "24", which is not a valid `type="time"` value and blanks the field.
  test("midnight is 00:00, never 24:00", () => {
    const at = new Date("2026-10-24T04:00:00.000Z"); // midnight EDT
    assert.deepEqual(formatZoned(at, NY), { date: "2026-10-24", time: "00:00" });
  });

  test("the date rolls with the zone, not with UTC", () => {
    // 8:00 PM EDT on Oct 24 is Oct 25 in UTC. The host's date is the 24th.
    const at = new Date("2026-10-25T00:00:00.000Z");
    assert.deepEqual(formatZoned(at, NY), { date: "2026-10-24", time: "20:00" });
  });

  test("null, invalid dates and invalid zones return null", () => {
    assert.equal(formatZoned(null, NY), null);
    assert.equal(formatZoned(undefined, NY), null);
    assert.equal(formatZoned(new Date("nonsense"), NY), null);
    assert.equal(formatZoned(new Date(), "Not/AZone"), null);
  });
});

describe("round trip — what a host types comes back unchanged", () => {
  // THE PROPERTY THAT MATTERS TO A HOST. Type a time, save it, reopen the form:
  // the box must refill with the same time, and the list must show that time.
  const cases: [string, string][] = [
    ["2026-10-24", "15:00"],
    ["2026-10-24", "00:00"],
    ["2026-10-24", "23:59"],
    ["2026-01-15", "09:30"], // EST, not EDT
    ["2026-07-04", "18:45"],
  ];

  for (const [date, time] of cases) {
    test(`${date} ${time} survives parse then format`, () => {
      const stored = parseZoned(`${date}T${time}`, NY, "earlier");
      assert.ok(stored, "parsed");
      assert.deepEqual(formatZoned(stored, NY), { date, time });
    });
  }

  test("a whole-day sweep round-trips in both offsets", () => {
    for (const day of ["2026-01-15", "2026-07-04", "2026-10-24"]) {
      for (let h = 0; h < 24; h++) {
        const time = `${String(h).padStart(2, "0")}:30`;
        const stored = parseZoned(`${day}T${time}`, NY, "earlier");
        assert.ok(stored, `${day} ${time} parsed`);
        assert.deepEqual(formatZoned(stored, NY), { date: day, time }, `${day} ${time}`);
      }
    }
  });
});

describe("DST — the two days a wall clock is not a single instant", () => {
  // SPRING FORWARD, 2026-03-08. 2:30 AM does not exist. parseZoned always
  // shifts forward, so the stored instant reads back as 3:30 AM. The round trip
  // is deliberately NOT identity here: the time the host asked for was not a
  // time, and 3:30 is the honest answer.
  test("a nonexistent 2:30 AM comes back as 3:30 AM", () => {
    const stored = parseZoned("2026-03-08T02:30", NY, "earlier");
    assert.ok(stored);
    assert.deepEqual(formatZoned(stored, NY), { date: "2026-03-08", time: "03:30" });
  });

  // FALL BACK, 2026-11-01. 1:30 AM happens twice, an hour apart.
  test("an ambiguous 1:30 AM round-trips as 1:30 either way", () => {
    const earlier = parseZoned("2026-11-01T01:30", NY, "earlier");
    const later = parseZoned("2026-11-01T01:30", NY, "later");
    assert.ok(earlier && later);
    assert.notEqual(earlier.getTime(), later.getTime(), "two distinct instants");
    assert.equal(later.getTime() - earlier.getTime(), 3600_000, "one hour apart");

    // Both read back as the same wall clock — which is the whole point of the
    // ambiguity: the clock cannot tell you which one it is.
    assert.deepEqual(formatZoned(earlier, NY), { date: "2026-11-01", time: "01:30" });
    assert.deepEqual(formatZoned(later, NY), { date: "2026-11-01", time: "01:30" });
  });

  // THE SHIFT POLICY, asserted as arithmetic rather than as a comment.
  //
  // A shift takes the EARLIER start and the LATER end. On the fall-back night
  // that is the only pairing that cannot open a hole in coverage: 1:00 to 2:00
  // is two real hours of staffing, because the hour is lived twice. Any other
  // pairing shortens it, and one of them makes it negative.
  test("earlier start + later end is the only pairing that never shortens a shift", () => {
    const start = parseZoned("2026-11-01T01:00", NY, "earlier")!;
    const end = parseZoned("2026-11-01T02:00", NY, "later")!;
    assert.equal(end.getTime() - start.getTime(), 2 * 3600_000, "two real hours");

    // The inverted policy would have staffed one hour of a two-hour night.
    const naiveStart = parseZoned("2026-11-01T01:00", NY, "later")!;
    assert.equal(end.getTime() - naiveStart.getTime(), 3600_000, "half the coverage");
  });

  test("a shift on the spring-forward night is one hour shorter, correctly", () => {
    const start = parseZoned("2026-03-08T01:00", NY, "earlier")!;
    const end = parseZoned("2026-03-08T04:00", NY, "later")!;
    // 1:00 to 4:00 on the wall clock is two real hours: 2am never happened.
    assert.equal(end.getTime() - start.getTime(), 2 * 3600_000);
  });
});

describe("the event-date prefill", () => {
  // The page computes the prefill as formatZoned(event.startsAt).date. An
  // evening event must not prefill the NEXT day, which is what a UTC-derived
  // date would do for anything after 8 PM Eastern.
  test("an 8 PM event prefills its own day, not tomorrow", () => {
    const eventStartsAt = new Date("2026-10-25T00:00:00.000Z"); // 8 PM EDT Oct 24
    assert.equal(formatZoned(eventStartsAt, NY)!.date, "2026-10-24");
    assert.notEqual(eventStartsAt.toISOString().slice(0, 10), "2026-10-24");
  });

  test("the Hampton event prefills Oct 24", () => {
    const eventStartsAt = new Date("2026-10-24T15:00:00.000Z"); // 11 AM EDT
    assert.equal(formatZoned(eventStartsAt, NY)!.date, "2026-10-24");
  });
});
