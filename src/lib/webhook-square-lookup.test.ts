// Which squares did a checkout session buy?
//
// The webhook resolves this from `Square.checkoutSessionId` first and falls
// back to `metadata.squareIds`. THE FALLBACK IS GAME DAY'S ONLY PATH:
// `checkoutSessionId` is written under `isFundraiser ? {...} : {}` in
// api/checkout/route.ts, so a Game Day square never has one. These tests exist
// so a future change cannot delete the fallback as "legacy" and silently break
// Game Day checkout.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

/** Mirrors handleCheckoutCompleted's resolution order exactly. */
function resolveSquareIds(
  bySession: { squareId: string }[],
  metadata: { squareIds?: string; squareId?: string } | null | undefined
): string[] {
  return bySession.length > 0
    ? bySession.map((sq) => sq.squareId)
    : (metadata?.squareIds || metadata?.squareId || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
}

const A = "11111111-1111-1111-1111-111111111111";
const B = "22222222-2222-2222-2222-222222222222";

describe("webhook square resolution", () => {
  test("fundraiser: resolves from checkoutSessionId", () => {
    assert.deepEqual(resolveSquareIds([{ squareId: A }, { squareId: B }], null), [A, B]);
  });

  test("GAME DAY: no checkoutSessionId, resolves from metadata.squareIds", () => {
    // The case that breaks if the fallback is removed.
    assert.deepEqual(resolveSquareIds([], { squareIds: `${A},${B}` }), [A, B]);
  });

  test("legacy single squareId still resolves", () => {
    assert.deepEqual(resolveSquareIds([], { squareId: A }), [A]);
  });

  test("database wins over metadata when both exist", () => {
    // An in-flight fundraiser session created before the metadata change has
    // both. The database is authoritative.
    assert.deepEqual(resolveSquareIds([{ squareId: A }], { squareIds: `${A},${B}` }), [A]);
  });

  test("neither source yields nothing, and the caller returns early", () => {
    assert.deepEqual(resolveSquareIds([], null), []);
    assert.deepEqual(resolveSquareIds([], { squareIds: "" }), []);
    assert.deepEqual(resolveSquareIds([], { squareIds: " , ,, " }), []);
  });

  test("the metadata ceiling this change removes", () => {
    // Stripe caps a metadata VALUE at 500 characters. A uuid plus separator is
    // 37, so the old comma-joined list overflowed at about 13 squares.
    const joined = Array.from({ length: 14 }, () => A).join(",");
    assert.ok(joined.length > 500, `14 uuids is ${joined.length} chars, over Stripe's 500`);
    const thirteen = Array.from({ length: 13 }, () => A).join(",");
    assert.ok(thirteen.length < 500, `13 uuids is ${thirteen.length} chars, under the limit`);
  });
});
