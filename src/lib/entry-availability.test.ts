import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  entryLimitError,
  ticketsSoldLabel,
  type EntryAvailability,
} from "./entry-availability.ts";

// The entry-limit copy that needs no database — v2 §19.13, §9.
//
// THE NULL CASE IS THE ONE THAT MATTERS. An uncapped board has no remaining
// count, and rendering `0 remaining` there would tell a host she is sold out
// when she can sell forever.

const a = (over: Partial<EntryAvailability> = {}): EntryAvailability => ({
  limit: 100,
  sold: 14,
  held: 0,
  remaining: 86,
  ...over,
});

describe("ticketsSoldLabel", () => {
  test("a capped board states sold and remaining", () => {
    assert.equal(ticketsSoldLabel(a()), "14 tickets sold · 86 remaining");
  });

  test("an uncapped board states sold alone", () => {
    assert.equal(
      ticketsSoldLabel(a({ limit: null, remaining: null })),
      "14 tickets sold"
    );
    assert.doesNotMatch(
      ticketsSoldLabel(a({ limit: null, remaining: null })),
      /remaining/
    );
  });

  test("one ticket is singular", () => {
    assert.equal(
      ticketsSoldLabel(a({ sold: 1, remaining: 99 })),
      "1 ticket sold · 99 remaining"
    );
  });

  test("none sold is still a sentence, not a blank", () => {
    assert.equal(
      ticketsSoldLabel(a({ sold: 0, remaining: 100 })),
      "0 tickets sold · 100 remaining"
    );
  });

  // A FULL BOARD READS ZERO, NOT NOTHING. The host needs to see that the cap is
  // reached; silence would read as a rendering fault.
  test("a full board reads zero remaining", () => {
    assert.equal(
      ticketsSoldLabel(a({ sold: 100, remaining: 0 })),
      "100 tickets sold · 0 remaining"
    );
  });
});

describe("entryLimitError", () => {
  // THE REAL NUMBER, NOT "SOLD OUT". A buyer who asked for four when two are
  // left can act on "two"; "sold out" sends her away from a board that would
  // still take her money.
  test("names how many are actually left", () => {
    assert.match(entryLimitError(2), /Only 2 tickets are left/);
    assert.match(entryLimitError(1), /Only 1 ticket is left/);
  });

  test("zero is sold out, and says a reservation may come back", () => {
    assert.match(entryLimitError(0), /sold out/i);
    assert.match(entryLimitError(0), /released/);
  });

  test("every message offers a next step rather than a dead end", () => {
    for (const n of [0, 1, 2, 9]) {
      assert.match(entryLimitError(n), /check back/i);
    }
  });
});
