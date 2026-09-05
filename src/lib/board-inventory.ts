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

/**
 * MVP SAFETY CAP, not a product ceiling.
 *
 * Without it, `ceil(goal / price)` is unbounded: a $1,000,000,000 goal at $1 a
 * ticket asks the create route to insert a billion square rows. The cap exists
 * to stop a typo becoming an outage, and nothing is built toward raising it or
 * configuring it.
 */
export const MAX_TICKETS = 1000;

export type TicketCountResult =
  | { ok: true; count: number }
  | { ok: false; error: string };

export const TOO_MANY_TICKETS =
  "This goal and ticket price would require more than 1,000 tickets. " +
  "Increase the ticket price or lower the fundraising goal.";

/**
 * The count, or the reason there isn't one.
 *
 * NEVER SILENTLY CLAMPS. Quietly building a 1,000-ticket board for a host who
 * asked for 40,000 would leave her with a board that cannot reach the goal she
 * typed, discovered weeks later. Refusing tells her now, while the two numbers
 * she needs to change are still in front of her.
 */
export function validateTicketCount(
  goalCents: number | null | undefined,
  regularPriceCents: number | null | undefined
): TicketCountResult {
  const count = ticketCountFor(goalCents, regularPriceCents);
  if (count == null || count < 1) {
    return {
      ok: false,
      error: "The goal and ticket price do not produce a usable number of tickets.",
    };
  }
  if (count > MAX_TICKETS) return { ok: false, error: TOO_MANY_TICKETS };
  return { ok: true, count };
}
