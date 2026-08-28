"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type SquareData = {
  squareId: string;
  position: number;
  playerName: string | null;
  paymentStatus: string;
  paymentMethod: string;
};

// Direct payment strings — fundraiser-board-v2.md §6C.
//
// The word "cash" never appears on a fundraiser board: it means paper money to
// everyone reading it, and there is no paper money here. Contributors are in
// other states and pay by Zelle, CashApp, Venmo, or PayPal.
//
// DISPLAY STRINGS ONLY. cashModeEnabled, cashPin, cashHoldDays and the
// reserved_cash status keep their names in the database and the code —
// renaming a live enum is real risk for zero benefit, and the money doc's
// invariants reference those names.
const COPY = {
  game: {
    heading: "💵 Cash Reservations",
    nameLabel: "Player name",
    reserve: "Reserve",
    awaiting: "⏳ Awaiting cash",
    confirmed: "✓ Cash confirmed",
    confirm: "✓ Confirm",
  },
  fundraiser: {
    heading: "Awaiting payment",
    nameLabel: "Contributor name",
    reserve: "Reserve for contributor",
    awaiting: "Awaiting payment",
    confirmed: "Received",
    confirm: "Mark as received",
  },
} as const;

interface CashReservePanelProps {
  boardId: string;
  squares: SquareData[];
  /// Fundraiser boards use the direct-payment string set — §6C.
  isFundraiser?: boolean;
}

export default function CashReservePanel({
  isFundraiser = false,
  boardId,
  squares,
}: CashReservePanelProps) {
  const copy = COPY[isFundraiser ? "fundraiser" : "game"];
  const router = useRouter();
  const [selectedSquare, setSelectedSquare] = useState("");
  const [playerName, setPlayerName] = useState("");
  const [loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [error, setError] = useState("");

  const openSquares = squares.filter((s) => s.paymentStatus === "open");
  const reservedCashSquares = squares.filter(
    (s) => s.paymentStatus === "reserved_cash" && s.paymentMethod === "cash"
  );
  const paidCashSquares = squares.filter(
    (s) => s.paymentStatus === "paid" && s.paymentMethod === "cash"
  );

  async function handleReserve(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedSquare || !playerName.trim()) return;

    setLoading(true);
    setError("");

    try {
      const res = await fetch(`/api/host/boards/${boardId}/reserve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          squareId: selectedSquare,
          playerName: playerName.trim(),
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        setError(data.error || "Failed to reserve");
        setLoading(false);
        return;
      }

      setSelectedSquare("");
      setPlayerName("");
      router.refresh();
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  }

  async function handleConfirm(squareId: string) {
    setActionLoading(squareId);
    setError("");

    try {
      const res = await fetch(`/api/host/boards/${boardId}/confirm-cash`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ squareId }),
      });

      if (!res.ok) {
        const data = await res.json();
        setError(data.error || "Failed to confirm");
        setActionLoading(null);
        return;
      }

      router.refresh();
    } catch {
      setError("Network error");
    } finally {
      setActionLoading(null);
    }
  }

  async function handleRelease(squareId: string) {
    setActionLoading(squareId);
    setError("");

    try {
      const res = await fetch(`/api/host/boards/${boardId}/release`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ squareId }),
      });

      if (!res.ok) {
        const data = await res.json();
        setError(data.error || "Failed to release");
        setActionLoading(null);
        return;
      }

      router.refresh();
    } catch {
      setError("Network error");
    } finally {
      setActionLoading(null);
    }
  }

  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900 p-4 mb-6">
      <p className="text-sm font-medium mb-3">{copy.heading}</p>

      {/* Reserve form */}
      {openSquares.length > 0 ? (
        <form onSubmit={handleReserve} className="flex items-end gap-2 mb-3">
          <div className="flex-shrink-0">
            <label className="block text-[10px] text-gray-500 mb-1">Square</label>
            <select
              value={selectedSquare}
              onChange={(e) => setSelectedSquare(e.target.value)}
              className="w-20 rounded-lg border border-gray-700 bg-gray-800 px-2 py-2 text-sm text-white focus:outline-none focus:border-indigo-600"
            >
              <option value="">—</option>
              {openSquares.map((s) => (
                <option key={s.squareId} value={s.squareId}>
                  #{s.position + 1}
                </option>
              ))}
            </select>
          </div>
          <div className="flex-1">
            <label className="block text-[10px] text-gray-500 mb-1">{copy.nameLabel}</label>
            <input
              type="text"
              value={playerName}
              onChange={(e) => setPlayerName(e.target.value)}
              placeholder="Earl"
              className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-white placeholder:text-gray-600 focus:outline-none focus:border-indigo-600"
            />
          </div>
          <button
            type="submit"
            disabled={loading || !selectedSquare || !playerName.trim()}
            className="rounded-lg bg-yellow-700 px-3 py-2 text-sm font-medium text-white hover:bg-yellow-600 disabled:opacity-50 transition-colors flex-shrink-0"
          >
            {loading ? "…" : copy.reserve}
          </button>
        </form>
      ) : (
        <p className="text-xs text-gray-500 mb-3">No open squares available.</p>
      )}

      {error && <p className="text-xs text-red-400 mb-3">{error}</p>}

      {/* Pending cash — needs host confirmation */}
      {reservedCashSquares.length > 0 && (
        <div className="mb-3">
          <p className="text-[10px] text-yellow-500 uppercase tracking-wider mb-2">
            {copy.awaiting} ({reservedCashSquares.length})
          </p>
          <div className="space-y-1.5">
            {reservedCashSquares.map((s) => (
              <div
                key={s.squareId}
                className="flex items-center justify-between text-xs bg-yellow-950/40 border border-yellow-900/30 rounded-lg px-3 py-2"
              >
                <span>
                  <span className="text-gray-500">#{s.position + 1}</span>{" "}
                  <span className="text-white font-medium">{s.playerName}</span>
                </span>
                <div className="flex gap-1.5">
                  <button
                    onClick={() => handleConfirm(s.squareId)}
                    disabled={actionLoading === s.squareId}
                    className="text-green-400 hover:text-green-300 font-medium transition-colors disabled:opacity-50"
                  >
                    {actionLoading === s.squareId ? "…" : copy.confirm}
                  </button>
                  <span className="text-gray-700">|</span>
                  <button
                    onClick={() => handleRelease(s.squareId)}
                    disabled={actionLoading === s.squareId}
                    className="text-red-400 hover:text-red-300 transition-colors disabled:opacity-50"
                  >
                    Release
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Confirmed cash squares */}
      {paidCashSquares.length > 0 && (
        <div>
          <p className="text-[10px] text-green-500 uppercase tracking-wider mb-2">
            {copy.confirmed} ({paidCashSquares.length})
          </p>
          <div className="space-y-1.5">
            {paidCashSquares.map((s) => (
              <div
                key={s.squareId}
                className="flex items-center justify-between text-xs bg-gray-800 rounded-lg px-3 py-2"
              >
                <span>
                  <span className="text-gray-500">#{s.position + 1}</span>{" "}
                  <span className="text-white font-medium">{s.playerName}</span>
                </span>
                <button
                  onClick={() => handleRelease(s.squareId)}
                  disabled={actionLoading === s.squareId}
                  className="text-red-400 hover:text-red-300 transition-colors disabled:opacity-50"
                >
                  {actionLoading === s.squareId ? "…" : "Release"}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
