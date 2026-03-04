"use client";

import React, { useState, useCallback, useEffect } from "react";
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
  stripeConnected?: boolean;
  hostVenmo?: string | null;
  hostZelle?: string | null;
  hostCashapp?: string | null;
  payoutVisibility?: string | null;
  requirePlayerPayout?: boolean;
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
  stripeConnected = false,
  hostVenmo,
  hostZelle,
  hostCashapp,
  payoutVisibility,
  requirePlayerPayout = false,
}: PlayerBoardProps) {

  // Claim flow state (open squares)
  const [squares, setSquares] = useState(initialSquares);
  const [selectedSquare, setSelectedSquare] = useState<SquareData | null>(null);
  const [playerName, setPlayerName] = useState("");
  const [playerEmail, setPlayerEmail] = useState("");
  const [playerPhone, setPlayerPhone] = useState("");
  const [cashPin, setCashPin] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [cashSuccess, setCashSuccess] = useState(false);
  const [paymentMode, setPaymentMode] = useState<"card" | "cash">("card");

  // Resume flow state (pending squares)
  const [pendingSquare, setPendingSquare] = useState<SquareData | null>(null);
  const [resumeEmail, setResumeEmail] = useState("");
  const [resumeLoading, setResumeLoading] = useState(false);
  const [resumeError, setResumeError] = useState("");
  // When a square freed up mid-resume, let the player tap directly into claim
  const [resumeFreedUp, setResumeFreedUp] = useState(false);

  const isOpen = status === "open";
  const hasNumbers = !!(rowNumbers?.length && colNumbers?.length);
  const priceDisplay = `$${squarePrice / 100}`;
  const winnerSet = new Set(winnerPositionsArr ?? []);

  // ----------------------------------------------------------------
  // Polling — refresh square statuses while any are pending
  // ----------------------------------------------------------------
  useEffect(() => {
    const hasPending = squares.some(
      (s) => s.paymentStatus === "pending" || s.paymentStatus === "reserved_cash"
    );
    if (!hasPending) return;

    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/board/${slug}/squares`);
        if (!res.ok) return;
        const data = await res.json();
        setSquares(data.squares ?? data);
      } catch {
        // Network blip — stay quiet, try again next tick
      }
    }, 2000);

    return () => clearInterval(interval);
  }, [squares, slug]);

  // ----------------------------------------------------------------
  // Square tap handler
  // ----------------------------------------------------------------
  const handleSquareTap = useCallback(
    (sq: SquareData) => {
      if (!isOpen) return;

      if (sq.paymentStatus === "pending") {
        setPendingSquare(sq);
        setResumeEmail("");
        setResumeError("");
        setResumeFreedUp(false);
        return;
      }

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
    setPendingSquare(null);
    setError("");
    setResumeError("");
    setResumeFreedUp(false);
    setCashSuccess(false);
  }, []);

  // ----------------------------------------------------------------
  // Claim checkout (open squares → Stripe)
  // ----------------------------------------------------------------
  async function handleCheckout(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedSquare) return;

    const trimmedName = playerName.trim();
    const trimmedEmail = playerEmail.trim().toLowerCase();

    if (!trimmedName) { setError("Name is required."); return; }
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
          squareIds: [selectedSquare.squareId],
          playerName: trimmedName,
          playerEmail: trimmedEmail,
          playerPhone: playerPhone.trim(),
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Something went wrong. Please try again.");
        return;
      }

      if (data.checkoutUrl) {
        window.location.href = data.checkoutUrl;
      }
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  // ----------------------------------------------------------------
  // Cash reserve (open squares → cash hold)
  // ----------------------------------------------------------------
  async function handleCashReserve(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedSquare) return;

    const trimmedName = playerName.trim();

    if (!trimmedName) { setError("Name is required."); return; }
    if (!cashPin || cashPin.length !== 4) {
      setError("4-digit PIN is required.");
      return;
    }

    setLoading(true);
    setError("");

    try {
      const res = await fetch("/api/checkout/cash", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          squareId: selectedSquare.squareId,
          playerName: trimmedName,
          cashPin,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Something went wrong. Please try again.");
        return;
      }

      setCashSuccess(true);
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  // ----------------------------------------------------------------
  // Resume checkout (pending squares → re-enter existing Stripe session)
  // ----------------------------------------------------------------
  async function handleResume(e: React.FormEvent) {
    e.preventDefault();
    if (!pendingSquare) return;

    const trimmedEmail = resumeEmail.trim().toLowerCase();

    if (!trimmedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      setResumeError("Valid email is required.");
      return;
    }

    setResumeLoading(true);
    setResumeError("");

    try {
      const res = await fetch("/api/checkout/resume", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          squareId: pendingSquare.squareId,
          email: trimmedEmail,
        }),
      });

      const data = await res.json();

      // Square just freed up — stay in the modal, show a "claim it now" prompt.
      // Polling will update the grid within 2 seconds.
      if (res.status === 410) {
        setResumeFreedUp(true);
        setResumeError("");
        return;
      }

      // Payment was already completed, webhook hadn't fired yet.
      // Redirect to success URL so the player sees the confirmation banner.
      if (res.status === 200 && data.alreadyPaid) {
        window.location.href = `/board/${data.boardSlug}?success=true`;
        return;
      }

      if (!res.ok) {
        setResumeError(data.error || "Something went wrong. Please try again.");
        return;
      }

      if (data.checkoutUrl) {
        window.location.href = data.checkoutUrl;
      }
    } catch {
      setResumeError("Network error. Please try again.");
    } finally {
      setResumeLoading(false);
    }
  }

  // ----------------------------------------------------------------
  // Render
  // ----------------------------------------------------------------
  return (
    <div className="relative">
      {/* Grid */}
      <div className="overflow-x-auto pb-4">
        <div className="mx-auto w-fit">
          <div
            className="grid"
            style={{
              gridTemplateColumns: hasNumbers
                ? '24px 28px repeat(10, 28px)'
                : 'repeat(10, 28px)',
              gridTemplateRows: hasNumbers
                ? 'auto 20px repeat(10, 28px)'
                : 'repeat(10, 28px)',
              gap: '2px',
            }}
          >
            {/* Team A label */}
            {hasNumbers && teamCol && (
              <div
                style={{ gridColumn: '3 / 13', gridRow: 1 }}
                className="flex items-center justify-center text-[10px] uppercase tracking-wider text-indigo-400 font-medium h-6"
              >
                {teamCol}
              </div>
            )}

            {/* Column numbers */}
            {hasNumbers && colNumbers!.map((num, i) => (
              <div
                key={`col-${i}`}
                style={{ gridColumn: i + 3, gridRow: 2 }}
                className="flex items-center justify-center text-[10px] font-bold text-gray-500"
              >
                {num}
              </div>
            ))}

            {/* Team B label */}
            {hasNumbers && teamRow && (
              <div
                style={{ gridColumn: 1, gridRow: '3 / 13' }}
                className="flex items-center justify-center"
              >
                <span
                  className="text-[10px] uppercase tracking-wider text-indigo-400 font-medium whitespace-nowrap"
                  style={{ writingMode: 'vertical-lr', transform: 'rotate(180deg)' }}
                >
                  {teamRow}
                </span>
              </div>
            )}

            {/* Row numbers + squares */}
            {Array.from({ length: 10 }, (_, row) => {
              const gridRow = hasNumbers ? row + 3 : row + 1;
              const colOffset = hasNumbers ? 3 : 1;
              return (
                <React.Fragment key={`row-group-${row}`}>
                  {hasNumbers && (
                    <div
                      style={{ gridColumn: 2, gridRow }}
                      className="flex items-center justify-center text-[10px] font-bold text-gray-500"
                    >
                      {rowNumbers![row]}
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
                    const isPendingSelected = pendingSquare?.squareId === sq.squareId;
                    const isWinner = winnerSet.has(position) && isPaid;

                    return (
                      <button
                        key={sq.squareId}
                        disabled={isPaid || !isOpen}
                        onClick={() => handleSquareTap(sq)}
                        style={{ gridColumn: col + colOffset, gridRow }}
                        className={`aspect-square rounded-md flex items-center justify-center text-[10px] font-medium transition-all ${
                          isSelected
                            ? "bg-indigo-600 border-2 border-indigo-400 text-white ring-2 ring-indigo-500/30"
                            : isPendingSelected
                              ? "bg-yellow-600 border-2 border-yellow-400 text-white ring-2 ring-yellow-500/30"
                              : isWinner
                                ? "bg-yellow-500/20 border-2 border-yellow-400 text-yellow-300 ring-1 ring-yellow-400/30"
                                : isPaid
                                  ? "bg-green-950 border border-green-900 text-green-400"
                                  : isPending
                                    ? "bg-yellow-950 border border-yellow-900 text-yellow-500 hover:border-yellow-600 hover:bg-yellow-900/40 active:scale-95 cursor-pointer"
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
                                ? "Tap to resume checkout"
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
                              : ""}
                      </button>
                    );
                  })}
                </React.Fragment>
              );
            })}
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

      {/* ============================================================
          CLAIM MODAL — open squares
          ============================================================ */}
      {selectedSquare && isOpen && (
        <>
          <div className="fixed inset-0 bg-black/60 z-40" onClick={handleClose} />

          <div className="fixed bottom-0 left-0 right-0 z-50 animate-slide-up">
            <div className="max-w-lg mx-auto bg-gray-900 border-t border-gray-800 rounded-t-2xl p-5">
              <div className="w-10 h-1 bg-gray-700 rounded-full mx-auto mb-4" />

              {cashSuccess ? (
                <div className="text-center py-4">
                  <div className="text-3xl mb-2">✓</div>
                  <p className="text-sm font-medium text-green-300">Square reserved!</p>
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
                        {priceDisplay} —{" "}
                        {paymentMode === "card" ? "pay to lock it in" : "reserve with cash"}
                      </p>
                    </div>
                    <button onClick={handleClose} className="text-gray-500 hover:text-white p-1 transition-colors" aria-label="Close">
                      <svg width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>

                  {cashModeEnabled && (
                    <div className="flex gap-1 mb-4 p-1 rounded-lg bg-gray-800">
                      <button
                        onClick={() => { setPaymentMode("card"); setError(""); }}
                        className={`flex-1 rounded-md py-1.5 text-xs font-medium transition-colors ${paymentMode === "card" ? "bg-gray-700 text-white" : "text-gray-500 hover:text-gray-300"}`}
                      >
                        💳 Card
                      </button>
                      <button
                        onClick={() => { setPaymentMode("cash"); setError(""); }}
                        className={`flex-1 rounded-md py-1.5 text-xs font-medium transition-colors ${paymentMode === "cash" ? "bg-gray-700 text-white" : "text-gray-500 hover:text-gray-300"}`}
                      >
                        💵 Cash
                      </button>
                    </div>
                  )}

                  {paymentMode === "card" && (
                    <form onSubmit={handleCheckout}>
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
                          <p className="text-[10px] text-gray-600 mt-1">
                            For your receipt and winner notifications only.
                          </p>
                        </div>
                        <div>
                          <label htmlFor="playerPhone" className="block text-xs text-gray-400 mb-1">Phone</label>
                          <input
                            id="playerPhone"
                            type="tel"
                            required
                            value={playerPhone}
                            onChange={(e) => setPlayerPhone(e.target.value)}
                            placeholder="(555) 123-4567"
                            className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2.5 text-sm text-white placeholder:text-gray-600 focus:outline-none focus:border-indigo-600 focus:ring-1 focus:ring-indigo-600"
                          />
                        </div>
                        {error && <p className="text-xs text-red-400">{error}</p>}

                        <button
                          type="submit"
                          disabled={loading}
                          className="w-full rounded-lg bg-indigo-600 py-3 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50 transition-colors"
                        >
                          {loading ? "Setting up payment…" : `Pay ${priceDisplay}`}
                        </button>
                      </div>
                    </form>
                  )}

                  {paymentMode === "cash" && (
                    <form onSubmit={handleCashReserve}>
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
                            placeholder="John Smith"
                            className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2.5 text-sm text-white placeholder:text-gray-600 focus:outline-none focus:border-indigo-600 focus:ring-1 focus:ring-indigo-600"
                          />
                        </div>
                        <div>
                          <label htmlFor="cashPin" className="block text-xs text-gray-400 mb-1">Host PIN</label>
                          <input
                            id="cashPin"
                            type="text"
                            inputMode="numeric"
                            pattern="[0-9]{4}"
                            maxLength={4}
                            required
                            value={cashPin}
                            onChange={(e) => setCashPin(e.target.value.replace(/\D/g, ""))}
                            placeholder="4-digit PIN from host"
                            className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2.5 text-sm text-white placeholder:text-gray-600 focus:outline-none focus:border-indigo-600 focus:ring-1 focus:ring-indigo-600"
                          />
                        </div>
                        {error && <p className="text-xs text-red-400">{error}</p>}
                        <button
                          type="submit"
                          disabled={loading}
                          className="w-full rounded-lg bg-yellow-700 py-3 text-sm font-semibold text-white hover:bg-yellow-600 disabled:opacity-50 transition-colors"
                        >
                          {loading ? "Reserving…" : "Reserve with Cash"}
                        </button>
                      </div>
                    </form>
                  )}
                </>
              )}
            </div>
          </div>
        </>
      )}

      {/* ============================================================
          RESUME MODAL — pending squares
          ============================================================ */}
      {pendingSquare && isOpen && (
        <>
          <div className="fixed inset-0 bg-black/60 z-40" onClick={handleClose} />

          <div className="fixed bottom-0 left-0 right-0 z-50 animate-slide-up">
            <div className="max-w-lg mx-auto bg-gray-900 border-t border-gray-800 rounded-t-2xl p-5">
              <div className="w-10 h-1 bg-gray-700 rounded-full mx-auto mb-4" />

              <div className="flex items-center justify-between mb-4">
                <div>
                  <p className="text-sm font-medium">
                    Square #{pendingSquare.position + 1}
                  </p>
                  <p className="text-xs text-yellow-500 mt-0.5">Pending payment</p>
                </div>
                <button onClick={handleClose} className="text-gray-500 hover:text-white p-1 transition-colors" aria-label="Close">
                  <svg width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>

              {/* Square just freed up — invite the player to claim it */}
              {resumeFreedUp ? (
                <div className="text-center py-2">
                  <p className="text-sm font-medium text-green-300 mb-1">
                    This square just freed up!
                  </p>
                  <p className="text-xs text-gray-500 mb-4">
                    Close this sheet and tap the square to claim it.
                  </p>
                  <button
                    onClick={handleClose}
                    className="w-full rounded-lg bg-indigo-600 py-3 text-sm font-semibold text-white hover:bg-indigo-500 transition-colors"
                  >
                    Got it
                  </button>
                </div>
              ) : (
                <form onSubmit={handleResume}>
                  <div className="space-y-3">
                    <p className="text-xs text-gray-400">
                      This square has an active checkout. Enter the email you
                      used to claim it to pick up where you left off.
                    </p>
                    <div>
                      <label htmlFor="resumeEmail" className="block text-xs text-gray-400 mb-1">
                        Email used at checkout
                      </label>
                      <input
                        id="resumeEmail"
                        type="email"
                        required
                        autoFocus
                        value={resumeEmail}
                        onChange={(e) => setResumeEmail(e.target.value)}
                        placeholder="john@email.com"
                        className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2.5 text-sm text-white placeholder:text-gray-600 focus:outline-none focus:border-yellow-600 focus:ring-1 focus:ring-yellow-600"
                      />
                    </div>
                    {resumeError && (
                      <p className="text-xs text-red-400">{resumeError}</p>
                    )}
                    <button
                      type="submit"
                      disabled={resumeLoading}
                      className="w-full rounded-lg bg-yellow-700 py-3 text-sm font-semibold text-white hover:bg-yellow-600 disabled:opacity-50 transition-colors"
                    >
                      {resumeLoading ? "Checking…" : "Resume Checkout"}
                    </button>
                  </div>
                </form>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
