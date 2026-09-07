import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  entryPriceFor,
  quoteEntry,
  offersEntry,
  encodeEntryPasses,
  decodeEntryPasses,
  validateEntryPricing,
} from "./entry-pricing.ts";

// Standalone Entry Ticket pricing, and the OPTIONALITY that makes this a
// platform capability rather than one fundraiser's requirements.
//
// The Hampton numbers appear here as TEST DATA for one board configuration.
// They are not defaults, and nothing in entry-pricing.ts knows them.

const CUTOFF = new Date("2026-09-28T03:59:59.000Z"); // 11:59:59pm ET, Sep 27
const BEFORE = new Date("2026-09-20T12:00:00.000Z");
const AFTER = new Date("2026-09-29T12:00:00.000Z");

/** One legal configuration among many. */
const HAMPTON = {
  entryChildPriceCents: 1500,
  entryAdultEarlyPriceCents: 4000,
  entryAdultRegularPriceCents: 5000,
  earlyBirdEndsAt: CUTOFF,
};

const NO_ENTRY = {
  entryChildPriceCents: null,
  entryAdultEarlyPriceCents: null,
  entryAdultRegularPriceCents: null,
  earlyBirdEndsAt: null,
};

describe("platform optionality", () => {
  // THE MOST IMPORTANT TEST IN THIS FILE. A donation-only or square-only
  // fundraiser configures nothing and is untouched by the whole feature.
  test("a board with no entry prices offers no Entry Tickets", () => {
    assert.equal(offersEntry(NO_ENTRY), false);
    assert.equal(entryPriceFor(NO_ENTRY, "CHILD", BEFORE), null);
    assert.equal(entryPriceFor(NO_ENTRY, "ADULT", BEFORE), null);
  });

  test("child-only is a legal configuration", () => {
    const b = { ...NO_ENTRY, entryChildPriceCents: 1000 };
    assert.equal(offersEntry(b), true);
    assert.deepEqual(entryPriceFor(b, "CHILD", BEFORE), {
      tier: "CHILD",
      priceBasis: "FLAT",
      pricePaidCents: 1000,
    });
    assert.equal(entryPriceFor(b, "ADULT", BEFORE), null, "adult simply not offered");
  });

  test("adult-regular-only is a legal configuration", () => {
    const b = { ...NO_ENTRY, entryAdultRegularPriceCents: 2500 };
    assert.equal(offersEntry(b), true);
    assert.equal(entryPriceFor(b, "CHILD", BEFORE), null);
    assert.deepEqual(entryPriceFor(b, "ADULT", BEFORE), {
      tier: "ADULT",
      priceBasis: "REGULAR",
      pricePaidCents: 2500,
    });
  });

  test("child + adult flat, no early bird, is legal", () => {
    const b = {
      ...NO_ENTRY,
      entryChildPriceCents: 1000,
      entryAdultRegularPriceCents: 2500,
    };
    assert.equal(entryPriceFor(b, "ADULT", BEFORE)!.priceBasis, "REGULAR");
    assert.equal(entryPriceFor(b, "ADULT", AFTER)!.priceBasis, "REGULAR", "no window to close");
  });
});

describe("Hampton configuration", () => {
  test("child is $15, flat, on both sides of the cutoff", () => {
    for (const now of [BEFORE, AFTER]) {
      assert.deepEqual(entryPriceFor(HAMPTON, "CHILD", now), {
        tier: "CHILD",
        priceBasis: "FLAT",
        pricePaidCents: 1500,
      });
    }
  });

  test("adult is $40 before the cutoff", () => {
    assert.deepEqual(entryPriceFor(HAMPTON, "ADULT", BEFORE), {
      tier: "ADULT",
      priceBasis: "EARLY",
      pricePaidCents: 4000,
    });
  });

  test("adult is $50 after the cutoff", () => {
    assert.deepEqual(entryPriceFor(HAMPTON, "ADULT", AFTER), {
      tier: "ADULT",
      priceBasis: "REGULAR",
      pricePaidCents: 5000,
    });
  });

  // The shared cutoff is the SAME instant and the SAME predicate square
  // pricing uses, so the boundary behaves identically for both products.
  test("the boundary instant itself is already regular", () => {
    assert.equal(entryPriceFor(HAMPTON, "ADULT", CUTOFF)!.priceBasis, "REGULAR");
    assert.equal(
      entryPriceFor(HAMPTON, "ADULT", new Date(CUTOFF.getTime() - 1))!.priceBasis,
      "EARLY"
    );
  });

  // FLAT is not "no discount". A child ticket has never had two prices;
  // REGULAR means an early window closed. Confusing them would make the child
  // price lock respond to the cutoff.
  test("FLAT and REGULAR are different bases", () => {
    assert.equal(entryPriceFor(HAMPTON, "CHILD", AFTER)!.priceBasis, "FLAT");
    assert.equal(entryPriceFor(HAMPTON, "ADULT", AFTER)!.priceBasis, "REGULAR");
  });
});

