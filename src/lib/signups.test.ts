// S2 host slot builder — validation and ordering rules.
//
// These are the rules the database cannot express, or expresses only as a
// backstop. A CHECK violation reaching a host as a 500 with a Postgres
// constraint name in it is a failure of validateSlotInput, so it is tested here
// as well as in the database.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  validateSlotInput, validateReorder, normalizeSortOrder,
  slotFillState, sheetSummary, capacityTooLowMessage,
  isValidPositionCount, maxPositionsPerCommitment,
  slotTypeChangeRejected,
} from "./signups.ts";

const at = (h: number) => new Date(`2026-10-24T${String(h).padStart(2, "0")}:00:00Z`);

describe("slot validation mirrors the S1 CHECK constraints", () => {
  test("SHIFT requires a start", () => {
    const r = validateSlotInput({ slotType: "SHIFT", name: "Gate", capacity: 1 });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.field, "startsAt");
  });
  test("SHIFT may be open-ended", () => {
    assert.equal(validateSlotInput({ slotType: "SHIFT", name: "Cleanup", capacity: 2, startsAt: at(20) }).ok, true);
  });
  test("SHIFT end must be after start", () => {
    assert.equal(validateSlotInput({ slotType: "SHIFT", name: "x", capacity: 1, startsAt: at(10), endsAt: at(9) }).ok, false);
    assert.equal(validateSlotInput({ slotType: "SHIFT", name: "x", capacity: 1, startsAt: at(10), endsAt: at(10) }).ok, false);
  });
  test("ITEM has no times", () => {
    assert.equal(validateSlotInput({ slotType: "ITEM", name: "Water", capacity: 6, startsAt: at(10) }).ok, false);
  });
  test("unitLabel is ITEM-only", () => {
    assert.equal(validateSlotInput({ slotType: "SHIFT", name: "x", capacity: 1, startsAt: at(8), unitLabel: "case" }).ok, false);
    assert.equal(validateSlotInput({ slotType: "ITEM", name: "Water", capacity: 6, unitLabel: "case" }).ok, true);
  });
  test("name required, capacity at least 1", () => {
    assert.equal(validateSlotInput({ slotType: "ITEM", name: "  ", capacity: 1 }).ok, false);
    assert.equal(validateSlotInput({ slotType: "ITEM", name: "x", capacity: 0 }).ok, false);
    assert.equal(validateSlotInput({ slotType: "ITEM", name: "x", capacity: 1.5 }).ok, false);
  });
});

describe("reorder is validated as a set, not by length", () => {
  const actual = ["a", "b", "c"];
  test("exact permutation passes", () => {
    assert.equal(validateReorder(["c", "a", "b"], actual).ok, true);
  });
  test("a swapped-in foreign id has the right LENGTH and must still fail", () => {
    // The case a count check would miss.
    assert.equal(validateReorder(["a", "b", "zzz"], actual).ok, false);
  });
  test("duplicates fail", () => {
    assert.equal(validateReorder(["a", "a", "b"], actual).ok, false);
  });
  test("missing or extra fail", () => {
    assert.equal(validateReorder(["a", "b"], actual).ok, false);
    assert.equal(validateReorder(["a", "b", "c", "d"], actual).ok, false);
  });
  test("normalize produces a dense 0..n-1", () => {
    assert.deepEqual(normalizeSortOrder(["c", "a", "b"]),
      [{ id: "c", sortOrder: 0 }, { id: "a", sortOrder: 1 }, { id: "b", sortOrder: 2 }]);
  });
});

describe("fill state is derived, never stored", () => {
  test("open clamps at zero when capacity sits below filled", () => {
    assert.deepEqual(slotFillState(2, 5), { capacity: 2, filled: 5, open: 0, isFull: true });
  });
  test("equal capacity and filled is full, not negative", () => {
    assert.deepEqual(slotFillState(3, 3), { capacity: 3, filled: 3, open: 0, isFull: true });
  });
  test("summary totals across slots", () => {
    assert.deepEqual(sheetSummary([{ capacity: 4, filled: 2 }, { capacity: 6, filled: 6 }]),
      { slotCount: 2, totalCapacity: 10, totalFilled: 8, totalOpen: 2 });
  });
});

describe("capacity refusal copy", () => {
  test("plural", () => {
    assert.equal(capacityTooLowMessage(3),
      "3 people have already signed up for this. Set it to 3 or higher, or remove someone first.");
  });
  test("singular", () => {
    assert.ok(capacityTooLowMessage(1).startsWith("1 person has already signed up"));
  });
});

describe("the cross-table rule the database cannot hold", () => {
  test("SHIFT is exactly one position, not at most one", () => {
    assert.equal(maxPositionsPerCommitment("SHIFT", 6), 1);
    assert.equal(isValidPositionCount("SHIFT", 1, 6), true);
    assert.equal(isValidPositionCount("SHIFT", 2, 6), false);
    assert.equal(isValidPositionCount("SHIFT", 0, 6), false);
  });
  test("ITEM is up to capacity", () => {
    assert.equal(isValidPositionCount("ITEM", 4, 6), true);
    assert.equal(isValidPositionCount("ITEM", 7, 6), false);
  });
});

describe("a saved slot's type is immutable", () => {
  // The database CANNOT enforce this. The S1 CHECKs police internal
  // consistency: an ITEM keeping its times is rejected, a SHIFT keeping a
  // unitLabel is rejected. But a flip that also clears the now-invalid fields
  // produces a row Postgres accepts — and that is exactly what a well-formed
  // client would send. A CHECK only sees the present row; immutability is a
  // claim about its history.
  test("a different type is rejected", () => {
    assert.equal(slotTypeChangeRejected("SHIFT", "ITEM"), true);
    assert.equal(slotTypeChangeRejected("ITEM", "SHIFT"), true);
  });
  test("the same type is not a change", () => {
    assert.equal(slotTypeChangeRejected("SHIFT", "SHIFT"), false);
    assert.equal(slotTypeChangeRejected("ITEM", "ITEM"), false);
  });
  test("omitting slotType is not a change — edits need not send it", () => {
    assert.equal(slotTypeChangeRejected("SHIFT", undefined), false);
    assert.equal(slotTypeChangeRejected("SHIFT", null), false);
    assert.equal(slotTypeChangeRejected("SHIFT", ""), false);
  });
  test("a non-string is not treated as a change", () => {
    assert.equal(slotTypeChangeRejected("SHIFT", 1), false);
    assert.equal(slotTypeChangeRejected("SHIFT", {}), false);
  });
});
