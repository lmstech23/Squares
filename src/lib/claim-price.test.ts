import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { currentPriceCents } from "./claim-price.ts";

const AT = (iso: string) => new Date(iso);

describe("currentPriceCents", () => {
  const early = {
    squarePrice: 3000,
    earlyBirdPriceCents: 2500,
    earlyBirdEndsAt: AT("2026-09-15T23:59:00Z"),
  };

  test("flat pricing always returns the standard price", () => {
    const flat = { squarePrice: 3000, earlyBirdPriceCents: null, earlyBirdEndsAt: null };
    assert.equal(currentPriceCents(flat, AT("2020-01-01T00:00:00Z")), 3000);
    assert.equal(currentPriceCents(flat, AT("2030-01-01T00:00:00Z")), 3000);
  });

  test("before the changeover the early price applies", () => {
    assert.equal(currentPriceCents(early, AT("2026-09-15T23:58:59Z")), 2500);
  });

  test("at and after the changeover the standard price applies", () => {
    assert.equal(currentPriceCents(early, AT("2026-09-15T23:59:00Z")), 3000);
    assert.equal(currentPriceCents(early, AT("2026-09-16T00:00:01Z")), 3000);
  });

  test("a price with no end date never changes over", () => {
    // The CHECK constraint forbids this row existing, but the helper must not
    // silently apply an early price forever if one ever does.
    const noEnd = { squarePrice: 3000, earlyBirdPriceCents: 2500, earlyBirdEndsAt: null };
    assert.equal(currentPriceCents(noEnd, AT("2020-01-01T00:00:00Z")), 3000);
  });

  test("price does not depend on how many squares have sold", () => {
    // Invariant 44 — the schedule is a boundary in time, evaluated once per
    // claim. Same instant, same answer, regardless of anything else.
    const t = AT("2026-09-01T12:00:00Z");
    assert.equal(currentPriceCents(early, t), currentPriceCents(early, t));
  });
});
