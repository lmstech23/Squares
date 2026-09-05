/**
 * Ticket inventory, derived — never configured.
 *
 * The host says what she is raising and what a ticket costs. The board size
 * follows. She was previously asked to pick 25/50/75/100, which is a question
 * about grid mechanics dressed up as a product choice: nobody running a
 * fundraiser thinks in squares, and the number she picked had no relationship
 * to the number she needed.
 *
 *     ticket count = ceiling(goal ÷ REGULAR ticket price)
 *
 * ALWAYS THE REGULAR PRICE. Early bird is a temporary discount, not a resize.
 * A $5,000 goal at $50 makes 100 tickets even if the first twenty sell at $40 —
 * sizing off the discount would build a board that cannot reach the goal once
 * the discount ends.
 *
 * Donations do not resize anything. They help reach the goal sooner, which is
 * the opposite of needing more inventory.
 */

/** Both amounts in cents. Returns null when either input is unusable. */
export function ticketCountFor(
  goalCents: number | null | undefined,
  regularPriceCents: number | null | undefined
): number | null {
  if (!goalCents || !regularPriceCents) return null;
  if (!Number.isFinite(goalCents) || !Number.isFinite(regularPriceCents)) return null;
  if (goalCents <= 0 || regularPriceCents <= 0) return null;
  // CEILING, so the board can always reach the goal. Rounding down leaves a
  // board that sells out short of what the host said she needed, which is the
  // one outcome the derivation exists to prevent.
  return Math.ceil(goalCents / regularPriceCents);
}
