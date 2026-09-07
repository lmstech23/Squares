// Standalone Entry Ticket pricing.
//
// AN OPTIONAL PLATFORM CAPABILITY, not a fundraiser requirement. A board that
// configures no entry prices offers no Entry Tickets, and every donation-only
// and square-only fundraiser is untouched by this file.
//
// NO PLATFORM DEFAULTS ANYWHERE IN HERE. Hampton's prices are Hampton's board
// data. A helper that "knows" $15 or $40 is a helper that quietly makes one
// fundraiser's event policy into everyone's.
//
// Child is independent. Adult Regular is independently optional. Only Adult
// EARLY has dependencies, because an early price needs a price to transition
// to and a deadline to transition on — the same one-way implication
// boards_early_bird_coherent already applies to squares.

import { earlyBirdActive } from "./claim-price.ts";

export type EntryTier = "CHILD" | "ADULT";
export type EntryPriceBasis = "FLAT" | "EARLY" | "REGULAR";

/** The three nullable board columns. Null means the tier is not offered. */
export interface EntryPricedBoard {
  entryChildPriceCents: number | null;
  entryAdultEarlyPriceCents: number | null;
  entryAdultRegularPriceCents: number | null;
  /** Shared with square early-bird pricing. One cutoff, both products. */
  earlyBirdEndsAt: Date | null;
}

export interface EntryPrice {
  tier: EntryTier;
  priceBasis: EntryPriceBasis;
  pricePaidCents: number;
}

/** Does this board sell Entry Tickets at all? */
export function offersEntry(board: EntryPricedBoard): boolean {
  return (
    board.entryChildPriceCents != null || board.entryAdultRegularPriceCents != null
  );
}

/**
 * Is the Adult early-bird window open right now?
 *
 * THE SAME CUTOFF SQUARES USE, evaluated the same way. `earlyBirdActive` in
 * claim-price.ts is the predicate the square checkout charges on; reusing it
 * means the two products can never disagree about whether the deadline has
 * passed, and the board's IANA timezone and DST handling come along for free.
 *
 * Note the shape passed in: `squarePrice` is irrelevant to entry, so a
 * synthetic pair is handed over whose only meaningful members are the entry
 * early price and the shared cutoff. A board with flat square pricing and
 * early-bird entry is a legal configuration and must not be forced to invent a
 * square early-bird price.
 */
export function entryEarlyBirdActive(
  board: EntryPricedBoard,
  now: Date = new Date()
): boolean {
  return earlyBirdActive(
    {
      squarePrice: Number.MAX_SAFE_INTEGER,
      earlyBirdPriceCents: board.entryAdultEarlyPriceCents,
      earlyBirdEndsAt: board.earlyBirdEndsAt,
    },
    now
  );
}

/**
 * What one Entry Ticket of this tier costs right now, and under which rule.
 *
 * Returns null when the tier is not offered — the caller rejects rather than
 * substituting a price the host never set.
 *
 * `priceBasis` is RETURNED AND STORED, never re-derived later by comparing
 * amounts. That is the difference from square pricing, which has no such
 * column and must guess by comparison; storing it makes the entry price locks
 * exact and removes the ambiguous-equal-prices case entirely.
 */
export function entryPriceFor(
  board: EntryPricedBoard,
  tier: EntryTier,
  now: Date = new Date()
): EntryPrice | null {
  if (tier === "CHILD") {
    const cents = board.entryChildPriceCents;
    if (cents == null) return null;
    // One price, no window. FLAT is not "no discount" — it is a tier that has
    // never had two prices, and it must not be confused with REGULAR, which
    // means "the early window closed".
    return { tier: "CHILD", priceBasis: "FLAT", pricePaidCents: cents };
  }

  const regular = board.entryAdultRegularPriceCents;
  if (regular == null) return null;

  if (entryEarlyBirdActive(board, now)) {
    return {
      tier: "ADULT",
      priceBasis: "EARLY",
      pricePaidCents: board.entryAdultEarlyPriceCents!,
    };
  }
  return { tier: "ADULT", priceBasis: "REGULAR", pricePaidCents: regular };
}

export interface EntryLine {
  tier: EntryTier;
  quantity: number;
}

export type EntryQuote =
  | { ok: true; passes: EntryPrice[]; totalCents: number }
  | { ok: false; error: string };

/**
 * Price a whole purchase: N of each tier, at the prices in force now.
 *
 * The returned `passes` array is one entry PER PASS, not per line, because
 * each pass stores its own price. `totalCents` is what
 * `Contribution.entryAmountCents` must be set to, and the confirmation
 * transaction re-asserts that the passes still sum to it.
 */
export function quoteEntry(
  board: EntryPricedBoard,
  lines: EntryLine[],
  now: Date = new Date()
): EntryQuote {
  const passes: EntryPrice[] = [];
  let total = 0;

  for (const line of lines) {
    if (!Number.isInteger(line.quantity) || line.quantity < 0) {
      return { ok: false, error: "Choose a whole number of tickets." };
    }
    if (line.quantity === 0) continue;

    const price = entryPriceFor(board, line.tier, now);
    if (!price) {
      return {
        ok: false,
        error:
          line.tier === "CHILD"
            ? "Child entry is not offered for this event."
            : "Adult entry is not offered for this event.",
      };
    }
    for (let i = 0; i < line.quantity; i++) {
      passes.push(price);
      total += price.pricePaidCents;
    }
  }

  if (passes.length === 0) {
    return { ok: false, error: "Choose at least one ticket." };
  }
  return { ok: true, passes, totalCents: total };
}

