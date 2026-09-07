// Does this board offer a SQUARE product to a contributor, and if so, what?
//
// THE ONE PLACE THAT DECIDES. Extracted from the board page so the rule can be
// tested without a React renderer, and so there is a single expression to read
// when asking "why did a square button appear on this board".
//
// NULL IS "NOT OFFERED", WHICH IS NOT "SOLD OUT". Those had the same shape
// until now - an empty list with a zero count - and that is exactly how the
// defect shipped. A board can hold a hundred `open` Square rows it must never
// sell: they are inert, invisible, and counted by nothing. Handing the view an
// empty product would have produced a disabled "Every ticket is claimed"
// button, which is the same defect wearing a different label. Only absence
// says neither.
//
// The count is derived HERE, from the same rows that are returned, so the list
// and the number cannot disagree about what is open.

export interface SquareSummary {
  squareId: string;
  position: number;
  paymentStatus: string;
}

export interface SquareProduct<P> {
  squares: SquareSummary[];
  openCount: number;
  price: P;
}

/**
 * `null` when the board sells no squares.
 *
 * Generic over the price so this module does not depend on the pricing types;
 * the caller passes whatever `publicPriceDisplay()` returned and gets it back
 * unchanged. Pass-through is the point — this function decides IF, never WHAT.
 */
export function squareProductFor<P>(
  board: { raffleEnabled: boolean },
  squares: SquareSummary[],
  price: P
): SquareProduct<P> | null {
  if (!board.raffleEnabled) return null;
  return {
    squares,
    openCount: squares.filter((sq) => sq.paymentStatus === "open").length,
    price,
  };
}
