// Fundraiser grid — fundraiser-board-v2.md §7.
//
// No row or column meaning, so no axis math and no digit assignment. This is
// deliberately NOT the Game Day grid component: reusing that one is how axis
// labels, digit randomization and pot arithmetic leak onto a fundraiser board.
//
// Always 10 columns, wrapping — 25 squares is 10/10/5, not a rectangle. Five
// columns below 400px. Any non-open square renders as unavailable with no
// legend and no state colors (money doc §10): the public board never
// distinguishes pending from reserved from paid.

interface GridSquare {
  squareId: string;
  position: number;
  paymentStatus: string;
}

interface Props {
  squares: GridSquare[];
  /// Square ids the contributor has picked. Selection lives on the board so
  /// the checkout button can say how many tickets they are buying.
  selected?: string[];
  onToggle?: (squareId: string) => void;
}

export default function FundraiserGrid({ squares, selected = [], onToggle }: Props) {
  const picked = new Set(selected);

  return (
    <div className="grid grid-cols-5 min-[400px]:grid-cols-10 gap-1">
      {squares.map((sq) => {
        const taken = sq.paymentStatus !== "open";
        const isPicked = picked.has(sq.squareId);

        // Taken squares are inert. Open ones are only interactive when a
        // handler is supplied, so the grid still renders read-only.
        if (taken || !onToggle) {
          return (
            <div
              key={sq.position}
              className={`aspect-square rounded-sm flex items-center justify-center text-[10px] tabular-nums select-none ${
                taken
                  ? "bg-green-600/30 text-green-300/80 border border-green-700/40"
                  : "bg-gray-900 text-gray-700 border border-gray-800"
              }`}
            >
              {/* Square numbers are 1-based for humans; position is 0-based. */}
              {taken ? sq.position + 1 : ""}
            </div>
          );
        }

        return (
          <button
            key={sq.position}
            type="button"
            onClick={() => onToggle(sq.squareId)}
            aria-pressed={isPicked}
            className={`aspect-square rounded-sm flex items-center justify-center text-[10px] tabular-nums transition-colors ${
              isPicked
                ? "bg-green-950/60 text-green-200 border border-green-500"
                : "bg-gray-900 text-gray-700 border border-gray-800 hover:border-gray-700"
            }`}
          >
            {isPicked ? sq.position + 1 : ""}
          </button>
        );
      })}
    </div>
  );
}
