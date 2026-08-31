"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { purchaseUnit } from "@/lib/board-vocabulary";

// Fundraiser host dashboard — fundraiser-board-v2.md §9.
//
// Replaces score entry. Every item on §7's must-not-appear list is absent
// here too — that list governs every fundraiser surface, host included:
// no pot, no randomize-on-close copy, no score entry, no prize pool line.
//
// Phase A has no prizes, so there is no prize pool line to render at all.

interface PendingBatch {
  batchId: string;
  count: number;
  heldMinutes: number;
  expired: boolean;
}

interface AwaitingSquare {
  squareId: string;
  position: number;
  playerName: string | null;
  pricePaidCents: number | null;
}

interface Props {
  boardId: string;
  status: string;
  /// Name the purchase unit with the shared resolver — lib/board-vocabulary.
  hasEvent: boolean;
  hasPrize: boolean;
  finalRaisedCents: number | null;
  raisedCents: number;
  goalCents: number | null;
  confirmedCount: number;
  awaitingCount: number;
  inCheckoutCount: number;
  openCount: number;
  awaitingSquares: AwaitingSquare[];
  pendingBatches: PendingBatch[];
}

function money(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })}`;
}

export default function FundraiserPanel({
  boardId,
  status,
  hasEvent,
  hasPrize,
  finalRaisedCents,
  raisedCents,
  goalCents,
  confirmedCount,
  awaitingCount,
  inCheckoutCount,
  openCount,
  awaitingSquares,
  pendingBatches,
}: Props) {
  // Same resolver as the contributor board: host and contributor never see
  // different nouns for the same purchase unit.
  const u = purchaseUnit({ boardType: "fundraiser", hasEvent, hasPrize });
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function post(url: string, body: unknown, key: string) {
    setBusy(key);
    setError(null);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Something went wrong.");
        return;
      }
      router.refresh();
    } catch {
      setError("Network error.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded-lg border border-red-900/50 bg-red-950/30 p-3">
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}

      {/* Raised. Summed from pricePaidCents on confirmed squares — never a
          count multiplied by a price (invariant 43). */}
      <div className="rounded-lg border border-gray-800 bg-gray-900 p-4">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-2xl font-bold tabular-nums">
            {money(raisedCents)}
          </span>
          <span className="text-sm text-gray-500">
            {goalCents ? `raised of ${money(goalCents)}` : "raised"}
          </span>
        </div>

        {/* The full state breakdown — money doc §10 host view. Awaiting
            payment is the number she works from: those are the contributors
            who said they would send money and have not yet. */}
        <div className="grid grid-cols-4 gap-2 mt-4">
          {[
            { label: "Confirmed", value: confirmedCount, tone: "text-green-400" },
            { label: "Awaiting", value: awaitingCount, tone: "text-yellow-400" },
            { label: "In checkout", value: inCheckoutCount, tone: "text-blue-400" },
            { label: "Open", value: openCount, tone: "text-gray-400" },
          ].map((s) => (
            <div
              key={s.label}
              className="rounded-lg border border-gray-800 bg-gray-950 p-2 text-center"
            >
              <div className={`text-lg font-semibold tabular-nums ${s.tone}`}>
                {s.value}
              </div>
              <div className="text-[10px] text-gray-500 uppercase tracking-wider mt-0.5">
                {s.label}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Awaiting payment — confirm or release PER SQUARE, never as a batch.
          Someone who reserves 3 and sends $100 must be resolvable to 2
          confirmed and 1 released (invariant 7). */}
      {awaitingSquares.length > 0 && (
        <div className="rounded-lg border border-gray-800 bg-gray-900 p-4">
          <p className="text-sm font-medium mb-1">Awaiting payment</p>
          <p className="text-xs text-gray-500 mb-3">
            Confirm each {u.one} as the money arrives. They do not have to be
            resolved together.
          </p>
          <div className="space-y-1.5">
            {awaitingSquares.map((sq) => (
              <div
                key={sq.squareId}
                className="flex items-center justify-between gap-2 text-xs bg-yellow-950/40 border border-yellow-900/30 rounded-lg px-3 py-2"
              >
                <span className="min-w-0 truncate">
                  <span className="font-medium">#{sq.position + 1}</span>{" "}
                  <span className="text-gray-400">
                    {sq.playerName ?? "—"}
                  </span>
                  {/* The amount this square was reserved at, not the board's
                      current price — invariant 42. An early-bird reservation
                      confirmed a week later still owes the early price. */}
                  {sq.pricePaidCents != null && (
                    <span className="text-gray-500">
                      {" "}
                      · {money(sq.pricePaidCents)}
                    </span>
                  )}
                </span>
                <span className="flex gap-1.5 flex-shrink-0">
                  <button
                    type="button"
                    disabled={busy === sq.squareId}
                    onClick={() =>
                      post(
                        `/api/host/boards/${boardId}/confirm-cash`,
                        { squareId: sq.squareId },
                        sq.squareId
                      )
                    }
                    className="rounded-md bg-green-800 px-2 py-1 font-medium text-white hover:bg-green-700 disabled:opacity-50 transition-colors"
                  >
                    {busy === sq.squareId ? "…" : "Mark as received"}
                  </button>
                  <button
                    type="button"
                    disabled={busy === sq.squareId}
                    onClick={() =>
                      post(
                        `/api/host/boards/${boardId}/release`,
                        { squareId: sq.squareId },
                        sq.squareId
                      )
                    }
                    className="rounded-md border border-gray-700 px-2 py-1 text-gray-400 hover:text-white disabled:opacity-50 transition-colors"
                  >
                    Release
                  </button>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* In checkout. Batch age is shown so the release decision is informed
          rather than a guess. The control is ABSENT until the hold expires,
          not disabled — before then the checkout is genuinely live and there
          is nothing to reclaim (invariant 19). */}
      {pendingBatches.length > 0 && (
        <div className="rounded-lg border border-gray-800 bg-gray-900 p-4">
          <p className="text-sm font-medium mb-1">In checkout</p>
          <p className="text-xs text-gray-500 mb-3">
            Someone is paying right now. Releasing checks with the payment
            processor first, so a payment that went through is never lost.
          </p>
          <div className="space-y-1.5">
            {pendingBatches.map((b) => (
              <div
                key={b.batchId}
                className="flex items-center justify-between gap-2 text-xs bg-blue-950/30 border border-blue-900/30 rounded-lg px-3 py-2"
              >
                <span>
                  {b.count} {b.count === 1 ? u.one : u.many}, held{" "}
                  {b.heldMinutes} min
                </span>
                {b.expired && (
                  <button
                    type="button"
                    disabled={busy === b.batchId}
                    onClick={() =>
                      post(
                        `/api/host/boards/${boardId}/resolve-hold`,
                        { batchId: b.batchId },
                        b.batchId
                      )
                    }
                    className="rounded-md border border-gray-700 px-2 py-1 text-gray-400 hover:text-white disabled:opacity-50 transition-colors flex-shrink-0"
                  >
                    {busy === b.batchId ? "…" : "Release"}
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Close — money doc 7 */}
      {status === "closed" ? (
        <div className="rounded-lg border border-gray-800 bg-gray-900 p-4">
          <p className="text-sm font-medium">Campaign closed</p>
          <p className="text-xs text-gray-500 mt-0.5">
            Final total: {finalRaisedCents != null ? money(finalRaisedCents) : "—"}.
            This figure is locked and will not change.
          </p>
          <p className="text-xs text-gray-600 mt-2 leading-relaxed">
            Tickets still work. The campaign has ended; the event has not.
          </p>
        </div>
      ) : (
        <div className="rounded-lg border border-gray-800 bg-gray-900 p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium">
                {status === "closing" ? "Finishing up" : "Close early"}
              </p>
              <p className="text-xs text-gray-500 mt-0.5">
                {status === "closing"
                  ? "No longer accepting contributions. Resolve what is outstanding to finalize."
                  : "Stop accepting contributions and finalize what you raised."}
              </p>
            </div>
            <button
              type="button"
              disabled={busy === "close"}
              onClick={() => {
                if (
                  status !== "closing" &&
                  !confirm(
                    "Stop accepting contributions now? This cannot be undone."
                  )
                ) {
                  return;
                }
                void post(
                  `/api/host/boards/${boardId}/close-campaign`,
                  {},
                  "close"
                );
              }}
              className="flex-shrink-0 rounded-lg border border-gray-700 px-3 py-2 text-sm text-gray-300 hover:text-white hover:border-gray-600 disabled:opacity-50 transition-colors"
            >
              {busy === "close"
                ? "..."
                : status === "closing"
                  ? "Finalize"
                  : "Close"}
            </button>
          </div>

          {/* Required by 9. A dispute after the fact comes out of proceeds. */}
          <p className="text-xs text-gray-600 mt-3 leading-relaxed">
            The final total is locked once the campaign closes. If a
            contribution is later disputed through the contributor&apos;s bank,
            that amount comes out of your proceeds.
          </p>
        </div>
      )}
    </div>
  );
}
