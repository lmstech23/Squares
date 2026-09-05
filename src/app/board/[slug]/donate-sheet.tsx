"use client";

import { useState } from "react";

// Donation-only entry — donations §6.
//
// NO COUNTDOWN. Invariant 64: a donation-only contribution has no hold and no
// holdExpiresAt, so there is nothing to count down and a timer here would be a
// lie about scarcity that doesn't exist.
//
// NO DONATE-ADMISSIONS CHECKBOX. Donations §9: there are no admissions to
// donate, and rendering it produces a control that does nothing on the screen
// where the person has already given the most generous thing available.
//
// NO DEDUCTIBILITY LANGUAGE, anywhere on this screen — donations §12. Most
// hosts are parent groups and booster clubs, not registered charities, and the
// platform has no way to know which is which.

const PRESETS = [1000, 2500, 5000, 10000];
const MIN_CENTS = 500;

const inputClass =
  "w-full rounded-lg border border-gray-800 bg-gray-900 px-3 py-2.5 text-sm text-white placeholder:text-gray-600 outline-none focus:border-gray-600 transition-colors";
const labelClass = "block text-sm text-gray-400 mb-1.5";

function money(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  })}`;
}

export default function DonateSheet({
  slug,
  onClose,
}: {
  slug: string;
  onClose: () => void;
}) {
  // `Other` is a peer option, not a smaller link — the person giving $250
  // should not have to hunt for it (§6).
  const [preset, setPreset] = useState<number | "other">(2500);
  const [otherText, setOtherText] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const otherCents = Math.round(parseFloat(otherText) * 100);
  const amountCents =
    preset === "other" ? (Number.isNaN(otherCents) ? 0 : otherCents) : preset;

  async function submit() {
    if (amountCents < MIN_CENTS) {
      setError(`The minimum donation is ${money(MIN_CENTS)}.`);
      return;
    }
    if (!name.trim()) {
      setError("Your name is required.");
      return;
    }
    if (!email.trim()) {
      setError("Your email is required.");
      return;
    }
    setError(null);
    setLoading(true);
    try {
      const res = await fetch(`/api/board/${slug}/donate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amountCents,
          donorName: name.trim(),
          donorEmail: email.trim(),
          donorPhone: phone.trim() || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Something went wrong. Please try again.");
        setLoading(false);
        return;
      }
      if (data.checkoutUrl) {
        window.location.href = data.checkoutUrl;
        return;
      }
      setError("Something went wrong. Please try again.");
      setLoading(false);
    } catch {
      setError("Something went wrong. Please try again.");
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70 p-0 sm:p-4">
      <div className="w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl border border-gray-800 bg-gray-950 p-5 max-h-[92vh] overflow-y-auto">
        <div className="flex items-start justify-between">
          <h2 className="text-base font-medium">Make a donation</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-500 hover:text-gray-300 text-sm"
          >
            Close
          </button>
        </div>

        <p className="mt-1 text-xs text-gray-500 leading-relaxed">
          A donation goes straight to the cause. It doesn&apos;t claim a spot on
          the board.
        </p>

        <div className="mt-4">
          <span className={labelClass}>Amount</span>
          <div className="grid grid-cols-5 gap-2">
            {PRESETS.map((cents) => (
              <button
                key={cents}
                type="button"
                onClick={() => setPreset(cents)}
                className={`rounded-lg border px-2 py-2.5 text-sm transition-colors ${
                  preset === cents
                    ? "border-white bg-white text-gray-950 font-medium"
                    : "border-gray-800 bg-gray-900 text-gray-300 hover:border-gray-700"
                }`}
              >
                {money(cents)}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setPreset("other")}
              className={`rounded-lg border px-2 py-2.5 text-sm transition-colors ${
                preset === "other"
                  ? "border-white bg-white text-gray-950 font-medium"
                  : "border-gray-800 bg-gray-900 text-gray-300 hover:border-gray-700"
              }`}
            >
              Other
            </button>
          </div>
        </div>

        {preset === "other" && (
          <div className="mt-3">
            <label className={labelClass} htmlFor="donate-other">
              Amount in dollars
            </label>
            <input
              id="donate-other"
              inputMode="decimal"
              value={otherText}
              onChange={(e) => setOtherText(e.target.value)}
              placeholder="250"
              className={inputClass}
            />
          </div>
        )}

        <div className="mt-4 space-y-3">
          <div>
            <label className={labelClass} htmlFor="donate-name">
              Your name
            </label>
            <input
              id="donate-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={inputClass}
            />
          </div>
          <div>
            <label className={labelClass} htmlFor="donate-email">
              Email
            </label>
            <input
              id="donate-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={inputClass}
            />
          </div>
          <div>
            <label className={labelClass} htmlFor="donate-phone">
              Phone <span className="text-gray-600">(optional)</span>
            </label>
            <input
              id="donate-phone"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className={inputClass}
            />
          </div>
        </div>

        {error && (
          <p className="mt-3 text-sm text-red-400" role="alert">
            {error}
          </p>
        )}

        <div className="mt-5 flex items-center justify-between rounded-lg border border-gray-800 bg-gray-900 px-3 py-2.5">
          <span className="text-sm text-gray-400">Total</span>
          <span className="text-sm font-medium">{money(amountCents)}</span>
        </div>

        <button
          type="button"
          onClick={submit}
          disabled={loading}
          className="mt-4 w-full rounded-lg bg-white px-4 py-3 text-sm font-medium text-gray-950 hover:bg-gray-200 disabled:opacity-40 transition-colors"
        >
          {loading ? "Starting checkout…" : `Donate ${money(amountCents)}`}
        </button>

        <p className="mt-3 text-[11px] text-gray-600 leading-relaxed">
          Your donation goes to the host running this fundraiser. Daali collects
          it on their behalf.
        </p>
      </div>
    </div>
  );
}
