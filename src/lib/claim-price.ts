// Contribution pricing — fundraiser-money-state-machine.md §8B, invariants 48–50.
//
// Price is fixed the moment a square leaves `open` — at claim or at cash
// reservation — and never recomputed. A cash square reserved at the early
// price and confirmed a week later is still owed the early price.
//
// Date-based, one changeover. A quantity trigger would need an atomic counter,
// a row lock, and a rule for a batch spanning the boundary; a timestamp needs
// none of that.

interface PricedBoard {
  squarePrice: number;
  earlyBirdPriceCents: number | null;
  earlyBirdEndsAt: Date | null;
}

/**
 * The price in effect right now, in cents. Evaluated once per claim — never a
 * function of how many squares have sold (invariant 50).
 */
export function currentPriceCents(board: PricedBoard, now: Date = new Date()): number {
  if (
    board.earlyBirdPriceCents != null &&
    board.earlyBirdEndsAt != null &&
    board.earlyBirdEndsAt > now
  ) {
    return board.earlyBirdPriceCents;
  }
  return board.squarePrice;
}

/**
 * Is the early-bird window open right now?
 *
 * The same predicate `currentPriceCents` uses, exported so display code asks
 * this instead of re-deriving it. Pricing rules live here; nothing that renders
 * a price schedule may reimplement the comparison.
 */
export function earlyBirdActive(board: PricedBoard, now: Date = new Date()): boolean {
  return (
    board.earlyBirdPriceCents != null &&
    board.earlyBirdEndsAt != null &&
    board.earlyBirdEndsAt > now
  );
}

/**
 * The contribution price line, as a host or contributor should read it.
 *
 * Returns the SCHEDULE, never a multiplication. There is no single price on a
 * board with an early-bird window — 20 squares at $1 and 80 at $2 is $180, and
 * neither $100 nor $200 describes it. Anything wanting a total must sum
 * `Square.pricePaidCents` over confirmed squares (invariant 49).
 *
 * A window that has already closed is not mentioned: "through Sep 15, then $30"
 * about a date in the past is noise.
 */
export function priceScheduleLabel(
  board: PricedBoard & { timezone?: string | null },
  now: Date = new Date(),
  /**
   * The noun for one unit, singular. Defaults to "square".
   *
   * A contributor on a fundraiser board with an event bought a TICKET; the
   * square is an implementation detail they never asked about. The host, who
   * runs a board of squares, still sees "square". Same pricing logic, different
   * audience — which is why this is a parameter rather than two functions that
   * can drift.
   */
  unit: string = "square"
): string {
  const money = (cents: number) =>
    `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;
  if (!earlyBirdActive(board, now)) return `${money(board.squarePrice)} per ${unit}`;
  const through = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: board.timezone ?? "America/New_York",
  }).format(board.earlyBirdEndsAt!);
  return `${money(board.earlyBirdPriceCents!)} per ${unit} through ${through}, then ${money(board.squarePrice)}`;
}
