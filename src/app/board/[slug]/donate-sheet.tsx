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
  cashModeEnabled,
  stripeConnected,
  handles,
  onClose,
}: {
  slug: string;
  cashModeEnabled: boolean;
  stripeConnected: boolean;
  /// Where a direct payment should be sent. Same handles the ticket sheet uses.
  handles: {
    venmo: string | null;
    zelle: string | null;
    cashapp: string | null;
    paypal: string | null;
  };
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
  // Same picker the ticket sheet has - SS6C. A donor choosing Zelle was
  // previously sent straight to Stripe with no choice at all.
  const [method, setMethod] = useState<"card" | "cash">(
    stripeConnected ? "card" : "cash"
  );
  // Set once a direct payment is declared: the sheet stops being a form and
  // becomes the instructions, because the money moves outside Daali.
  const [declared, setDeclared] = useState<number | null>(null);

  const otherCents = Math.round(parseFloat(otherText) * 100);
  const amountCents =
    preset === "other" ? (Number.isNaN(otherCents) ? 0 : otherCents) : preset;

  const anyHandle =
    handles.zelle || handles.cashapp || handles.venmo || handles.paypal;

  async function submit() {
    // The $5 floor is a CARD rule - it exists because Stripe's per-transaction
    // cost consumes a small gift. A direct payment has no processor and no
    // floor, so it is not applied here.
    if (method === "card" && amountCents < MIN_CENTS) {
      setError(`The minimum donation is ${money(MIN_CENTS)}.`);
      return;
    }
    if (amountCents <= 0) {
      setError("Enter an amount greater than zero.");
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
          method,
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
      if (data.pending) {
        // Nothing redirects: the money moves outside Daali and the host marks
        // it received. Swap the form for the instructions.
        setDeclared(data.amountCents ?? amountCents);
        setLoading(false);
        return;
      }
      setError("Something went wrong. Please try again.");
      setLoading(false);
    } catch {
      setError("Something went wrong. Please try again.");
      setLoading(false);
    }
  }

  if (declared !== null) {
    return (
      <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70 p-0 sm:p-4">
        <div className="w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl border border-gray-800 bg-gray-950 p-5 max-h-[92vh] overflow-y-auto">
          <h2 className="text-base font-medium">Send {money(declared)}</h2>
          <p className="mt-1 text-xs text-gray-500 leading-relaxed">
            Use any of these. The host marks it received once it arrives, and
            your donation counts toward the total then.
          </p>
          <ul className="mt-4 space-y-1.5 text-sm">
            {handles.zelle && (
              <li>
                <span className="text-gray-500">Zelle</span> {handles.zelle}
              </li>
            )}
            {handles.cashapp && (
              <li>
                <span className="text-gray-500">Cash App</span> {handles.cashapp}
              </li>
            )}
            {handles.venmo && (
              <li>
                <span className="text-gray-500">Venmo</span> {handles.venmo}
              </li>
            )}
            {handles.paypal && (
              <li>
                <span className="text-gray-500">PayPal</span> {handles.paypal}
              </li>
            )}
          </ul>
          <p className="mt-4 text-xs text-gray-600 leading-relaxed">
            {/* NOTHING IS HELD. The ticket sheet says squares are held because
                they are inventory taken off the board. A donation takes no
                inventory, so there is nothing to hold and nothing to expire -
                invariants 55 and 64. Saying otherwise would be a lie about
                what this does. */}
            Nothing is being held and nothing expires. If you change your mind,
            just don&apos;t send it.
          </p>
          <button
            type="button"
            onClick={onClose}
            className="mt-5 w-full rounded-lg bg-white px-4 py-3 text-sm font-medium text-gray-950 hover:bg-gray-200 transition-colors"
          >
            Done
          </button>
        </div>
      </div>
    );
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

        {/* How would you like to pay? - SS6C, matching the ticket sheet.
            Only methods that actually work are offered. */}
        {!(stripeConnected && cashModeEnabled && anyHandle) && (
          <div className="mt-4 rounded-lg border border-gray-800 bg-gray-900 px-3 py-2.5">
            <p className="text-sm text-gray-300">
              Payment:{" "}
              <span className="text-white">
                {stripeConnected
                  ? "Credit or debit card"
                  : "Zelle, Cash App, Venmo, or PayPal"}
              </span>
            </p>
          </div>
        )}

        {stripeConnected && cashModeEnabled && anyHandle && (
          <div className="mt-4">
            <span className={labelClass}>How would you like to pay?</span>
            <div className="space-y-2">
              {(["card", "cash"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMethod(m)}
                  className={`w-full text-left rounded-lg border px-3 py-2.5 text-sm transition-colors ${
                    method === m
                      ? "border-green-500 bg-green-950/20 text-white"
                      : "border-gray-800 bg-gray-900 text-gray-400 hover:border-gray-700"
                  }`}
                >
                  {m === "card" ? "Card" : "Zelle, CashApp, Venmo, or PayPal"}
                </button>
              ))}
            </div>
          </div>
        )}

        {method === "cash" && anyHandle && (
          <div className="mt-4 rounded-lg border border-gray-800 bg-gray-900 p-3">
            <p className="text-sm mb-2">Send {money(amountCents)} to:</p>
            <ul className="space-y-1 text-sm">
              {handles.zelle && (
                <li>
                  <span className="text-gray-500">Zelle</span> {handles.zelle}
                </li>
              )}
              {handles.cashapp && (
                <li>
                  <span className="text-gray-500">Cash App</span> {handles.cashapp}
                </li>
              )}
              {handles.venmo && (
                <li>
                  <span className="text-gray-500">Venmo</span> {handles.venmo}
                </li>
              )}
              {handles.paypal && (
                <li>
                  <span className="text-gray-500">PayPal</span> {handles.paypal}
                </li>
              )}
            </ul>
            <p className="text-xs text-gray-600 mt-2.5 leading-relaxed">
              Your donation counts toward the total once the host marks your
              payment received.
            </p>
          </div>
        )}

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
          {loading
            ? method === "card"
              ? "Starting checkout…"
              : "Recording…"
            : method === "card"
              ? `Donate ${money(amountCents)}`
              : `I'll send ${money(amountCents)}`}
        </button>

        <p className="mt-3 text-[11px] text-gray-600 leading-relaxed">
          Your donation goes to the host running this fundraiser. Daali collects
          it on their behalf.
        </p>
      </div>
    </div>
  );
}
