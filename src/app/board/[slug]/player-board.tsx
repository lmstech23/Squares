"use client";

import React, { useState, useCallback, useEffect } from "react";
import { loadPlayerInfo, savePlayerInfo } from "@/lib/player-storage";
import HostPaymentInfo from "@/components/host-payment-info";
import PlayerPayoutSelect from "@/components/player-payout-select";

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
  // Payout coordination
  hostVenmo?: string | null;
  hostZelle?: string | null;
  hostCashapp?: string | null;
  payoutVisibility?: string;
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
  // Payout coordination
  hostVenmo = null,
  hostZelle = null,
  hostCashapp = null,
  payoutVisibility = "public",
  requirePlayerPayout = false,
}: PlayerBoardProps) {
  const [squares] = useState(initialSquares);
  const [selectedSquares, setSelectedSquares] = useState<Map<string, SquareData>>(new Map());
  const [playerName, setPlayerName] = useState("");
  const [playerEmail, setPlayerEmail] = useState("");
  const [playerPhone, setPlayerPhone] = useState("");
  const [cashPin, setCashPin] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [cashSuccess, setCashSuccess] = useState(false);

  // Payout coordination state
  const [playerPayoutMethod, setPlayerPayoutMethod] = useState("");
  const [playerPayoutHandle, setPlayerPayoutHandle] = useState("");
  const [smsOptIn, setSmsOptIn] = useState(false);
  const [saveInfo, setSaveInfo] = useState(false);
  const [pinVerified, setPinVerified] = useState(false);

  // Load saved player info from localStorage on mount
  useEffect(() => {
    const saved = loadPlayerInfo();
    if (saved) {
      setPlayerName(saved.name);
      setPlayerEmail(saved.email);
      setPlayerPhone(saved.phone);
      setSaveInfo(true);
    }
  }, []);

  // Payment method availability
  const hasCard = stripeConnected;
  const hasCash = cashModeEnabled;
  const hasBoth = hasCard && hasCash;

  const [paymentMode, setPaymentMode] = useState<"card" | "cash">(
    hasCard ? "card" : "cash"
  );
  const [showModal, setShowModal] = useState(false);

  const isOpen = status === "open";
  const hasNumbers = rowNumbers && colNumbers;
  const priceDisplay = `$${squarePrice / 100}`;
  const winnerSet = new Set(winnerPositionsArr ?? []);

  const selectedCount = selectedSquares.size;
  const totalPrice = `$${(selectedCount * squarePrice) / 100}`;

  const handleSquareTap = useCallback(
    (sq: SquareData) => {
      if (!isOpen) return;
      // Allow tapping open squares and pending squares (for resume flow)
      if (sq.paymentStatus !== "open" && sq.paymentStatus !== "pending") return;

      setSelectedSquares((prev) => {
        const next = new Map(prev);
        if (next.has(sq.squareId)) {
          next.delete(sq.squareId);
        } else {
          // Enforce max per player at selection time
          if (next.size >= maxPerPlayer) {
            return prev;
          }
          next.set(sq.squareId, sq);
        }
        return next;
      });

      setError("");
      setCashSuccess(false);
    },
    [isOpen, maxPerPlayer]
  );

  const handleClose = useCallback(() => {
    setSelectedSquares(new Map());
    setShowModal(false);
    setError("");
    setCashSuccess(false);
    setPaymentMode("card");
  }, []);

  async function handleCheckout(e: React.FormEvent) {
    e.preventDefault();
    if (selectedSquares.size === 0) return;

    const trimmedName = playerName.trim();
    const trimmedEmail = playerEmail.trim().toLowerCase();
    const trimmedPhone = playerPhone.trim();

    if (!trimmedName) {
      setError("Name is required.");
      return;
    }

    if (!trimmedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      setError("Valid email is required.");
      return;
    }

    if (!trimmedPhone) {
      setError("Phone number is required.");
      return;
    }

    if (requirePlayerPayout && !playerPayoutMethod) {
      setError("Please select how the host should pay you.");
      return;
    }

    if (playerPayoutMethod && playerPayoutMethod !== "cash" && !playerPayoutHandle.trim()) {
      setError("Please enter your payment handle.");
      return;
    }

    setLoading(true);
    setError("");

    // Save info to localStorage if checked
    if (saveInfo) {
      savePlayerInfo({ name: trimmedName, email: trimmedEmail, phone: trimmedPhone });
    }

    try {
      const res = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          squareIds: Array.from(selectedSquares.keys()),
          playerName: trimmedName,
          playerEmail: trimmedEmail,
          playerPhone: trimmedPhone,
          playerPayoutMethod: playerPayoutMethod || null,
          playerPayoutHandle: playerPayoutHandle.trim() || null,
          smsOptIn,
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
    // Cash reserve: use first selected square only
    const firstSquare = Array.from(selectedSquares.values())[0];
    if (!firstSquare) return;

    const trimmedName = playerName.trim();
    const trimmedPin = cashPin.trim();
    const trimmedPhone = playerPhone.trim();

    if (!trimmedName) {
      setError("Name is required.");
      return;
    }

    if (!trimmedPhone) {
      setError("Phone number is required.");
      return;
    }

    if (!/^\d{4}$/.test(trimmedPin)) {
      setError("Enter the 4-digit PIN from the host.");
      return;
    }

    if (requirePlayerPayout && !playerPayoutMethod) {
      setError("Please select how the host should pay you.");
      return;
    }

    if (playerPayoutMethod && playerPayoutMethod !== "cash" && !playerPayoutHandle.trim()) {
      setError("Please enter your payment handle.");
      return;
    }

    setLoading(true);
    setError("");

    // Save info to localStorage if checked
    if (saveInfo) {
      savePlayerInfo({ name: trimmedName, email: playerEmail.trim(), phone: trimmedPhone });
    }

    try {
      const res = await fetch(`/api/board/${slug}/cash-reserve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          squareId: firstSquare.squareId,
          playerName: trimmedName,
          pin: trimmedPin,
          playerPhone: trimmedPhone,
          playerEmail: playerEmail.trim().toLowerCase() || null,
          playerPayoutMethod: playerPayoutMethod || null,
          playerPayoutHandle: playerPayoutHandle.trim() || null,
          smsOptIn,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Something went wrong. Try again.");
        setLoading(false);
        return;
      }

      setCashSuccess(true);
      setPinVerified(true);
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
          Pick a square. {priceDisplay} each. {maxPerPlayer > 1 ? `Up to ${maxPerPlayer} per person.` : ""}
        </p>
      )}

      {/* Host payment info — shows how host pays winners */}
      
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
            {hasNumbers && colNumbers.map((num, i) => (
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
                  {/* Row number */}
                  {hasNumbers && (
                    <div
                      style={{ gridColumn: 2, gridRow }}
                      className="flex items-center justify-center text-[10px] font-bold text-gray-500"
                    >
                      {rowNumbers[row]}
                    </div>
                  )}

                  {/* Squares */}
                  {Array.from({ length: 10 }, (_, col) => {
                    const position = row * 10 + col;
                    const sq = squares[position];
                    if (!sq) return <div key={`empty-${position}`} style={{ gridColumn: col + colOffset, gridRow }} />;

                    const isPaid = sq.paymentStatus === "paid";
                    const isPending = sq.paymentStatus === "pending";
                    const isReservedCash = sq.paymentStatus === "reserved_cash";
                    const isAvailable = sq.paymentStatus === "open" && isOpen;
                    const isTappable = isAvailable || (isPending && isOpen);
                    const isSelected = selectedSquares.has(sq.squareId);
                    const isWinner = winnerSet.has(position) && isPaid;

                    return (
                      <button
                        key={sq.squareId}
                        disabled={!isTappable}
                        onClick={() => handleSquareTap(sq)}
                        style={{ gridColumn: col + colOffset, gridRow }}
                        className={`aspect-square rounded-md flex items-center justify-center text-[10px] font-medium transition-all ${
                          isSelected
                            ? "bg-indigo-600 border-2 border-indigo-400 text-white ring-2 ring-indigo-500/30"
                            : isWinner
                              ? "bg-yellow-500/20 border-2 border-yellow-400 text-yellow-300 ring-1 ring-yellow-400/30"
                              : isPaid
                                ? "bg-green-950 border border-green-900 text-green-400"
                                : isReservedCash
                                  ? "bg-amber-950 border border-amber-800 text-amber-500"
                                  : isPending
                                    ? "bg-yellow-950 border border-yellow-900 text-yellow-500 hover:border-yellow-600 cursor-pointer"
                                    : isAvailable
                                      ? "bg-gray-900 border border-gray-800 text-gray-600 hover:border-indigo-700 hover:bg-indigo-950/30 active:scale-95 cursor-pointer"
                                      : "bg-gray-900 border border-gray-800 text-gray-700"
                        }`}
                        title={
                          isSelected
                            ? `Selected — Square ${position + 1}`
                            : isWinner
                              ? `★ WINNER — ${sq.playerName ?? "Paid"}`
                              : isPaid
                                ? sq.playerName ?? "Paid"
                                : isReservedCash
                                  ? `Reserved (cash) — ${sq.playerName ?? ""}`
                                  : isPending
                                    ? `Pending — tap to resume if this is yours`
                                    : isAvailable
                                      ? `Square ${position + 1} — ${priceDisplay}`
                                      : "Unavailable"
                        }
                      >
                        {isSelected
                          ? "✓"
                          : isWinner
                            ? "★"
                            : isPaid && sq.playerName
                              ? getInitials(sq.playerName)
                              : isReservedCash
                                ? "💵"
                                : isPending
                                  ? "…"
                                  : <span className="text-gray-700">{position + 1}</span>}
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
      <div className="flex items-center justify-center gap-4 mt-3 text-[10px] text-gray-600">
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
      <HostPaymentInfo
        venmo={hostVenmo}
        zelle={hostZelle}
        cashapp={hostCashapp}
        visibility={payoutVisibility as "public" | "pin_gated"}
        pinVerified={pinVerified}
      />
      {/* Selection summary bar — appears when squares are selected */}
      {selectedCount > 0 && isOpen && !showModal && (
        <div className="fixed bottom-0 left-0 right-0 z-40 bg-gray-900 border-t border-gray-800 p-3">
          <div className="max-w-lg mx-auto flex items-center justify-between">
            <span className="text-sm text-gray-300">
              {selectedCount} square{selectedCount > 1 ? "s" : ""} · {totalPrice}
            </span>
            <button
              onClick={() => setShowModal(true)}
              className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500"
            >
              Checkout
            </button>
          </div>
        </div>
      )}

      {/* Floating checkout bar — appears when squares are selected */}
      {selectedCount > 0 && isOpen && !showModal && (
        <div className="fixed bottom-0 left-0 right-0 z-30 p-4 bg-gradient-to-t from-gray-950 via-gray-950/95 to-transparent">
          <div className="max-w-lg mx-auto flex items-center justify-between bg-gray-900 border border-gray-800 rounded-xl px-4 py-3">
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-white truncate">
                {selectedCount === 1
                  ? `Square #${Array.from(selectedSquares.values())[0].position + 1}`
                  : `${selectedCount} squares selected`}
              </p>
              <p className="text-xs text-gray-500">
                {totalPrice} total
              </p>
            </div>
            <div className="flex items-center gap-2 ml-3">
              <button
                onClick={handleClose}
                className="rounded-lg px-3 py-2 text-xs text-gray-400 hover:text-white transition-colors"
              >
                Clear
              </button>
              <button
                onClick={() => setShowModal(true)}
                className="rounded-lg bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-indigo-500 active:bg-indigo-700 transition-colors"
              >
                Checkout
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Claim Modal — slides up */}
      {showModal && selectedCount > 0 && isOpen && (
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
                        {selectedCount === 1
                          ? `Square #${Array.from(selectedSquares.values())[0].position + 1}`
                          : `${selectedCount} Squares`}
                      </p>
                      <p className="text-xs text-gray-500 mt-0.5">
                        {totalPrice} total — {paymentMode === "card" ? "pay to lock" : "reserve with cash"}
                      </p>
                      {selectedCount > 1 && (
                        <p className="text-[10px] text-gray-600 mt-1">
                          #{Array.from(selectedSquares.values())
                            .map((s) => s.position + 1)
                            .sort((a, b) => a - b)
                            .join(", ")}
                        </p>
                      )}
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

                  {/* Pending resume hint */}
                  {Array.from(selectedSquares.values()).some(
                    (s) => s.paymentStatus === "pending"
                  ) && (
                    <div className="mb-3 p-2 rounded-lg bg-yellow-950/50 border border-yellow-900/50">
                      <p className="text-[10px] text-yellow-400">
                        Some selected squares are pending. Enter the same email you used before to resume your purchase.
                      </p>
                    </div>
                  )}

                  {/* Payment mode tabs — only show if both methods available */}
                  {hasBoth && (
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
                  {paymentMode === "card" && hasCard && (
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

                        <div>
                          <label
                            htmlFor="playerPhone"
                            className="block text-xs text-gray-400 mb-1"
                          >
                            Phone
                          </label>
                          <input
                            id="playerPhone"
                            type="tel"
                            required
                            value={playerPhone}
                            onChange={(e) => setPlayerPhone(e.target.value)}
                            placeholder="(555) 123-4567"
                            className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2.5 text-sm text-white placeholder:text-gray-600 focus:outline-none focus:border-indigo-600 focus:ring-1 focus:ring-indigo-600"
                          />
                          <p className="text-[10px] text-gray-600 mt-1">
                            Mobile number (so the host can reach you if you win)
                          </p>
                        </div>

                        {/* Payout preference */}
                        <PlayerPayoutSelect
                          hostVenmo={hostVenmo}
                          hostZelle={hostZelle}
                          hostCashapp={hostCashapp}
                          required={requirePlayerPayout}
                          selectedMethod={playerPayoutMethod}
                          handle={playerPayoutHandle}
                          onMethodChange={setPlayerPayoutMethod}
                          onHandleChange={setPlayerPayoutHandle}
                        />

                        {/* SMS opt-in */}
                        <label className="flex items-start gap-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={smsOptIn}
                            onChange={(e) => setSmsOptIn(e.target.checked)}
                            className="mt-0.5 rounded border-gray-600 bg-gray-800 text-indigo-600 focus:ring-indigo-600"
                          />
                          <span className="text-xs text-gray-400">
                            Text me updates about this board (winners + reminders)
                            <span className="block text-[10px] text-gray-600 mt-0.5">
                              Msg & data rates may apply. Reply STOP to opt out.
                            </span>
                          </span>
                        </label>

                        {/* Save my info */}
                        <label className="flex items-center gap-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={saveInfo}
                            onChange={(e) => setSaveInfo(e.target.checked)}
                            className="rounded border-gray-600 bg-gray-800 text-indigo-600 focus:ring-indigo-600"
                          />
                          <span className="text-xs text-gray-400">
                            Save my info for next time
                          </span>
                        </label>
                      </div>

                      {error && (
                        <p className="text-xs text-red-400 mt-3">{error}</p>
                      )}

                      <button
                        type="submit"
                        disabled={loading}
                        className="w-full mt-4 rounded-lg bg-indigo-600 px-4 py-3 text-sm font-semibold text-white hover:bg-indigo-500 active:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                      >
                        {loading
                          ? "Redirecting to payment…"
                          : `Pay ${totalPrice}${selectedCount > 1 ? ` (${selectedCount} squares)` : ""}`}
                      </button>
                    </form>
                  )}

                  {/* Cash reserve form */}
                  {paymentMode === "cash" && hasCash && (
                    <form onSubmit={handleCashReserve}>
                      {selectedCount > 1 && (
                        <div className="mb-3 p-2 rounded-lg bg-gray-800">
                          <p className="text-[10px] text-gray-400">
                            Cash reserves one square at a time. Reserving square #{Array.from(selectedSquares.values())[0].position + 1}.
                          </p>
                        </div>
                      )}

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
                            htmlFor="cashPlayerPhone"
                            className="block text-xs text-gray-400 mb-1"
                          >
                            Phone
                          </label>
                          <input
                            id="cashPlayerPhone"
                            type="tel"
                            required
                            value={playerPhone}
                            onChange={(e) => setPlayerPhone(e.target.value)}
                            placeholder="(555) 123-4567"
                            className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2.5 text-sm text-white placeholder:text-gray-600 focus:outline-none focus:border-indigo-600 focus:ring-1 focus:ring-indigo-600"
                          />
                          <p className="text-[10px] text-gray-600 mt-1">
                            Mobile number (so the host can reach you if you win)
                          </p>
                        </div>

                        <div>
                          <label
                            htmlFor="cashPlayerEmail"
                            className="block text-xs text-gray-400 mb-1"
                          >
                            Email <span className="text-gray-600">(optional)</span>
                          </label>
                          <input
                            id="cashPlayerEmail"
                            type="email"
                            value={playerEmail}
                            onChange={(e) => setPlayerEmail(e.target.value)}
                            placeholder="john@email.com"
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

                        {/* Payout preference */}
                        <PlayerPayoutSelect
                          hostVenmo={hostVenmo}
                          hostZelle={hostZelle}
                          hostCashapp={hostCashapp}
                          required={requirePlayerPayout}
                          selectedMethod={playerPayoutMethod}
                          handle={playerPayoutHandle}
                          onMethodChange={setPlayerPayoutMethod}
                          onHandleChange={setPlayerPayoutHandle}
                        />

                        {/* SMS opt-in */}
                        <label className="flex items-start gap-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={smsOptIn}
                            onChange={(e) => setSmsOptIn(e.target.checked)}
                            className="mt-0.5 rounded border-gray-600 bg-gray-800 text-indigo-600 focus:ring-indigo-600"
                          />
                          <span className="text-xs text-gray-400">
                            Text me updates about this board (winners + reminders)
                            <span className="block text-[10px] text-gray-600 mt-0.5">
                              Msg & data rates may apply. Reply STOP to opt out.
                            </span>
                          </span>
                        </label>

                        {/* Save my info */}
                        <label className="flex items-center gap-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={saveInfo}
                            onChange={(e) => setSaveInfo(e.target.checked)}
                            className="rounded border-gray-600 bg-gray-800 text-indigo-600 focus:ring-indigo-600"
                          />
                          <span className="text-xs text-gray-400">
                            Save my info for next time
                          </span>
                        </label>
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
