// Contribution pricing — fundraiser-money-state-machine.md §8B, invariants 42–44.
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
 * function of how many squares have sold (invariant 44).
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
