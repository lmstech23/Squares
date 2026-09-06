import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { dirtyChanges, applyBatchResults, batchSummary } from "./signup-batch.ts";

// The client half of the batched save. Pure, so the interesting cases can be
// asserted without a browser: what gets sent, what survives a partial failure,
// and what the supporter is told.

describe("dirtyChanges", () => {
  const slots = [
    { id: "a", yourCurrent: 0 },
    { id: "b", yourCurrent: 2 },
    { id: "c", yourCurrent: 1 },
  ];

  test("only slots whose draft differs are sent", () => {
    assert.deepEqual(dirtyChanges(slots, { a: 1, b: 2 }), [{ slotId: "a", target: 1 }]);
  });

  // A stepper nudged up and back down is not a change. setTargetQuantity would
  // compute a zero delta and write no log row anyway, but not sending it keeps
  // the batch honest about what it is asking for.
  test("a draft that ends where it started is not sent", () => {
    assert.deepEqual(dirtyChanges(slots, { b: 2 }), []);
  });

  test("cancellation is a change to zero, not an omission", () => {
    assert.deepEqual(dirtyChanges(slots, { c: 0 }), [{ slotId: "c", target: 0 }]);
  });

  test("untouched slots are absent by definition", () => {
    assert.deepEqual(dirtyChanges(slots, {}), []);
  });
});

describe("applyBatchResults", () => {
  test("a successful slot clears its draft", () => {
    const applied = applyBatchResults({ a: 2 }, [
      { slotId: "a", ok: true, quantity: 2, changed: true },
    ]);
    assert.deepEqual(applied.drafts, {});
    assert.deepEqual(applied.errors, {});
    assert.equal(applied.savedCount, 1);
  });

  // She asked for something and did not get it. Wiping the selection makes her
  // rebuild it; lowering it silently commits a number she never chose.
  test("a failed slot KEEPS its draft, clamped to the returned ceiling", () => {
    const applied = applyBatchResults({ a: 3 }, [
      { slotId: "a", ok: false, reason: "capacity", error: "Only 2 cases left.", maxTarget: 2 },
    ]);
    assert.equal(applied.drafts.a, 2, "clamped, not cleared and not left at 3");
    assert.equal(applied.errors.a, "Only 2 cases left.");
    assert.equal(applied.failedCount, 1);
  });

  test("one failure does not disturb the slots that succeeded", () => {
    const applied = applyBatchResults({ a: 1, b: 3, c: 0 }, [
      { slotId: "a", ok: true, quantity: 1, changed: true },
      { slotId: "b", ok: false, reason: "capacity", error: "Only 1 left.", maxTarget: 1 },
      { slotId: "c", ok: true, quantity: 0, changed: true },
    ]);
    assert.deepEqual(applied.drafts, { b: 1 }, "only the failure is retained");
    assert.equal(applied.savedCount, 2);
    assert.equal(applied.failedCount, 1);
  });

  // THE CLAMP MUST USE THE RESPONSE IN HAND, NEVER A REMEMBERED CEILING.
  // Availability moves between attempts. This is the same state twice: first
  // save clamps 3 -> 2, someone else takes another position, second save of 2
  // must clamp to 1 rather than sitting at the stale 2 and failing forever.
  test("a second failure clamps to the NEW ceiling, not the previous one", () => {
    const first = applyBatchResults({ a: 3 }, [
      { slotId: "a", ok: false, reason: "capacity", error: "Only 2 left.", maxTarget: 2 },
    ]);
    assert.equal(first.drafts.a, 2);

    const second = applyBatchResults(first.drafts, [
      { slotId: "a", ok: false, reason: "capacity", error: "Only 1 left.", maxTarget: 1 },
    ]);
    assert.equal(second.drafts.a, 1, "clamped against the fresh ceiling");
    assert.equal(second.errors.a, "Only 1 left.");
  });

  // A ceiling that rises must not raise what she asked for.
  test("a higher ceiling does not inflate the draft", () => {
    const applied = applyBatchResults({ a: 2 }, [
      { slotId: "a", ok: false, reason: "capacity", error: "…", maxTarget: 9 },
    ]);
    assert.equal(applied.drafts.a, 2);
  });

  // Closed sheets and inactive supporters carry no ceiling; the draft stands
  // as she left it.
  test("a failure with no ceiling leaves the draft untouched", () => {
    const applied = applyBatchResults({ a: 3 }, [
      { slotId: "a", ok: false, reason: "closed", error: "Sign-ups just closed." },
    ]);
    assert.equal(applied.drafts.a, 3);
    assert.equal(applied.errors.a, "Sign-ups just closed.");
  });

  test("a full slot clamps to zero rather than clearing the row", () => {
    const applied = applyBatchResults({ a: 2 }, [
      { slotId: "a", ok: false, reason: "capacity", error: "Snacks just filled up.", maxTarget: 0 },
    ]);
    assert.equal(applied.drafts.a, 0);
  });
});

describe("batchSummary", () => {
  // Never "Saved!" when something failed - a supporter who reads that and
  // walks away believes she is covering a shift nobody is covering.
  test("silence on complete success", () => {
    assert.equal(batchSummary({ drafts: {}, errors: {}, savedCount: 3, failedCount: 0 }), null);
  });

  test("a partial save says how many of how many", () => {
    assert.match(
      batchSummary({ drafts: {}, errors: {}, savedCount: 2, failedCount: 1 })!,
      /Saved 2 of 3/
    );
  });

  test("a total failure does not claim anything was saved", () => {
    const msg = batchSummary({ drafts: {}, errors: {}, savedCount: 0, failedCount: 2 })!;
    assert.match(msg, /Nothing could be saved/);
    assert.ok(!/Saved \d/.test(msg));
  });
});
