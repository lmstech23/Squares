import FundraiserGrid from "./fundraiser-grid";

// Contributor board — fundraiser-board-v2.md §6 and §7.
//
// Mobile first: these links go into texts and parent chats, so this is
// designed at 360px. Four questions above the first scroll — what is this,
// how's it going, what's the fun, what do I do.
//
// Phase A boards carry no prize, so the third block is supporter momentum
// rather than a prize pool. Never leave a hole there: a no-prize board must
// not read as the diminished version of a prize board.
//
// Nothing here computes money from square count. `raised` is summed from
// pricePaidCents by the caller (invariant 43).

interface GridSquare {
  position: number;
  paymentStatus: string;
}

interface Props {
  title: string;
  causeDescription: string | null;
  hostName: string | null;
  squares: GridSquare[];
  squarePrice: number;
  earlyBirdPriceCents: number | null;
  earlyBirdEndsAt: Date | null;
  /// Decided by the caller, not here: "is the changeover still ahead" depends
  /// on the current time, which makes it impure inside render.
  earlyBirdActive: boolean;
  timezone: string | null;
  raisedCents: number;
  goalCents: number;
  supporterCount: number;
  openCount: number;
}

function money(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })}`;
}

/** "Sept 15" in the board's own timezone, never the server's. */
function shortDate(date: Date, timeZone: string | null): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: timeZone ?? "America/New_York",
  }).format(date);
}

export default function FundraiserView({
  title,
  causeDescription,
  hostName,
  squares,
  squarePrice,
  earlyBirdPriceCents,
  earlyBirdEndsAt,
  earlyBirdActive,
  timezone,
  raisedCents,
  goalCents,
  supporterCount,
  openCount,
}: Props) {
  // The schedule line renders only while the early bird price is still in
  // effect. Once the changeover has passed there is one price again, and
  // saying "through Sept 15, then $30" about a date in the past is noise.
  const showSchedule =
    earlyBirdActive && earlyBirdPriceCents != null && earlyBirdEndsAt != null;

  const currentPrice = showSchedule ? earlyBirdPriceCents : squarePrice;

  const pct = goalCents > 0 ? Math.min(100, (raisedCents / goalCents) * 100) : 0;

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <div className="max-w-lg mx-auto px-4 py-6">
        {/* What is this */}
        <h1 className="text-xl font-bold leading-tight">{title}</h1>
        {causeDescription && (
          <p className="text-sm text-gray-400 mt-1.5 leading-relaxed">
            {causeDescription}
          </p>
        )}
        <p className="text-sm text-gray-500 mt-2">
          {showSchedule ? (
            <>
              {money(earlyBirdPriceCents!)} per square through{" "}
              {shortDate(earlyBirdEndsAt, timezone)}, then {money(squarePrice)}
            </>
          ) : (
            <>{money(squarePrice)} per square</>
          )}
          {hostName && <span> · hosted by {hostName}</span>}
        </p>

        {/* How's it going. `raised` is a sum of pricePaidCents, never a count
            multiplied by a price — invariant 43. The qualifier matters: a bare
            number reads as final. */}
        <div className="mt-5">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-2xl font-bold tabular-nums">
              {money(raisedCents)}
            </span>
            <span className="text-sm text-gray-500">
              raised of {money(goalCents)}
            </span>
          </div>
          <div className="mt-2 h-2.5 bg-gray-800 rounded-full overflow-hidden">
            <div
              className="h-full bg-green-500 rounded-full transition-all duration-500"
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>

        {/* What's the fun — supporter momentum on a no-prize board. Phase A
            renders no prize pool line at all. */}
        <p className="text-sm text-gray-400 mt-3">
          {supporterCount} {supporterCount === 1 ? "supporter" : "supporters"} so
          far
          <span className="text-gray-600"> · </span>
          {openCount} {openCount === 1 ? "square" : "squares"} left
        </p>

        {/* What do I do.
            A4 SCAFFOLD — the claim flow is A5 (quantity, picker, batching,
            pricePaidCents at claim, admission preparation). The button is
            rendered in its final form but inert until then, so A4 must not
            ship on its own. */}
        <div className="mt-5">
          <button
            type="button"
            disabled
            className="w-full rounded-lg bg-white px-4 py-3 text-sm font-medium text-gray-950 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Claim a square — {money(currentPrice)}
          </button>
        </div>

        {/* The board is the visualization; the button is the action. Nobody
            should have to study the grid to work out what to do. */}
        <div className="mt-6">
          <FundraiserGrid squares={squares} />
        </div>
      </div>
    </div>
  );
}
