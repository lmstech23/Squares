"use client";

import { useEffect, useState } from "react";
import FundraiserGrid from "./fundraiser-grid";
import ClaimSheet from "./claim-sheet";
import HoldTimer from "./hold-timer";

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
  squareId: string;
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
  /// Null = no goal set. No bar, no denominator — v2 §7.
  goalCents: number | null;
  supporterCount: number;
  openCount: number;
  slug: string;
  hasEvent: boolean;
  cashModeEnabled: boolean;
  stripeConnected: boolean;
  handles: {
    venmo: string | null;
    zelle: string | null;
    cashapp: string | null;
    paypal: string | null;
  };
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
  slug,
  hasEvent,
  cashModeEnabled,
  stripeConnected,
  handles,
}: Props) {
  const [claiming, setClaiming] = useState(false);
  const [reclaim, setReclaim] = useState<string[] | undefined>(undefined);

  // A hold this browser started, remembered at claim time. The server
  // timestamp is the truth; this is only how we know to show a countdown to
  // someone who came back from Stripe without paying.
  const [hold, setHold] = useState<{
    holdExpiresAt: string;
    squareIds: string[];
  } | null>(null);

  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(`daali-hold-${slug}`);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      // Drop a hold that expired long enough ago that the cron has certainly
      // resolved it — showing a stale countdown is worse than showing none.
      if (new Date(parsed.holdExpiresAt).getTime() < Date.now() - 15 * 60_000) {
        sessionStorage.removeItem(`daali-hold-${slug}`);
        return;
      }
      // sessionStorage cannot be read during SSR or from a state initializer
      // without risking a hydration mismatch, so a one-shot read after mount
      // is the only correct option here. Runs once per slug, sets state once.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setHold(parsed);
    } catch {
      // Unreadable or disabled storage — no countdown, nothing broken.
    }
  }, [slug]);

  function clearHold() {
    try {
      sessionStorage.removeItem(`daali-hold-${slug}`);
    } catch {
      // Nothing to do — the banner is dismissed either way.
    }
    setHold(null);
  }
  // The schedule line renders only while the early bird price is still in
  // effect. Once the changeover has passed there is one price again, and
  // saying "through Sept 15, then $30" about a date in the past is noise.
  const showSchedule =
    earlyBirdActive && earlyBirdPriceCents != null && earlyBirdEndsAt != null;

  const currentPrice = showSchedule ? earlyBirdPriceCents : squarePrice;

  // Clamped at 100% when raised exceeds the goal — the real figure still shows
  // above the bar. v2 §7.
  const pct =
    goalCents && goalCents > 0
      ? Math.min(100, (raisedCents / goalCents) * 100)
      : null;

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
              {goalCents ? <>raised of {money(goalCents)}</> : <>raised</>}
            </span>
          </div>
          {pct !== null && (
            <div className="mt-2 h-2.5 bg-gray-800 rounded-full overflow-hidden">
              <div
                className="h-full bg-green-500 rounded-full transition-all duration-500"
                style={{ width: `${pct}%` }}
              />
            </div>
          )}
        </div>

        {/* What's the fun — supporter momentum on a no-prize board. Phase A
            renders no prize pool line at all. */}
        <p className="text-sm text-gray-400 mt-3">
          {supporterCount} {supporterCount === 1 ? "supporter" : "supporters"} so
          far
          <span className="text-gray-600"> · </span>
          {openCount} {openCount === 1 ? "square" : "squares"} left
        </p>

        {hold && (
          <div className="mt-5">
            <HoldTimer
              expiresAt={hold.holdExpiresAt}
              onReclaim={() => {
                setReclaim(hold.squareIds);
                clearHold();
                setClaiming(true);
              }}
              onDismiss={clearHold}
            />
          </div>
        )}

        {/* What do I do */}
        <div className="mt-5">
          <button
            type="button"
            onClick={() => setClaiming(true)}
            disabled={openCount === 0}
            className="w-full rounded-lg bg-white px-4 py-3 text-sm font-medium text-gray-950 hover:bg-gray-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {openCount === 0
              ? "Every square is claimed"
              : `Claim a square — ${money(currentPrice)}`}
          </button>
        </div>

        {/* The board is the visualization; the button is the action. Nobody
            should have to study the grid to work out what to do. */}
        <div className="mt-6">
          <FundraiserGrid squares={squares} />
        </div>

        {claiming && (
          <ClaimSheet
            openSquares={squares
              .filter((sq) => sq.paymentStatus === "open")
              .map((sq) => ({ squareId: sq.squareId, position: sq.position }))}
            priceCents={currentPrice}
            hasEvent={hasEvent}
            cashModeEnabled={cashModeEnabled}
            stripeConnected={stripeConnected}
            handles={handles}
            slug={slug}
            initialPicked={reclaim?.filter((id) =>
              squares.some(
                (sq) => sq.squareId === id && sq.paymentStatus === "open"
              )
            )}
            onClose={() => {
              setClaiming(false);
              setReclaim(undefined);
            }}
          />
        )}
      </div>
    </div>
  );
}