describe("quoteEntry", () => {
  // The §21 purchase, priced.
  test("2 adult early + 1 child = $95, three passes", () => {
    const q = quoteEntry(
      HAMPTON,
      [
        { tier: "ADULT", quantity: 2 },
        { tier: "CHILD", quantity: 1 },
      ],
      BEFORE
    );
    assert.ok(q.ok);
    assert.equal(q.totalCents, 9500);
    assert.equal(q.passes.length, 3, "one entry per pass, not per line");
    assert.equal(q.passes.filter((p) => p.tier === "ADULT").length, 2);
    assert.equal(
      q.passes.reduce((n, p) => n + p.pricePaidCents, 0),
      q.totalCents,
      "the sum the confirmation transaction asserts"
    );
  });

  test("the same purchase after the cutoff costs $115", () => {
    const q = quoteEntry(
      HAMPTON,
      [
        { tier: "ADULT", quantity: 2 },
        { tier: "CHILD", quantity: 1 },
      ],
      AFTER
    );
    assert.ok(q.ok && q.totalCents === 11500);
  });

  test("a tier that is not offered is refused, never substituted", () => {
    const q = quoteEntry({ ...NO_ENTRY, entryChildPriceCents: 1000 }, [
      { tier: "ADULT", quantity: 1 },
    ]);
    assert.equal(q.ok, false);
  });

  test("zero quantities are dropped; an empty purchase is refused", () => {
    const q = quoteEntry(HAMPTON, [
      { tier: "ADULT", quantity: 0 },
      { tier: "CHILD", quantity: 0 },
    ]);
    assert.equal(q.ok, false);
  });

  test("a fractional or negative quantity is refused", () => {
    assert.equal(quoteEntry(HAMPTON, [{ tier: "CHILD", quantity: 1.5 }]).ok, false);
    assert.equal(quoteEntry(HAMPTON, [{ tier: "CHILD", quantity: -1 }]).ok, false);
  });
});

describe("carrying priced passes across the Stripe round trip", () => {
  const q = quoteEntry(
    HAMPTON,
    [
      { tier: "ADULT", quantity: 2 },
      { tier: "CHILD", quantity: 1 },
    ],
    BEFORE
  );

  test("a quote survives the round trip pass for pass", () => {
    assert.ok(q.ok);
    const decoded = decodeEntryPasses(encodeEntryPasses(q.passes));
    assert.deepEqual(
      [...decoded!].sort((a, b) => a.pricePaidCents - b.pricePaidCents),
      [...q.passes].sort((a, b) => a.pricePaidCents - b.pricePaidCents)
    );
  });

  // The whole reason the passes travel rather than being re-quoted: this is
  // what a checkout begun before the cutoff and completed after it must decode
  // to. Re-pricing would return REGULAR and reject a correct purchase.
  test("an early-priced purchase stays early after the cutoff has passed", () => {
    assert.ok(q.ok);
    const decoded = decodeEntryPasses(encodeEntryPasses(q.passes))!;
    const adults = decoded.filter((p) => p.tier === "ADULT");
    assert.equal(adults.length, 2);
    assert.ok(adults.every((p) => p.priceBasis === "EARLY" && p.pricePaidCents === 4000));
  });

  test("the encoding stays far short of Stripe's 500-character metadata cap", () => {
    const big = quoteEntry(
      HAMPTON,
      [
        { tier: "ADULT", quantity: 300 },
        { tier: "CHILD", quantity: 300 },
      ],
      BEFORE
    );
    assert.ok(big.ok);
    // Grouped by (tier, basis, price), so length tracks the number of distinct
    // combinations and not the quantity.
    assert.ok(encodeEntryPasses(big.passes).length < 100);
  });

  test("malformed input decodes to null, never to a partial purchase", () => {
    for (const bad of [
      "",
      null,
      undefined,
      "ADULT:EARLY:4000",
      "ADULT:EARLY:4000:2:9",
      "ADULT:PREMIUM:4000:2",
      "SENIOR:FLAT:4000:2",
      "ADULT:EARLY:-4000:2",
      "ADULT:EARLY:0:2",
      "ADULT:EARLY:40.5:2",
      "ADULT:EARLY:4000:0",
      "ADULT:EARLY:4000:-1",
      "ADULT:EARLY:4000:1.5",
      "ADULT:EARLY:4000:501",
      "ADULT:EARLY:4000:2|CHILD:FLAT:1500",
    ]) {
      assert.equal(decodeEntryPasses(bad), null, `should refuse ${JSON.stringify(bad)}`);
    }
  });

  test("one malformed group refuses the whole string", () => {
    assert.equal(decodeEntryPasses("ADULT:EARLY:4000:2|junk"), null);
  });
});

