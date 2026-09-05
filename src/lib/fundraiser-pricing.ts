// What a CONTRIBUTOR sees on the price line. Display only.
//
// Nothing here decides what anyone is charged — that is currentPriceCents() in
// claim-price.ts, and this file calls its predicate rather than repeating the
// comparison. A display helper that re-derived "is the window still open" could
// advertise a discount the checkout no longer applies, which is the exact drift
// claim-price.ts was written to stop.
//
// ONE PRICE, NEVER TWO. While early bird is live the contributor sees the early
// price and the deadline and nothing else. "$40 through Sep 27, then $50" makes
// someone deciding whether to buy today do arithmetic about a price that is not
// on offer; the regular price is not yet a fact about their purchase. After the
// changeover there is one price again and no early-bird framing at all.
//
// The HOST still sees both, through priceScheduleLabel() — she is running the
// campaign and the changeover is hers to plan around. That difference is the
// whole reason this is a separate function and not an edit to that one.

import { earlyBirdActive } from "./claim-price.ts";

export type PublicPrice =
  | { earlyBird: true; amountCents: number; deadline: Date }
  | { earlyBird: false; amountCents: number };

interface PricedBoard {
  squarePrice: number;
  earlyBirdPriceCents: number | null;
  earlyBirdEndsAt: Date | null;
}

/**
 * The single price and, while early bird is live, its deadline.
 *
 * `squarePrice` is CENTS despite the missing suffix — every consumer in the
 * codebase divides it by 100, and the live QT'13 board stores 5000 for a $50
 * ticket. Both branches return cents; callers format.
 */
export function publicPriceDisplay(
  board: PricedBoard,
  now: Date = new Date()
): PublicPrice {
  // The SAME predicate claim-price.ts charges on. Deliberately not an inline
  // comparison: the two must agree to the millisecond, because a contributor
  // who reads "EARLY BIRD $40" and is charged $50 has been misled by the page.
  if (earlyBirdActive(board, now)) {
    return {
      earlyBird: true,
      amountCents: board.earlyBirdPriceCents!,
      deadline: board.earlyBirdEndsAt!,
    };
  }
  return { earlyBird: false, amountCents: board.squarePrice };
}
