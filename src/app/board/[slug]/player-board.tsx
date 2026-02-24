"use client";

import { useState, useCallback } from "react";

type SquareData = {
  squareId: string;
  position: number;
  playerName: string | null;
  paymentStatus: string;
};

interface PlayerBoardProps {
  boardId: string;
  slug: string;
  squares: SquareData[];
  squarePrice: number; // cents
  maxPerPlayer: number;
  status: string;
  rowNumbers?: number[];
  colNumbers?: number[];
  teamCol?: string;
  teamRow?: string;
  winnerPositions?: number[];
  cashModeEnabled?: boolean;
}

function getInitials(name: string): string {
  const parts = name.trim().split(" ").filter(Boolean);
  if (parts.length === 1) {
    return parts[0].slice(0, 2).toUpperCase();
  }
  return parts
    .map((w) => w[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

export default function PlayerBoard({
  slug,
  squares: initialSquares,
  squarePrice,
  maxPerPlayer,
  status,
  rowNumbers,
  colNumbers,
  teamCol,
  teamRow,
  winnerPositions: winnerPositionsArr,
  cashModeEnabled = false,
}: PlayerBoardProps) {
  const [squares] = useState(initialSquares);
  const [selectedSquare, setSelectedSquare] = useState<SquareData | null>(null);
  const [playerName, setPlayerName] = useState("");
  const [playerEmail, setPlayerEmail] = useState("");
  const [cashPin, setCashPin] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [cashSuccess, setCashSuccess] = useState(false);
  const [paymentMode, setPaymentMode] = useState<"card" | "cash">("card");

  const isOpen = status === "open";
  const hasNumbers = rowNumbers && colNumbers;
  const priceDisplay = `$${squarePrice / 100}`;
  const winnerSet = new Set(winnerPositionsArr ?? []);

  const handleSquareTap = useCallback(
    (sq: SquareData) => {
      if (!isOpen) return;
      if (sq.paymentStatus !== "open") return;
      setSelectedSquare(sq);
      setError("");
      setCashSuccess(false);
      setPaymentMode("card");
    },
    [isOpen]
  );

  const handleClose = useCallback(() => {
    setSelectedSquare(null);
    setError("");
    setCashSuccess(false);
  }, []);

  async function handleCheckout(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedSquare) return;

    const trimmedName = playerName.trim();
    const trimmedEmail = playerEmail.trim().toLowerCase();

    if (!trimmedName) {
      setError("Name is required.");
      return;
    }

    if (!trimmedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      setError("Valid email is required.");
      return;
    }

    setLoading(true);
    setError("");

    try {
      const res = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          squareId: selectedSquare.squareId,
          playerName: trimmedName,
          playerEmail: trimmedEmail,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Something went wrong. Try again.");
        setLoading(false);
        return;
      }

      // Redirect to Stripe Checkout
      window.location.href = data.checkoutUrl;
    } catch {
      setError("Network error. Please try again.");
      setLoading(false);
    }
  }

  async function handleCashReserve(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedSquare) return;

    const trimmedName = playerName.trim();
    const trimmedPin = cashPin.trim();

    if (!trimmedName) {
      setError("Name is required.");
      return;
    }

    if (!/^\d{4}$/.test(trimmedPin)) {
      setError("Enter the 4-digit PIN from the host.");
      return;
    }

    setLoading(true);
    setError("");

    try {
      const res = await fetch(`/api/board/${slug}/cash-reserve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          squareId: selectedSquare.squareId,
          playerName: trimmedName,
          pin: trimmedPin,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Something went wrong. Try again.");
        setLoading(false);
        return;
      }

      setCashSuccess(true);
      setLoading(false);
    } catch {
      setError("Network error. Please try again.");
      setLoading(false);
    }
  }

  return (
    <div>
      {/* Instruction line */}
      {isOpen && (
        <p className="text-xs text-gray-500 mb-3">
          Pick a square. {priceDisplay} each.
        </p>
      )}

      {/* Grid */}
      <div className="overflow-x-auto w-fit mx-auto">
        <div className="grid grid-cols-[28px_1fr] grid-rows-[auto_1fr] gap-1">

          {/* top-left corner spacer */}
          <div />

          {/* Team col label (attached to grid) */}
          {hasNumbers && teamCol ? (
            <div className="text-[10px] uppercase tracking-wider text-indigo-400 font-medium text-center">
              {teamCol}
            </div>
          ) : (
            <div />
          )}

          {/* Team row label (attached + centered to square area) */}
          {hasNumbers && teamRow ? (
            <div className="flex items-center justify-center">
              <span
                className="text-[10px] uppercase tracking-wider text-indigo-400 font-medium"
                style={{ writingMode: "vertical-lr", transform: "rotate(180deg)" }}
              >
                {teamRow}
              </span>
            </div>
          ) : (
            <div />
          )}

          {/* Board grid */}
          <div
            className="inline-grid gap-1"
            style={{
              gridTemplateColumns: hasNumbers ? `28px repeat(10, 1fr)` : `repeat(10, 1fr)`,
            }}
          >
            {/* Column headers */}
            {hasNumbers && (
              <>
                <div />
                {colNumbers.map((num, i) => (
                  <div
                    key={`col-${i}`}
                    className="flex items-center justify-center text-[10px] font-bold text-gray-500 h-6"
                  >
                    {num}
                  </div>
                ))}
              </>
            )}

            {/* Grid rows */}
            {Array.from({ length: 10 }, (_, row) => (
              <div key={`row-${row}`} className="contents">
                {hasNumbers && (
                  <div className="flex items-center justify-center text-[10px] font-bold text-gray-500 w-7">
                    {rowNumbers[row]}
                  </div>
                )}

                {Array.from({ length: 10 }, (_, col) => {
                  const position = row * 10 + col;
                  const sq = squares[position];
                  if (!sq) return null;

                  const isPaid = sq.paymentStatus === "paid";
                  const isPending = sq.paymentStatus === "pending";
                  const isAvailable = sq.paymentStatus === "open" && isOpen;
                  const isSelected = selectedSquare?.squareId === sq.squareId;
                  const isWinner = winnerSet.has(position) && isPaid;

                  return (
                    <button
                      key={sq.squareId}
                      disabled={!isAvailable}
                      onClick={() => handleSquareTap(sq)}
                      className={`aspect-square rounded-md flex items-center justify-center text-[10px] font-medium transition-all min-w-[28px] ${
                        isSelected
                          ? "bg-indigo-600 border-2 border-indigo-400 text-white ring-2 ring-indigo-500/30"
                          : isWinner
                            ? "bg-yellow-500/20 border-2 border-yellow-400 text-yellow-300 ring-1 ring-yellow-400/30"
                            : isPaid
                              ? "bg-green-950 border border-green-900 text-green-400"
                              : isPending
                                ? "bg-yellow-950 border border-yellow-900 text-yellow-500"
                                : isAvailable
                                  ? "bg-gray-900 border border-gray-800 text-gray-600 hover:border-indigo-700 hover:bg-indigo-950/30 active:scale-95 cursor-pointer"
                                  : "bg-gray-900 border border-gray-800 text-gray-700"
                      }`}
                      title={
                        isWinner
                          ? `★ WINNER — ${sq.playerName ?? "Paid"}`
                          : isPaid
                            ? sq.playerName ?? "Paid"
                            : isPending
                              ? "Pending payment"
                              : isAvailable
                                ? `Square ${position + 1} — ${priceDisplay}`
                                : "Unavailable"
                      }
                    >
                      {isWinner
                        ? "★"
                        : isPaid && sq.playerName
                          ? getInitials(sq.playerName)
                          : isPending
                            ? "…"
                            : <span className="text-gray-700">{position + 1}</span>}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </div>
      </div>

      {/* Legend */}
      <div className="flex items-center gap-4 mt-3 text-[10px] text-gray-600">
        <span className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-sm bg-gray-900 border border-gray-800" />
          Open
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-sm bg-green-950 border border-green-900" />
          Taken
        </span>
        {isOpen && (
          <span className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-sm bg-yellow-950 border border-yellow-900" />
            Pending
          </span>
        )}
        {winnerSet.size > 0 && (
          <span className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-sm bg-yellow-500/20 border-2 border-yellow-400" />
            Winner
          </span>
        )}
      </div>

      {/* Claim Modal — slides up when square is selected */}
      {selectedSquare && isOpen && (
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 bg-black/60 z-40"
            onClick={handleClose}
          />

          {/* Sheet */}
          <div className="fixed bottom-0 left-0 right-0 z-50 animate-slide-up">
            <div className="max-w-lg mx-auto bg-gray-900 border-t border-gray-800 rounded-t-2xl p-5">
              {/* Handle */}
              <div className="w-10 h-1 bg-gray-700 rounded-full mx-auto mb-4" />

              {/* Cash success state */}
              {cashSuccess ? (
                <div className="text-center py-4">
                  <div className="text-3xl mb-2">✓</div>
                  <p className="text-sm font-medium text-green-300">
                    Square reserved!
                  </p>
                  <p className="text-xs text-gray-500 mt-1">
                    Hand your cash to the host to confirm.
                  </p>
                  <button
                    onClick={() => window.location.reload()}
                    className="mt-4 rounded-lg border border-gray-700 px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors"
                  >
                    Done
                  </button>
                </div>
              ) : (
                <>
                  <div className="flex items-center justify-between mb-4">
                    <div>
                      <p className="text-sm font-medium">
                        Square #{selectedSquare.position + 1}
                      </p>
                      <p className="text-xs text-gray-500 mt-0.5">
                        {priceDisplay} — {paymentMode === "card" ? "pay to lock it in" : "reserve with cash"}
                      </p>
                    </div>
                    <button
                      onClick={handleClose}
                      className="text-gray-500 hover:text-white p-1 transition-colors"
                      aria-label="Close"
                    >
                      <svg
                        width="20"
                        height="20"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={2}
                      >
                        <path d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>

                  {/* Payment mode tabs — only show if cash mode is enabled */}
                  {cashModeEnabled && (
                    <div className="flex gap-1 mb-4 p-1 rounded-lg bg-gray-800">
                      <button
                        onClick={() => {
                          setPaymentMode("card");
                          setError("");
                        }}
                        className={`flex-1 rounded-md py-1.5 text-xs font-medium transition-colors ${
                          paymentMode === "card"
                            ? "bg-gray-700 text-white"
                            : "text-gray-500 hover:text-gray-300"
                        }`}
                      >
                        💳 Card
                      </button>
                      <button
                        onClick={() => {
                          setPaymentMode("cash");
                          setError("");
                        }}
                        className={`flex-1 rounded-md py-1.5 text-xs font-medium transition-colors ${
                          paymentMode === "cash"
                            ? "bg-gray-700 text-white"
                            : "text-gray-500 hover:text-gray-300"
                        }`}
                      >
                        💵 Cash
                      </button>
                    </div>
                  )}

                  {/* Card payment form */}
                  {paymentMode === "card" && (
                    <form onSubmit={handleCheckout}>
                      <div className="space-y-3">
                        <div>
                          <label
                            htmlFor="playerName"
                            className="block text-xs text-gray-400 mb-1"
                          >
                            Your name
                          </label>
                          <input
                            id="playerName"
                            type="text"
                            required
                            autoFocus
                            value={playerName}
                            onChange={(e) => setPlayerName(e.target.value)}
                            placeholder="John Smith"
                            className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2.5 text-sm text-white placeholder:text-gray-600 focus:outline-none focus:border-indigo-600 focus:ring-1 focus:ring-indigo-600"
                          />
                        </div>

                        <div>
                          <label
                            htmlFor="playerEmail"
                            className="block text-xs text-gray-400 mb-1"
                          >
                            Email
                          </label>
                          <input
                            id="playerEmail"
                            type="email"
                            required
                            value={playerEmail}
                            onChange={(e) => setPlayerEmail(e.target.value)}
                            placeholder="john@email.com"
                            className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2.5 text-sm text-white placeholder:text-gray-600 focus:outline-none focus:border-indigo-600 focus:ring-1 focus:ring-indigo-600"
                          />
                          <p className="text-[10px] text-gray-600 mt-1">
                            For your receipt and winner notifications only.
                          </p>
                        </div>
                      </div>

                      {error && (
                        <p className="text-xs text-red-400 mt-3">{error}</p>
                      )}

                      <p className="text-[10px] text-gray-600 mt-3">
                        Max {maxPerPlayer} squares per person.
                      </p>

                      <button
                        type="submit"
                        disabled={loading}
                        className="w-full mt-4 rounded-lg bg-indigo-600 px-4 py-3 text-sm font-semibold text-white hover:bg-indigo-500 active:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                      >
                        {loading
                          ? "Redirecting to payment…"
                          : `Pay ${priceDisplay}`}
                      </button>
                    </form>
                  )}

                  {/* Cash reserve form */}
                  {paymentMode === "cash" && (
                    <form onSubmit={handleCashReserve}>
                      <div className="space-y-3">
                        <div>
                          <label
                            htmlFor="cashPlayerName"
                            className="block text-xs text-gray-400 mb-1"
                          >
                            Your name
                          </label>
                          <input
                            id="cashPlayerName"
                            type="text"
                            required
                            autoFocus
                            value={playerName}
                            onChange={(e) => setPlayerName(e.target.value)}
                            placeholder="John Smith"
                            className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2.5 text-sm text-white placeholder:text-gray-600 focus:outline-none focus:border-indigo-600 focus:ring-1 focus:ring-indigo-600"
                          />
                        </div>

                        <div>
                          <label
                            htmlFor="cashPin"
                            className="block text-xs text-gray-400 mb-1"
                          >
                            PIN from host
                          </label>
                          <input
                            id="cashPin"
                            type="text"
                            inputMode="numeric"
                            maxLength={4}
                            required
                            value={cashPin}
                            onChange={(e) =>
                              setCashPin(
                                e.target.value.replace(/\D/g, "").slice(0, 4)
                              )
                            }
                            placeholder="••••"
                            className="w-32 rounded-lg border border-gray-700 bg-gray-800 px-3 py-2.5 text-sm text-white text-center tracking-widest placeholder:text-gray-600 focus:outline-none focus:border-indigo-600 focus:ring-1 focus:ring-indigo-600"
                          />
                          <p className="text-[10px] text-gray-600 mt-1">
                            Ask the host for the 4-digit PIN.
                          </p>
                        </div>
                      </div>

                      {error && (
                        <p className="text-xs text-red-400 mt-3">{error}</p>
                      )}

                      <p className="text-[10px] text-gray-600 mt-3">
                        After reserving, hand {priceDisplay} to the host to
                        confirm.
                      </p>

                      <button
                        type="submit"
                        disabled={loading}
                        className="w-full mt-4 rounded-lg bg-amber-600 px-4 py-3 text-sm font-semibold text-white hover:bg-amber-500 active:bg-amber-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                      >
                        {loading
                          ? "Reserving…"
                          : `💵 Reserve with Cash — ${priceDisplay}`}
                      </button>
                    </form>
                  )}
                </>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
