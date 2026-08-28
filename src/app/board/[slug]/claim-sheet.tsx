"use client";

import { useState } from "react";

// Claim sheet — fundraiser-board-v2.md §6.
//
// Primary action takes the next open squares. A quiet text link — not a second
// button — opens the picker for anyone who wants specific numbers.
//
// Maximum 10 per transaction (money doc §12). Mechanical, not a policy cap:
// there is no limit on how many squares a person may contribute overall, so
// the copy reads "claim more squares", never "limit reached".
//
// Not collected here: payout handles. That is Game Day behavior — winners are
// asked for a handle after the draw, four people rather than a hundred.

const MAX_PER_CLAIM = 10;

interface OpenSquare {
  squareId: string;
  position: number;
}

interface Props {
  openSquares: OpenSquare[];
  priceCents: number;
  hasEvent: boolean;
  cashModeEnabled: boolean;
  stripeConnected: boolean;
  slug: string;
  onClose: () => void;
}

const inputClass =
  "w-full rounded-lg border border-gray-800 bg-gray-900 px-3 py-2.5 text-sm text-white placeholder:text-gray-600 outline-none focus:border-gray-600 transition-colors";
const labelClass = "block text-sm text-gray-400 mb-1.5";

function money(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })}`;
}

export default function ClaimSheet({
  openSquares,
  priceCents,
  hasEvent,
  cashModeEnabled,
  stripeConnected,
  slug,
  onClose,
}: Props) {
  const [quantity, setQuantity] = useState(1);
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [donateAdmissions, setDonateAdmissions] = useState(false);

  const [method, setMethod] = useState<"card" | "cash">(
    stripeConnected ? "card" : "cash"
  );
  const [pin, setPin] = useState("");

  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Auto-assign takes the lowest-numbered open squares. Picking overrides it.
  const selected = picking
    ? picked
    : openSquares.slice(0, quantity).map((s) => s.squareId);

  const count = selected.length;
  const total = count * priceCents;

  function togglePick(squareId: string) {
    setPicked((prev) =>
      prev.includes(squareId)
        ? prev.filter((id) => id !== squareId)
        : prev.length >= MAX_PER_CLAIM
          ? prev
          : [...prev, squareId]
    );
  }

  async function submit() {
    if (count === 0) {
      setError("Pick at least one square.");
      return;
    }
    // Name and email are both required: EventSupporter.name and .email are
    // NOT NULL with no default, and resolveSupporter runs inside the claim
    // transaction, so an email-only sheet fails on the first claim. v2 §6.
    if (!name.trim()) {
      setError("Your name is required.");
      return;
    }
    if (!email.trim()) {
      setError("Your email is required.");
      return;
    }
    if (!phone.trim()) {
      setError("A phone number is required.");
      return;
    }
    if (method === "cash" && !pin.trim()) {
      setError("The host's cash PIN is required.");
      return;
    }

    setError(null);
    setLoading(true);

    const endpoint =
      method === "card" ? "/api/checkout" : `/api/board/${slug}/cash-reserve`;

    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          squareIds: selected,
          playerName: name.trim(),
          playerEmail: email.trim(),
          playerPhone: phone.trim(),
          donateAdmissions,
          ...(method === "cash" ? { pin: pin.trim() } : {}),
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Something went wrong. Please try again.");
        setLoading(false);
        return;
      }

      if (method === "card" && data.checkoutUrl) {
        window.location.href = data.checkoutUrl;
        return;
      }

      window.location.reload();
    } catch {
      setError("Network error. Please try again.");
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/70 flex items-end sm:items-center justify-center z-50">
      <div className="bg-gray-950 border border-gray-800 rounded-t-2xl sm:rounded-2xl w-full sm:max-w-md max-h-[92vh] overflow-y-auto p-5">
        <div className="flex items-start justify-between gap-3 mb-4">
          <h2 className="text-lg font-semibold">Claim your squares</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-500 hover:text-white text-sm"
          >
            Close
          </button>
        </div>

        {error && (
          <div className="rounded-lg border border-red-900/50 bg-red-950/30 p-3 mb-4">
            <p className="text-sm text-red-400">{error}</p>
          </div>
        )}

        {/* How many */}
        {!picking && (
          <div className="mb-4">
            <span className={labelClass}>How many?</span>
            <div className="grid grid-cols-5 gap-2">
              {[1, 2, 3, 4, 5].map((n) => (
                <button
                  key={n}
                  type="button"
                  disabled={n > openSquares.length}
                  onClick={() => setQuantity(n)}
                  className={`rounded-lg border py-2.5 text-sm font-medium transition-colors disabled:opacity-30 ${
                    quantity === n
                      ? "border-green-500 bg-green-950/20 text-white"
                      : "border-gray-800 bg-gray-900 text-gray-400 hover:border-gray-700"
                  }`}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Or pick your own — a quiet link, not a second button */}
        <button
          type="button"
          onClick={() => {
            setPicking((p) => !p);
            setPicked([]);
          }}
          className="text-sm text-gray-400 underline underline-offset-4 hover:text-white transition-colors mb-4"
        >
          {picking ? "Just take the next open ones" : "Or pick your own"}
        </button>

        {picking && (
          <div className="mb-4">
            <div className="grid grid-cols-5 min-[400px]:grid-cols-10 gap-1 max-h-52 overflow-y-auto">
              {openSquares.map((sq) => {
                const on = picked.includes(sq.squareId);
                return (
                  <button
                    key={sq.squareId}
                    type="button"
                    onClick={() => togglePick(sq.squareId)}
                    className={`aspect-square rounded-sm text-[10px] tabular-nums border transition-colors ${
                      on
                        ? "border-green-500 bg-green-950/40 text-green-200"
                        : "border-gray-800 bg-gray-900 text-gray-600 hover:border-gray-700"
                    }`}
                  >
                    {sq.position + 1}
                  </button>
                );
              })}
            </div>
            {picked.length >= MAX_PER_CLAIM && (
              <p className="text-xs text-gray-500 mt-2">
                That is {MAX_PER_CLAIM} — the most you can claim at once. You
                can claim more squares after checkout.
              </p>
            )}
          </div>
        )}

        <div className="rounded-lg bg-gray-900 border border-gray-800 px-3 py-2.5 mb-4 text-sm">
          {count} {count === 1 ? "square" : "squares"} —{" "}
          <span className="font-semibold">{money(total)}</span>
        </div>

        {/* Contact — name and email are both required */}
        <div className="space-y-3 mb-4">
          <div>
            <label htmlFor="claimName" className={labelClass}>
              Your name
            </label>
            <input
              id="claimName"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={inputClass}
            />
          </div>
          <div>
            <label htmlFor="claimEmail" className={labelClass}>
              Email
            </label>
            <input
              id="claimEmail"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={inputClass}
            />
          </div>
          <div>
            <label htmlFor="claimPhone" className={labelClass}>
              Phone
            </label>
            <input
              id="claimPhone"
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className={inputClass}
            />
          </div>
        </div>

        {/* Admission — one square, one pass. Addendum v2.0 §1. */}
        {hasEvent && (
          <label className="flex items-start gap-2.5 cursor-pointer mb-4">
            <input
              type="checkbox"
              checked={donateAdmissions}
              onChange={(e) => setDonateAdmissions(e.target.checked)}
              className="mt-0.5 accent-green-500"
            />
            <span>
              <span className="block text-sm">
                I am not attending — donate my admissions
              </span>
              <span className="block text-xs text-gray-600 mt-0.5">
                {donateAdmissions
                  ? "No admission passes for this purchase."
                  : `${count} admission ${
                      count === 1 ? "pass" : "passes"
                    }, one per square.`}
              </span>
            </span>
          </label>
        )}

        {/* Payment — only methods that actually work are offered */}
        {stripeConnected && cashModeEnabled && (
          <div className="grid grid-cols-2 gap-2 mb-4">
            {(["card", "cash"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMethod(m)}
                className={`rounded-lg border py-2.5 text-sm font-medium transition-colors ${
                  method === m
                    ? "border-green-500 bg-green-950/20 text-white"
                    : "border-gray-800 bg-gray-900 text-gray-400 hover:border-gray-700"
                }`}
              >
                {m === "card" ? "Card" : "Cash / Direct Pay"}
              </button>
            ))}
          </div>
        )}

        {method === "cash" && (
          <div className="mb-4">
            <label htmlFor="claimPin" className={labelClass}>
              Host cash PIN
            </label>
            <input
              id="claimPin"
              inputMode="numeric"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              className={inputClass}
            />
          </div>
        )}

        {/* The no-refund policy must be visible before payment — money doc §8 */}
        <p className="text-xs text-gray-600 mb-4 leading-relaxed">
          Contributions are final. Once your payment is confirmed it cannot be
          refunded.
        </p>

        <button
          type="button"
          onClick={submit}
          disabled={loading || count === 0}
          className="w-full rounded-lg bg-white px-4 py-3 text-sm font-medium text-gray-950 hover:bg-gray-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {loading ? "Working…" : `Continue — ${money(total)}`}
        </button>
      </div>
    </div>
  );
}
