import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseZoned, tzOffsetMs } from "./zoned-time.ts";

const NY = "America/New_York";
const HOUR = 60 * 60 * 1000;

/** Asserts the parsed instant equals an expected UTC ISO string. */
function expectUtc(local: string, zone: string, iso: string) {
  const d = parseZoned(local, zone);
  assert.ok(d, `expected ${local} in ${zone} to parse`);
  assert.equal(d.toISOString(), iso);
}

describe("parseZoned", () => {
  test("resolves a wall clock in the given zone, not the server's", () => {
    // The bug this exists to prevent: on a UTC server, new Date("2026-10-24T19:00")
    // is 19:00Z. In New York that wall clock is 23:00Z — four hours later.
    expectUtc("2026-10-24T19:00", NY, "2026-10-24T23:00:00.000Z");
  });

  test("summer uses EDT (UTC-4)", () => {
    expectUtc("2026-07-01T12:00", NY, "2026-07-01T16:00:00.000Z");
  });

  test("winter uses EST (UTC-5)", () => {
    expectUtc("2026-01-15T12:00", NY, "2026-01-15T17:00:00.000Z");
  });

  test("a campaign closing after the fall DST change uses EST, not EDT", () => {
    // US DST ends Nov 1, 2026. A fall campaign entered in October must not
    // carry the summer offset into November — that is a one-hour error on the
    // field that closes the board.
    expectUtc("2026-11-15T23:59", NY, "2026-11-16T04:59:00.000Z");
  });

  test("the same wall clock either side of the fall boundary differs by an hour in UTC", () => {
    const before = parseZoned("2026-10-31T12:00", NY)!; // EDT, UTC-4
    const after = parseZoned("2026-11-02T12:00", NY)!; // EST, UTC-5
    const daysApart = 2 * 24 * HOUR;
    assert.equal(after.getTime() - before.getTime(), daysApart + HOUR);
  });

  test("the same wall clock either side of the spring boundary differs by an hour", () => {
    // US DST begins Mar 8, 2026.
    const before = parseZoned("2026-03-07T12:00", NY)!; // EST, UTC-5
    const after = parseZoned("2026-03-09T12:00", NY)!; // EDT, UTC-4
    const daysApart = 2 * 24 * HOUR;
    assert.equal(after.getTime() - before.getTime(), daysApart - HOUR);
  });

  test("noon on each DST transition day itself is correct", () => {
    expectUtc("2026-03-08T12:00", NY, "2026-03-08T16:00:00.000Z"); // already EDT
    expectUtc("2026-11-01T12:00", NY, "2026-11-01T17:00:00.000Z"); // already EST
  });

  test("the skipped hour in spring shifts forward, never backward", () => {
    // 2:30am on Mar 8 2026 does not exist in New York — the clock jumps 2am to
    // 3am. It must resolve to 3:30am EDT, not 1:30am EST. Landing an hour
    // EARLIER than the host typed would close a campaign before its deadline.
    const d = parseZoned("2026-03-08T02:30", NY);
    assert.ok(d);
    assert.equal(d.toISOString(), "2026-03-08T07:30:00.000Z");

    const localHour = new Intl.DateTimeFormat("en-US", {
      timeZone: NY,
      hour: "2-digit",
      hour12: false,
    }).format(d);
    assert.equal(localHour, "03");
  });

  test("the repeated hour in fall resolves to a single instant", () => {
    // 1:30am on Nov 1 2026 happens twice in New York. One is chosen.
    const d = parseZoned("2026-11-01T01:30", NY);
    assert.ok(d);
    assert.equal(d.toISOString(), "2026-11-01T05:30:00.000Z");
  });

  test("a zone without DST is stable across the year", () => {
    expectUtc("2026-07-01T12:00", "America/Phoenix", "2026-07-01T19:00:00.000Z");
    expectUtc("2026-01-15T12:00", "America/Phoenix", "2026-01-15T19:00:00.000Z");
  });

  test("Pacific and Hawaii", () => {
    expectUtc("2026-10-24T19:00", "America/Los_Angeles", "2026-10-25T02:00:00.000Z");
    expectUtc("2026-10-24T19:00", "Pacific/Honolulu", "2026-10-25T05:00:00.000Z");
  });

  test("seconds in the input are ignored, not misread", () => {
    expectUtc("2026-07-01T12:00:45", NY, "2026-07-01T16:00:00.000Z");
  });

  test("returns null rather than a wrong date for bad input", () => {
    assert.equal(parseZoned("", NY), null);
    assert.equal(parseZoned(null, NY), null);
    assert.equal(parseZoned(undefined, NY), null);
    assert.equal(parseZoned("not a date", NY), null);
    assert.equal(parseZoned("2026-13-01T12:00", NY), null); // month 13
    assert.equal(parseZoned("2026-07-01T25:00", NY), null); // hour 25
    assert.equal(parseZoned("2026-07-01T12:00", "Not/AZone"), null);
  });
});

describe("tzOffsetMs", () => {
  test("reports the offset in effect at that instant", () => {
    assert.equal(tzOffsetMs(new Date("2026-07-01T16:00:00Z"), NY), -4 * HOUR);
    assert.equal(tzOffsetMs(new Date("2026-01-15T17:00:00Z"), NY), -5 * HOUR);
    assert.equal(tzOffsetMs(new Date("2026-07-01T12:00:00Z"), "UTC"), 0);
  });

  test("handles a zone rendering midnight as hour 24", () => {
    // Guards the `% 24` normalization: midnight must be hour 0, not 24, or the
    // offset comes out a full day wrong.
    const midnightUtc = new Date("2026-07-01T00:00:00Z");
    assert.equal(tzOffsetMs(midnightUtc, "UTC"), 0);
  });
});