describe("validateEntryPricing — the legal configuration matrix", () => {
  const base = {
    childCents: null as number | null,
    adultEarlyCents: null as number | null,
    adultRegularCents: null as number | null,
    hasEvent: true,
    cutoffPresent: true,
  };
  const ok = (o: Partial<typeof base>) => validateEntryPricing({ ...base, ...o }).ok;
  const why = (o: Partial<typeof base>) => {
    const r = validateEntryPricing({ ...base, ...o });
    return r.ok ? null : r.error;
  };

  // ---- LEGAL ---------------------------------------------------------------
  test("nothing priced — the ordinary fundraiser, untouched by the feature", () => {
    assert.equal(ok({}), true);
    // And it stays legal on a board with no event and no cutoff, which is what
    // "untouched" has to mean.
    assert.equal(ok({ hasEvent: false, cutoffPresent: false }), true);
  });

  test("child only", () => {
    assert.equal(ok({ childCents: 1500 }), true);
    // No adult tier, no cutoff needed — a child price has no early window.
    assert.equal(ok({ childCents: 1500, cutoffPresent: false }), true);
  });

  test("adult regular only", () => {
    assert.equal(ok({ adultRegularCents: 5000, cutoffPresent: false }), true);
  });

  test("child + adult flat, no early bird", () => {
    assert.equal(
      ok({ childCents: 1500, adultRegularCents: 5000, cutoffPresent: false }),
      true
    );
  });

  test("the full Hampton shape: child flat, adult early and regular", () => {
    assert.equal(
      ok({ childCents: 1500, adultEarlyCents: 4000, adultRegularCents: 5000 }),
      true
    );
  });

  test("adult early and regular with no child tier", () => {
    assert.equal(ok({ adultEarlyCents: 4000, adultRegularCents: 5000 }), true);
  });

  // ---- ILLEGAL -------------------------------------------------------------
  test("adult early with no adult regular to be early against", () => {
    assert.match(why({ adultEarlyCents: 4000 })!, /needs an adult entry ticket price/);
  });

  test("adult early at or above adult regular", () => {
    assert.match(
      why({ adultEarlyCents: 5000, adultRegularCents: 5000 })!,
      /must be below the adult entry ticket price/
    );
    assert.match(
      why({ adultEarlyCents: 6000, adultRegularCents: 5000 })!,
      /must be below the adult entry ticket price/
    );
  });

  // THE TWO-STEP TRAP, made impossible. A board priced with adult early bird
  // and no cutoff is one boards_entry_pricing_coherent refuses, and the host
  // would have met that as a 500 rather than a sentence.
  test("adult early with no cutoff date", () => {
    assert.match(
      why({ adultEarlyCents: 4000, adultRegularCents: 5000, cutoffPresent: false })!,
      /needs an early bird end date/
    );
  });

  test("any price on a board with no event", () => {
    for (const o of [
      { childCents: 1500 },
      { adultRegularCents: 5000 },
      { adultEarlyCents: 4000, adultRegularCents: 5000 },
    ]) {
      assert.match(why({ ...o, hasEvent: false })!, /need an event/);
    }
  });

  test("a price below the $1 floor, in any tier", () => {
    assert.match(why({ childCents: 50 })!, /Child entry ticket price must be at least \$1/);
    assert.match(
      why({ adultRegularCents: 99 })!,
      /Adult entry ticket price must be at least \$1/
    );
    assert.match(
      why({ adultEarlyCents: 1, adultRegularCents: 5000 })!,
      /Adult early bird entry price must be at least \$1/
    );
  });

  test("zero and negative are refused, not treated as absent", () => {
    assert.equal(ok({ childCents: 0 }), false);
    assert.equal(ok({ childCents: -1500 }), false);
  });

  test("a fractional cent amount is refused", () => {
    assert.equal(ok({ childCents: 1500.5 }), false);
  });
});
