import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { squareProductFor, type SquareSummary } from "./square-product.ts";

// The square product boundary.
//
// NOTE ON WHAT THIS IS NOT. There is no React renderer in this repo - the test
// glob is `src/**/*.test.ts` and no component test exists - so this asserts the
// PROP the view receives rather than the markup it produces. That is the right
// level anyway: the rule being defended is a data-boundary rule, and a
// component conditional is precisely what would have shipped the defect.
//
// The byte-identical check for raffle-on boards is done against the live pages,
// not here.

const PRICE = { amountCents: 4000, earlyBird: true, deadline: new Date("2026-09-28") };

const squares: SquareSummary[] = [
  { squareId: "a", position: 0, paymentStatus: "open" },
  { squareId: "b", position: 1, paymentStatus: "open" },
  { squareId: "c", position: 2, paymentStatus: "paid" },
  { squareId: "d", position: 3, paymentStatus: "reserved_cash" },
];

describe("raffle on — nothing about the existing product changes", () => {
  test("squares, count and price pass through untouched", () => {
    const p = squareProductFor({ raffleEnabled: true }, squares, PRICE);
    assert.notEqual(p, null);
    assert.deepEqual(p!.squares, squares, "the list is handed over verbatim");
    assert.equal(p!.price, PRICE, "the price object is the same reference");
    assert.equal(p!.openCount, 2, "only `open` counts");
  });

  // The count and the list are derived from one input, so they cannot drift.
  // A board whose every square has sold still HAS the product - it is sold
  // out, which is a different fact from not selling squares at all.
  test("a fully sold board still offers the product, with a zero count", () => {
    const sold = squares.map((sq) => ({ ...sq, paymentStatus: "paid" }));
    const p = squareProductFor({ raffleEnabled: true }, sold, PRICE);
    assert.notEqual(p, null, "sold out is NOT not-offered");
    assert.equal(p!.openCount, 0);
  });

  test("a board with no rows at all still offers the product", () => {
    const p = squareProductFor({ raffleEnabled: true }, [], PRICE);
    assert.notEqual(p, null);
    assert.equal(p!.openCount, 0);
  });
});

describe("raffle off — the product is absent, not empty", () => {
  // THE ACCEPTANCE CASE. A board carrying a hundred `open` rows that must never
  // be sold. Before this boundary existed those rows produced a live purchase
  // button; an empty-list fix would have produced a disabled one. Neither is
  // acceptable, and null is the only shape that says so.
  test("100 open rows still yield no product", () => {
    const hundred: SquareSummary[] = Array.from({ length: 100 }, (_, i) => ({
      squareId: `s${i}`,
      position: i,
      paymentStatus: "open",
    }));
    assert.equal(squareProductFor({ raffleEnabled: false }, hundred, PRICE), null);
  });

  test("no rows yields no product either", () => {
    assert.equal(squareProductFor({ raffleEnabled: false }, [], PRICE), null);
  });

  // A price exists on the board record whether or not squares are sold. It must
  // not reach the page through this door.
  test("a configured square price does not leak through", () => {
    assert.equal(squareProductFor({ raffleEnabled: false }, squares, PRICE), null);
  });
});