// ============================================================
// CARRYING PRICED PASSES ACROSS THE STRIPE ROUND TRIP
//
// THE PASSES MUST NOT BE RE-QUOTED AT CONFIRMATION. A checkout begun at 11:58pm
// and completed at 12:01am would re-quote at the REGULAR price, and the
// contribution - written before the cutoff at the EARLY price - would no
// longer match. The confirmation assertion would then reject a purchase the
// contributor made correctly. Price is fixed when the purchase is made, the
// same rule squares follow.
//
// So the exact priced passes travel in Stripe session metadata and are decoded
// verbatim on the way back. The encoding is grouped by (tier, basis, price),
// which bounds it: there are three legal combinations, so the string is a few
// dozen characters regardless of quantity and can never approach Stripe's
// 500-character cap on a metadata value.
//
//   ADULT:EARLY:4000:2|CHILD:FLAT:1500:1
//
// decodeEntryPasses is TOTAL: any malformed input returns null and the caller
// refuses to confirm. It is never repaired, because a metadata value that
// cannot be parsed means the money and the passes cannot be shown to agree.
// ============================================================

const TIERS: EntryTier[] = ["CHILD", "ADULT"];
const BASES: EntryPriceBasis[] = ["FLAT", "EARLY", "REGULAR"];

export function encodeEntryPasses(passes: EntryPrice[]): string {
  const groups = new Map<string, number>();
  for (const p of passes) {
    const key = `${p.tier}:${p.priceBasis}:${p.pricePaidCents}`;
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  return [...groups].map(([key, n]) => `${key}:${n}`).join("|");
}

export function decodeEntryPasses(encoded: string | null | undefined): EntryPrice[] | null {
  if (!encoded) return null;
  const passes: EntryPrice[] = [];

  for (const group of encoded.split("|")) {
    const parts = group.split(":");
    if (parts.length !== 4) return null;

    const [tier, basis, price, count] = parts;
    if (!TIERS.includes(tier as EntryTier)) return null;
    if (!BASES.includes(basis as EntryPriceBasis)) return null;

    const pricePaidCents = Number(price);
    const quantity = Number(count);
    if (!Number.isInteger(pricePaidCents) || pricePaidCents <= 0) return null;
    if (!Number.isInteger(quantity) || quantity <= 0) return null;
    // A bound, not a guess at anyone's party size. It stops a hostile or
    // corrupted value from asking the database to mint unbounded rows.
    if (quantity > 500) return null;

    for (let i = 0; i < quantity; i++) {
      passes.push({
        tier: tier as EntryTier,
        priceBasis: basis as EntryPriceBasis,
        pricePaidCents,
      });
    }
  }

  return passes.length > 0 ? passes : null;
}

// ============================================================
// ONE COHERENCE RULE, ONE IMPLEMENTATION
//
// These rules were written out three times — the creation form, the creation
// route and the edit route — which is precisely the shape that drifts. The one
// that drifts is whichever gets tested least, and the symptom is a host being
// told "must be below" on one screen and getting a 500 from a CHECK on
// another. This is the single copy; the three call sites present it.
//
// It mirrors boards_entry_pricing_coherent and boards_entry_prices_positive,
// and it exists so a host reads a sentence instead of a constraint violation.
// It does NOT replace the CHECKs: the database is the enforcement, this is the
// explanation.
// ============================================================

/** $1, matching squarePrice. The CHECK only demands > 0; this is stricter. */
export const MIN_ENTRY_PRICE_CENTS = 100;

export interface EntryPricingInput {
  childCents: number | null;
  adultEarlyCents: number | null;
  adultRegularCents: number | null;
  /** An Event row exists, or is being created alongside the board. */
  hasEvent: boolean;
  /** `earlyBirdEndsAt` will be set once this write lands. */
  cutoffPresent: boolean;
}

export type EntryPricingResult = { ok: true } | { ok: false; error: string };

export function validateEntryPricing(input: EntryPricingInput): EntryPricingResult {
  const { childCents, adultEarlyCents, adultRegularCents } = input;
  const any = [childCents, adultEarlyCents, adultRegularCents].some((c) => c != null);

  // OPTIONALITY FIRST. A board that prices nothing is legal and is the ordinary
  // case; nothing below applies to it.
  if (!any) return { ok: true };

  for (const [cents, label] of [
    [childCents, "Child entry ticket price"],
    [adultEarlyCents, "Adult early bird entry price"],
    [adultRegularCents, "Adult entry ticket price"],
  ] as const) {
    if (cents == null) continue;
    if (!Number.isInteger(cents) || cents < MIN_ENTRY_PRICE_CENTS) {
      return { ok: false, error: `${label} must be at least $1, or left blank.` };
    }
  }

  // Admission needs something to admit to. The purchase route refuses a board
  // with no Event row, so prices without one configure a product no contributor
  // could ever be offered.
  if (!input.hasEvent) {
    return {
      ok: false,
      error:
        "Entry ticket prices need an event. Add the event, or leave the entry " +
        "prices blank.",
    };
  }

  // THE ONLY DEPENDENCY IN THE MODEL. Child-only is legal. Adult-regular-only
  // is legal. Child plus adult flat is legal. Only an ADULT EARLY price pulls
  // anything else in with it.
  if (adultEarlyCents != null) {
    if (adultRegularCents == null) {
      return {
        ok: false,
        error:
          "An adult early bird entry price needs an adult entry ticket price " +
          "to be early against.",
      };
    }
    if (adultEarlyCents >= adultRegularCents) {
      return {
        ok: false,
        error:
          "The adult early bird entry price must be below the adult entry " +
          "ticket price.",
      };
    }
    if (!input.cutoffPresent) {
      return {
        ok: false,
        error:
          "An adult early bird entry price needs an early bird end date. " +
          "One date sets both the ticket and the adult entry early price.",
      };
    }
  }

  return { ok: true };
}
