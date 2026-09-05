"use client";

import { useEffect, useState } from "react";

// Checkout hold countdown — fundraiser-board-v2.md §6, money doc §3.
//
// The client renders against the SERVER's holdExpiresAt, never a local
// counter. A local counter drifts, and stalls entirely when a phone
// backgrounds the tab — which is exactly what happens when someone switches
// apps to find their card. Recomputing the remaining time from a fixed
// timestamp on every tick means backgrounding costs nothing: the next tick
// after resume shows the truth.
//
// This is the Ticketmaster pattern. The hold already existed; nobody could
// see it.

interface Props {
  /** Server-set holdExpiresAt, as an ISO string. */
  expiresAt: string;
  /**
   * Server payment status of the squares this hold covers, as the page last
   * rendered them.
   *
   * A countdown is only ever about squares that are still `pending`. Without
   * this the component knew nothing but a timestamp written into sessionStorage
   * at claim time, so it announced "your hold expired" for squares that had
   * been PAID minutes earlier — a contributor watching a confirmation banner
   * and a release warning at the same time. The timestamp cannot answer
   * "did this purchase succeed"; only the server can.
   */
  heldStatuses: string[];
  /** Re-open the claim sheet with the same squares preselected. */
  onReclaim: () => void;
  onDismiss: () => void;
  /// Contributor-facing noun. "squares" on Game Day, "tickets" on an event
  /// fundraiser — one shared resolver, never branched locally.
  unit: { one: string; many: string };
  /// Only present once a live hold can actually be acted on: the three
  /// actions need the square and the email that claimed it. Absent on Game
  /// Day and on holds stored before this shipped, where the banner keeps its
  /// old countdown-only shape.
  actions?: {
    busy: null | "resume" | "cash" | "release";
    onResume: () => void;
    onSwitchToCash: () => void;
    onRelease: () => void;
    cashAvailable: boolean;
  };
}

function remainingMs(expiresAt: string): number {
  return new Date(expiresAt).getTime() - Date.now();
}

export default function HoldTimer({
  expiresAt,
  heldStatuses,
  onReclaim,
  onDismiss,
  unit,
  actions,
}: Props) {
  const [left, setLeft] = useState(() => remainingMs(expiresAt));

  useEffect(() => {
    const id = setInterval(() => setLeft(remainingMs(expiresAt)), 1000);
    return () => clearInterval(id);
  }, [expiresAt]);

  // A hold only exists while squares are pending. Anything else — paid,
  // reserved_cash, or released back to open — means the hold is over and the
  // server has already said so. Render nothing rather than a countdown or an
  // expiry warning about a settled purchase.
  //
  // Checked BEFORE the timer is consulted, deliberately: a paid square must
  // never reach the expiry branch, whatever the clock says.
  const stillPending = heldStatuses.some((st) => st === "pending");
  if (heldStatuses.length > 0 && !stillPending) return null;

  const expired = left <= 0;

  if (expired) {
    // Resolution can lag the displayed zero by up to one cron cycle, and the
    // squares are unavailable to others either way — so this says what the
    // contributor can act on rather than asserting a state we haven't
    // confirmed. An explanation, not a dead end (§6).
    return (
      <div className="rounded-lg border border-gray-800 bg-gray-900 p-4 mb-5">
        <p className="text-sm font-medium">Your hold expired.</p>
        <p className="text-xs text-gray-500 mt-1">
          Your {unit.many} are being released. Claim them again?
        </p>
        <div className="flex gap-2 mt-3">
          <button
            type="button"
            onClick={onReclaim}
            className="rounded-lg bg-white px-3 py-2 text-sm font-medium text-gray-950 hover:bg-gray-200 transition-colors"
          >
            Claim them again
          </button>
          <button
            type="button"
            onClick={onDismiss}
            className="rounded-lg px-3 py-2 text-sm text-gray-400 hover:text-white transition-colors"
          >
            No thanks
          </button>
        </div>
      </div>
    );
  }

  const totalSeconds = Math.floor(left / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return (
    <div className="rounded-lg border border-yellow-900/50 bg-yellow-950/30 p-4 mb-5">
      <p className="text-sm text-yellow-200">
        Your {unit.many} are held for{" "}
        <span className="font-semibold tabular-nums">
          {minutes}:{String(seconds).padStart(2, "0")}
        </span>
      </p>
      <p className="text-xs text-yellow-200/60 mt-1">
        Finish checkout before the timer runs out and they are yours.
      </p>

      {/* A COUNTDOWN WITH NO BUTTONS IS A DEAD END. Someone who pressed Back
          in Stripe was locked out of their own purchase for ten minutes: no
          way to pay another way, no way to hand the {unit.many} back. All
          three things they might want are here. */}
      {actions && (
        <div className="flex flex-wrap gap-2 mt-3">
          <button
            type="button"
            onClick={actions.onResume}
            disabled={actions.busy !== null}
            className="rounded-lg bg-yellow-200 px-3 py-2 text-sm font-medium text-gray-950 hover:bg-yellow-100 disabled:opacity-40 transition-colors"
          >
            {actions.busy === "resume" ? "Opening…" : "Finish card payment"}
          </button>
          {actions.cashAvailable && (
            <button
              type="button"
              onClick={actions.onSwitchToCash}
              disabled={actions.busy !== null}
              className="rounded-lg border border-yellow-800 px-3 py-2 text-sm text-yellow-100 hover:border-yellow-600 disabled:opacity-40 transition-colors"
            >
              {actions.busy === "cash" ? "Switching…" : "Pay another way"}
            </button>
          )}
          <button
            type="button"
            onClick={actions.onRelease}
            disabled={actions.busy !== null}
            className="rounded-lg px-3 py-2 text-sm text-yellow-200/70 hover:text-yellow-100 disabled:opacity-40 transition-colors"
          >
            {actions.busy === "release" ? "Releasing…" : `Release these ${unit.many}`}
          </button>
        </div>
      )}
    </div>
  );
}
