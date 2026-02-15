type SquareData = {
  squareId: string;
  position: number;
  playerName: string | null;
  paymentStatus: string;
};

function getInitials(name: string): string {
  return name
    .split(" ")
    .map((w) => w[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

interface BoardGridProps {
  squares: SquareData[];
  rowNumbers?: number[];
  colNumbers?: number[];
  teamCol?: string;
  teamRow?: string;
  winnerPositions?: Set<number>;
}

export default function BoardGrid({
  squares,
  rowNumbers,
  colNumbers,
  teamCol,
  teamRow,
  winnerPositions,
}: BoardGridProps) {
  const hasNumbers = (rowNumbers?.length ?? 0) === 10 && (colNumbers?.length ?? 0) === 10;

  return (
    <div className="overflow-x-auto">
      {/* Team col label — above the grid */}
      {hasNumbers && teamCol && (
        <div className="text-[10px] uppercase tracking-wider text-indigo-400 font-medium text-center mb-1 ml-8">
          {teamCol}
        </div>
      )}

      <div className="flex">
        {/* Team row label — rotated left of grid */}
        {hasNumbers && teamRow && (
          <div className="flex items-center justify-center mr-1">
            <span
              className="text-[10px] uppercase tracking-wider text-indigo-400 font-medium"
              style={{ writingMode: "vertical-lr", transform: "rotate(180deg)" }}
            >
              {teamRow}
            </span>
          </div>
        )}

        <div
          className="inline-grid gap-1"
          style={{
            gridTemplateColumns: hasNumbers
              ? `32px repeat(10, 1fr)`
              : `repeat(10, 1fr)`,
          }}
        >
          {/* Column headers */}
          {hasNumbers && (
            <>
              <div />
              {colNumbers.map((num, i) => (
                <div
                  key={`col-${i}`}
                  className="flex items-center justify-center text-xs font-bold text-gray-400 h-7"
                >
                  {num}
                </div>
              ))}
            </>
          )}

          {/* Grid rows */}
          {Array.from({ length: 10 }, (_, row) => (
            <div key={`row-${row}`} className="contents">
              {/* Row header */}
              {hasNumbers && (
                <div className="flex items-center justify-center text-xs font-bold text-gray-400 w-7">
                  {rowNumbers[row]}
                </div>
              )}

              {/* Squares in this row */}
              {Array.from({ length: 10 }, (_, col) => {
                const position = row * 10 + col;
                const sq = squares[position];
                if (!sq) return null;

                const isPaid = sq.paymentStatus === "paid";
                const isPending = sq.paymentStatus === "pending";
                const isWinner = winnerPositions?.has(position) ?? false;

                return (
                  <div
                    key={sq.squareId}
                    className={`aspect-square rounded-md flex items-center justify-center text-[10px] font-medium transition-colors min-w-[28px] ${
                      isWinner && isPaid
                        ? "bg-yellow-500/20 border-2 border-yellow-400 text-yellow-300 ring-1 ring-yellow-400/30"
                        : isPaid
                          ? "bg-green-950 border border-green-900 text-green-400"
                          : isPending
                            ? "bg-yellow-950 border border-yellow-900 text-yellow-500"
                            : "bg-gray-900 border border-gray-800 text-gray-700"
                    }`}
                    title={
                      isPaid
                        ? `${sq.playerName ?? "Paid"}${isWinner ? " ★ WINNER" : ""}`
                        : isPending
                          ? "Pending payment"
                          : "Open"
                    }
                  >
                    {isWinner && isPaid
                      ? "★"
                      : isPaid && sq.playerName
                        ? getInitials(sq.playerName)
                        : isPending
                          ? "…"
                          : ""}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
