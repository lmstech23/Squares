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
  position: number;
  paymentStatus: string;
}

interface Props {
  squares: GridSquare[];
}

export default function FundraiserGrid({ squares }: Props) {
  return (
    <div className="grid grid-cols-5 min-[400px]:grid-cols-10 gap-1">
      {squares.map((sq) => {
        const taken = sq.paymentStatus !== "open";
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
      })}
    </div>
  );
}
