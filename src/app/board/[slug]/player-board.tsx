"use client";

import { useState, useCallback, useEffect } from "react";
import { useRouter } from "next/navigation";

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
  const words = name.trim().split(/\s+/);
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return words.map((w) => w[0]).join("").toUpperCase().slice(0, 2);
}

export default function PlayerBoard({
  boardId,
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
  const router = useRouter();
  const [squares, setSquares] = useState(initialSquares);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showCheckout, setShowCheckout] = useState(false);
  const [checkoutMode, setCheckoutMode] = useState<"card" | "cash">("card");
  const [playerName, setPlayerName] = useState("");
  const [playerEmail, setPlayerEmail] = useState("");
  const [cashPin, setCashPin] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [cashSuccess, setCashSuccess] = useState(false);

  const isOpen = status === "open";
  const hasNumbers =
    (rowNumbers?.length ?? 0) === 10 && (colNumbers?.length ?? 0) === 10;
  const priceDisplay = `$${squarePrice / 100}`;
  const winnerSet = new Set(winnerPositionsArr ?? []);
  const selectedCount = selectedIds.size;
  const totalPrice = (squarePrice / 100) * selectedCount;

  // Poll for square updates when there are pending or reserved_cash squares
  useEffect(() => {
    if (!squares.some((s) => s.paymentStatus === "pending" || s.paymentStatus === "reserved_cash")) return;

    const id = setInterval(async () => {
      try {
        const res = await fetch(`/api/board/${slug}/squares`, {
          cache: "no-store",
        });
        if (!res.ok) return;
        const data = await res.json();
        setSquares(data.squares);
      } catch {
        // ignore
      }
    }, 2000);

    return () => clearInterval(id);
  }, [slug, squares]);

  // Clear selections if squares get taken by someone else
  useEffect(() => {
    setSelectedIds((prev) => {
      const next = new Set<string>();
      for (const id of prev) {
        const sq = squares.find((s) => s.squareId === id);
        if (sq && sq.paymentStatus === "open") next.add(id);
      }
      return next.size === prev.size ? prev : next;
    });
  }, [squares]);

  const handleSquareTap = useCallback(
    (sq: SquareData) => {
      if (!isOpen) return;
      if (sq.paymentStatus !== "open") return;

      setSelectedIds((prev) => {
        const next = new Set(prev);
        if (next.has(sq.squareId)) {
          next.delete(sq.squareId);
        } else {
          if (next.size >= maxPerPlayer) {
            return prev;
          }
          next.add(sq.squareId);
        }
        return next;
      });
      setError("");
      setCashSuccess(false);
    },
    [isOpen, maxPerPlayer]
  );

  const handleClearSelection = useCallback(() => {
    setSelectedIds(new Set());
    setShowCheckout(false);
    setError("");
    setCashSuccess(false);
  }, []);

  const handleCloseCheckout = useCallback(() => {
    setShowCheckout(false);
    setError("");
  }, []);

  const openCheckout = useCallback((mode: "card" | "cash") => {
    setCheckoutMode(mode);
    setShowCheckout(true);
    setError("");
    setCashSuccess(false);
  }, []);

  async function handleCardCheckout(e: React.FormEvent) {
    e.preventDefault();
    if (selectedIds.size === 0) return;

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
          squareIds: Array.from(selectedIds),
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

      window.location.href = data.checkoutUrl;
    } catch {
      setError("Network error. Please try again.");
      setLoading(false);
    }
  }

  async function handleCashCheckout(e: React.FormEvent) {
    e.preventDefault();
    if (selectedIds.size === 0) return;

    const trimmedName = playerName.trim();

    if (!trimmedName) {
      setError("Name is required.");
      return;
    }

    if (!cashPin || !/^\d{4}$/.test(cashPin)) {
      setError("Enter the 4-digit PIN from your host.");
      return;
    }

    setLoading(true);
    setError("");

    try {
      // Reserve each square individually (API takes single squareId)
      const squareIds = Array.from(selectedIds);
      for (const squareId of squareIds) {
        const res = await fetch(`/api/board/${slug}/cash-reserve`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            squareId,
            playerName: trimmedName,
            pin: cashPin,
          }),
        });

        const data = await res.json();

        if (!res.ok) {
          setError(data.error || "Something went wrong.");
          setLoading(false);
          return;
        }
      }

      // All reserved successfully
      setCashSuccess(true);
      setSelectedIds(new Set());
      setShowCheckout(false);
      setCashPin("");
      router.refresh();
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  // Get selected square positions for display
  const selectedPositions = Array.from(selectedIds)
    .map((id) => {
      const sq = squares.find((s) => s.squareId === id);
      return sq ? sq.position + 1 : 0;
    })
    .sort((a, b) => a - b);

  return (
    <div>
      {/* Cash success banner */}
      {cashSuccess && (
        <div className="rounded-lg border border-green-900 bg-green-950/60 p-4 mb-3">
          <p className="text-sm text-green-300 font-medium">
            Squares reserved! Hand your cash to the host to confirm.
          </p>
        </div>
      )}

      {/* Instruction line */}
      {isOpen && (
        <p className="text-xs text-gray-500 mb-3">
          Tap squares to select, then pay for all at once. Numbers randomize
          when the board closes.
        </p>
      )}

      {!isOpen && (
        <p className="text-xs text-gray-500 mb-3">
          This board is {status}.{" "}
          {hasNumbers
            ? "Numbers have been assigned."
            : "No longer accepting squares."}
        </p>
      )}

      {/* Grid */}
      <div className="overflow-x-auto pb-2 w-fit">
        {/* Team col label */}
        {teamCol && (
          <div
            className={`text-[10px] uppercase tracking-wider text-indigo-400 font-medium text-center mb-1 ${hasNumbers ? "ml-8" : ""}`}
          >
            {teamCol}
          </div>
        )}

        <div className="flex">
          {/* Team row label — rotated left of grid */}
          {teamRow && (
            <div className="flex flex-col mr-1">
              {hasNumbers && <div className="h-6 mb-[3px]" />}
              <div className="flex items-center justify-center flex-1">
                <span
                  className="text-[10px] uppercase tracking-wider text-indigo-400 font-medium"
                  style={{
                    writingMode: "vertical-lr",
                    transform: "rotate(180deg)",
                  }}
                >
                  {teamRow}
                </span>
              </div>
            </div>
          )}

          <div
            className="inline-grid gap-[3px]"
            style={{
              gridTemplateColumns: hasNumbers
                ? `28px repeat(10, 1fr)`
                : `repeat(10, 1fr)`,
            }}
          >
            {/* Column headers */}
            {hasNumbers && (
              <>
                <div />
                {colNumbers?.map((num, i) => (
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
                {/* Row header */}
                {hasNumbers && (
                  <div className="flex items-center justify-center text-[10px] font-bold text-gray-500 w-7">
                    {rowNumbers?.[row]}
                  </div>
                )}

                {/* Squares in this row */}
                {Array.from({ length: 10 }, (_, col) => {
                  const position = row * 10 + col;
                  const sq = squares[position];
                  if (!sq) return null;

                  const isPaid = sq.paymentStatus === "paid";
                  const isPending = sq.paymentStatus === "pending";
                  const isReservedCash = sq.paymentStatus === "reserved_cash";
                  const isAvailable = sq.paymentStatus === "open" && isOpen;
                  const isSelected = selectedIds.has(sq.squareId);
                  const isWinner = winnerSet.has(position) && isPaid;

                  return (
                    <button
                      key={sq.squareId}
                      disabled={!isAvailable && !isSelected}
                      onClick={() => handleSquareTap(sq)}
                      className={`aspect-square rounded-md flex items-center justify-center text-[10px] font-medium transition-all min-w-[28px] ${
                        isSelected
                          ? "bg-indigo-600 border-2 border-indigo-400 text-white ring-2 ring-indigo-500/30"
                          : isWinner
                            ? "bg-yellow-500/20 border-2 border-yellow-400 text-yellow-300 ring-1 ring-yellow-400/30"
                            : isPaid
                              ? "bg-green-950 border border-green-900 text-green-400"
                              : isReservedCash
                                ? "bg-amber-950 border border-amber-800 text-amber-500"
                                : isPending
                                  ? "bg-yellow-950 border border-yellow-900 text-yellow-500"
                                  : isAvailable
                                    ? "bg-gray-900 border border-gray-800 text-gray-600 hover:border-indigo-700 hover:bg-indigo-950/30 active:scale-95 cursor-pointer"
                                    : "bg-gray-900 border border-gray-800 text-gray-700"
                      }`}
                      title={
                        isSelected
                          ? `Selected — Square #${position + 1}`
                          : isWinner
                            ? `★ WINNER — ${sq.playerName ?? "Paid"}`
                            : isPaid
                              ? sq.playerName ?? "Paid"
                              : isReservedCash
                                ? `${sq.playerName ?? "Reserved"} (cash pending)`
                                : isPending
                                  ? "Pending payment"
                                  : isAvailable
                                    ? `Square ${position + 1} — ${priceDisplay}`
                                    : "Unavailable"
                      }
                    >
                      {isSelected
                        ? position + 1
                        : isWinner
                          ? "★"
                          : isPaid && sq.playerName
                            ? getInitials(sq.playerName)
                            : isReservedCash && sq.playerName
                              ? getInitials(sq.playerName)
                              : isPending
                                ? "…"
                                : ""}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-3 text-[10px] text-gray-600">
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
        {squares.some((s) => s.paymentStatus === "reserved_cash") && (
          <span className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-sm bg-amber-950 border border-amber-800" />
            Cash hold
          </span>
        )}
        {selectedCount > 0 && (
          <span className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-sm bg-indigo-600 border-2 border-indigo-400" />
            Selected
          </span>
        )}
        {winnerSet.size > 0 && (
          <span className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-sm bg-yellow-500/20 border-2 border-yellow-400" />
            Winner
          </span>
        )}
      </div>

      {/* Floating action bar */}
      {selectedCount > 0 && isOpen && !showCheckout && (
        <div className="fixed bottom-0 left-0 right-0 z-40 p-4 bg-gradient-to-t from-gray-950 via-gray-950 to-transparent pt-10">
          <div className="max-w-lg mx-auto flex items-center gap-2">
            <button
              onClick={handleClearSelection}
              className="rounded-lg border border-gray-700 bg-gray-800 px-3 py-3 text-sm text-gray-400 hover:text-white transition-colors"
            >
              Clear
            </button>
            <button
              onClick={() => openCheckout("card")}
              className="flex-1 rounded-lg bg-indigo-600 px-4 py-3 text-sm font-semibold text-white hover:bg-indigo-500 active:bg-indigo-700 transition-colors"
            >
              Pay ${totalPrice}
              {selectedCount > 1 ? ` for ${selectedCount}` : ""}
            </button>
            {cashModeEnabled && (
              <button
                onClick={() => openCheckout("cash")}
                className="rounded-lg border border-green-800 bg-green-950 px-4 py-3 text-sm font-semibold text-green-400 hover:bg-green-900 transition-colors"
              >
                💵 Cash
              </button>
            )}
          </div>
        </div>
      )}

      {/* Checkout Modal — Card */}
      {showCheckout && checkoutMode === "card" && selectedCount > 0 && isOpen && (
        <>
          <div className="fixed inset-0 bg-black/60 z-40" onClick={handleCloseCheckout} />
          <div className="fixed bottom-0 left-0 right-0 z-50 animate-slide-up">
            <div className="max-w-lg mx-auto bg-gray-900 border-t border-gray-800 rounded-t-2xl p-5">
              <div className="w-10 h-1 bg-gray-700 rounded-full mx-auto mb-4" />
              <div className="flex items-center justify-between mb-4">
                <div>
                  <p className="text-sm font-medium">
                    {selectedCount} Square{selectedCount > 1 ? "s" : ""} Selected
                  </p>
                  <p className="text-xs text-gray-500 mt-0.5">
                    #{selectedPositions.join(", #")} — ${totalPrice} total
                  </p>
                </div>
                <button onClick={handleCloseCheckout} className="text-gray-500 hover:text-white p-1 transition-colors" aria-label="Close">
                  <svg width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>

              <form onSubmit={handleCardCheckout}>
                <div className="space-y-3">
                  <div>
                    <label htmlFor="playerName" className="block text-xs text-gray-400 mb-1">Your name</label>
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
                    <label htmlFor="playerEmail" className="block text-xs text-gray-400 mb-1">Email</label>
                    <input
                      id="playerEmail"
                      type="email"
                      required
                      value={playerEmail}
                      onChange={(e) => setPlayerEmail(e.target.value)}
                      placeholder="john@email.com"
                      className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2.5 text-sm text-white placeholder:text-gray-600 focus:outline-none focus:border-indigo-600 focus:ring-1 focus:ring-indigo-600"
                    />
                    <p className="text-[10px] text-gray-600 mt-1">For your receipt and winner notifications only.</p>
                  </div>
                </div>
                {error && <p className="text-xs text-red-400 mt-3">{error}</p>}
                <p className="text-[10px] text-gray-600 mt-3">Max {maxPerPlayer} squares per person.</p>
                <button
                  type="submit"
                  disabled={loading}
                  className="w-full mt-4 rounded-lg bg-indigo-600 px-4 py-3 text-sm font-semibold text-white hover:bg-indigo-500 active:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {loading ? "Redirecting to payment…" : `Pay $${totalPrice}`}
                </button>
              </form>
            </div>
          </div>
        </>
      )}

      {/* Checkout Modal — Cash */}
      {showCheckout && checkoutMode === "cash" && selectedCount > 0 && isOpen && (
        <>
          <div className="fixed inset-0 bg-black/60 z-40" onClick={handleCloseCheckout} />
          <div className="fixed bottom-0 left-0 right-0 z-50 animate-slide-up">
            <div className="max-w-lg mx-auto bg-gray-900 border-t border-gray-800 rounded-t-2xl p-5">
              <div className="w-10 h-1 bg-gray-700 rounded-full mx-auto mb-4" />
              <div className="flex items-center justify-between mb-4">
                <div>
                  <p className="text-sm font-medium">
                    💵 Cash — {selectedCount} Square{selectedCount > 1 ? "s" : ""}
                  </p>
                  <p className="text-xs text-gray-500 mt-0.5">
                    #{selectedPositions.join(", #")} — pay your host ${totalPrice}
                  </p>
                </div>
                <button onClick={handleCloseCheckout} className="text-gray-500 hover:text-white p-1 transition-colors" aria-label="Close">
                  <svg width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>

              <form onSubmit={handleCashCheckout}>
                <div className="space-y-3">
                  <div>
                    <label htmlFor="cashName" className="block text-xs text-gray-400 mb-1">Your name</label>
                    <input
                      id="cashName"
                      type="text"
                      required
                      autoFocus
                      value={playerName}
                      onChange={(e) => setPlayerName(e.target.value)}
                      placeholder="Mike"
                      className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2.5 text-sm text-white placeholder:text-gray-600 focus:outline-none focus:border-indigo-600 focus:ring-1 focus:ring-indigo-600"
                    />
                  </div>
                  <div>
                    <label htmlFor="cashPin" className="block text-xs text-gray-400 mb-1">PIN from your host</label>
                    <input
                      id="cashPin"
                      type="text"
                      inputMode="numeric"
                      maxLength={4}
                      required
                      value={cashPin}
                      onChange={(e) => {
                        setCashPin(e.target.value.replace(/\D/g, "").slice(0, 4));
                        setError("");
                      }}
                      placeholder="••••"
                      className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2.5 text-sm text-white text-center tracking-[0.3em] placeholder:text-gray-600 focus:outline-none focus:border-green-600 focus:ring-1 focus:ring-green-600"
                    />
                  </div>
                </div>
                {error && <p className="text-xs text-red-400 mt-3">{error}</p>}
                <p className="text-[10px] text-gray-600 mt-3">
                  Give ${totalPrice} cash to your host. They'll confirm to lock your square{selectedCount > 1 ? "s" : ""} in.
                </p>
                <button
                  type="submit"
                  disabled={loading}
                  className="w-full mt-4 rounded-lg bg-green-700 px-4 py-3 text-sm font-semibold text-white hover:bg-green-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {loading ? "Reserving…" : `Reserve ${selectedCount} Square${selectedCount > 1 ? "s" : ""}`}
                </button>
              </form>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
