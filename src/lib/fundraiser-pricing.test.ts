import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { publicPriceDisplay } from "./fundraiser-pricing.ts";
import { currentPriceCents } from "./claim-price.ts";

// What a contributor sees must be what the checkout charges. These tests exist
// mainly to hold those two together: every case asserts the displayed amount
// against currentPriceCents() for the same board and the same instant.

const AT = (iso: string) => new Date(iso);

// The live QT'13 board: $50 regular, $40 early bird, ending 11:59:59 PM
// Eastern on Sep 27 -- stored as 2026-09-28T03:59:59Z.
const QT13 = {
  squarePrice: 5000,
  earlyBirdPriceCents: 4000,
  earlyBirdEndsAt: AT("2026-09-28T03:59:59.000Z"),
};

describe("publicPriceDisplay", () => {
  test("during the window: the early price and the deadline, and nothing else", () => {
    const now = AT("2026-09-20T12:00:00.000Z");
    const p = publicPriceDisplay(QT13, now);
    assert.equal(p.earlyBird, true);
    assert.equal(p.amountCents, 4000);
    assert.ok(p.earlyBird && p.deadline.getTime() === QT13.earlyBirdEndsAt.getTime());
    // THE REGULAR PRICE IS NOT REACHABLE from the returned value. That is the
    // point: a caller cannot render "then $50" from this.
    assert.equal(Object.hasOwn(p, "squarePrice"), false);
  });

  test("after the changeover: the regular price, no early-bird framing", () => {
    const now = AT("2026-09-28T04:00:00.000Z"); // one second past
    const p = publicPriceDisplay(QT13, now);
    assert.equal(p.earlyBird, false);
    assert.equal(p.amountCents, 5000);
    assert.equal(Object.hasOwn(p, "deadline"), false);
  });

  test("a board with no early bird always shows the one price", () => {
    const flat = { squarePrice: 3000, earlyBirdPriceCents: null, earlyBirdEndsAt: null };
    assert.deepEqual(publicPriceDisplay(flat, AT("2026-01-01T00:00:00.000Z")), {
      earlyBird: false,
      amountCents: 3000,
    });
  });

  // An early price with no end date is not a window. claim-price.ts already
  // charges the regular price in that state; display must agree.
  test("an early price with no end date is not a window", () => {
    const broken = { squarePrice: 3000, earlyBirdPriceCents: 2500, earlyBirdEndsAt: null };
    assert.equal(publicPriceDisplay(broken, AT("2026-01-01T00:00:00.000Z")).amountCents, 3000);
  });

  // THE ONE THAT MATTERS. A contributor who reads "$40" and is charged "$50"
  // has been misled by the page, so the display helper delegates its predicate
  // to claim-price.ts rather than repeating the comparison. Checked either side
  // of the boundary and AT it -- the brief for this change proposed `now <=
  // deadline`, which would have disagreed with the charge by one millisecond.
  test("the displayed price always equals what the checkout charges", () => {
    const instants = [
      "2026-09-01T00:00:00.000Z",
      "2026-09-28T03:59:58.999Z",
      "2026-09-28T03:59:59.000Z", // exactly the deadline
      "2026-09-28T03:59:59.001Z",
      "2026-10-01T00:00:00.000Z",
    ];
    for (const iso of instants) {
      const now = AT(iso);
      assert.equal(
        publicPriceDisplay(QT13, now).amountCents,
        currentPriceCents(QT13, now),
        "display and charge disagree at " + iso
      );
    }
  });
});
