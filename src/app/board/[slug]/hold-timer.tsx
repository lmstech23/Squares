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
  /** Re-open the claim sheet with the same squares preselected. */
  onReclaim: () => void;
  onDismiss: () => void;
}

function remainingMs(expiresAt: string): number {
  return new Date(expiresAt).getTime() - Date.now();
}

export default function HoldTimer({ expiresAt, onReclaim, onDismiss }: Props) {
  const [left, setLeft] = useState(() => remainingMs(expiresAt));

  useEffect(() => {
    const id = setInterval(() => setLeft(remainingMs(expiresAt)), 1000);
    return () => clearInterval(id);
  }, [expiresAt]);

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
          Your squares are being released. Claim them again?
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
        Your squares are held for{" "}
        <span className="font-semibold tabular-nums">
          {minutes}:{String(seconds).padStart(2, "0")}
        </span>
      </p>
      <p className="text-xs text-yellow-200/60 mt-1">
        Finish checkout before the timer runs out and they are yours.
      </p>
    </div>
  );
}
