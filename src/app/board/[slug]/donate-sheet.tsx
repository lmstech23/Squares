"use client";

import { useState } from "react";
import type { PanelRail } from "./purchase-panel";
import {
  CONTRIBUTION_THANKS,
  AWAITING_HOST_CONFIRMATION,
} from "@/lib/board-vocabulary";

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
  "w-full rounded-lg border border-tone-800 bg-tone-900 px-3 py-2.5 text-sm text-tone-fg placeholder:text-tone-600 outline-none focus:border-tone-600 transition-colors";
const labelClass = "block text-sm text-tone-400 mb-1.5";

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
  rails,
  onClose,
}: {
  slug: string;
  cashModeEnabled: boolean;
  stripeConnected: boolean;
  /**
   * The rails this board accepts, ALREADY NARROWED by the server through
   * `acceptedRails` - the same source the ticket panel uses. This sheet does
   * not decide eligibility and never sees a method it may not offer.
   */
  rails: PanelRail[];
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
  const [declared, setDeclared] = useState<
    { amountCents: number; railLabel: string; handle: string } | null
  >(null);
  // ONE RAIL, CHOSEN BEFORE SUBMITTING. Preselected only when there is exactly
  // one: with two, a default is a payment sent to the wrong app by someone who
  // did not notice the choice was made for them.
  const [rail, setRail] = useState<PanelRail["rail"] | null>(
    rails.length === 1 ? rails[0].rail : null
  );

  const otherCents = Math.round(parseFloat(otherText) * 100);
  const amountCents =
    preset === "other" ? (Number.isNaN(otherCents) ? 0 : otherCents) : preset;

  // BOTH CONDITIONS, matching what the route enforces. `rails` is already
  // narrowed by acceptedRails, but the route ALSO refuses when direct payment
  // is switched off on the board - so offering a rail on that basis alone would
  // put a donor in front of a 403 they cannot act on.
  const anyHandle = cashModeEnabled && rails.length > 0;

  async function submit() {
    // The $5 floor is a CARD rule - it exists because Stripe's per-transaction
    // cost consumes a small gift. A direct payment has no processor and no
    // floor, so it is not applied here.
    // Both identity keys are required on every contribution now. The server
    // is the enforcement; this is the courtesy that saves a round trip.
    if (!phone.trim()) {
      setError("A phone number is required.");
      return;
    }
    if (method === "cash" && !rail) {
      setError("Choose how you will pay.");
      return;
    }
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
          paymentRail: rail,
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
        // The server echoes back the ONE handle for the rail chosen, so the
        // next screen shows a single destination rather than a list.
        setDeclared({
          amountCents: data.amountCents ?? amountCents,
          railLabel: data.railLabel ?? "",
          handle: data.handle ?? "",
        });
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
        <div className="w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl border border-tone-800 bg-tone-950 p-5 max-h-[92vh] overflow-y-auto">
          {/* SAME FIRST LINE AS EVERY OTHER SUCCESSFUL SUBMIT STATE, including
              here, where no money has arrived yet. This screen is the ONLY one
              a direct payer ever sees; leaving the thank-you off it means that
              contributor is never thanked at all. What has and has not
              happened is the next-step line at the bottom. */}
          <p className="text-base font-medium">{CONTRIBUTION_THANKS}</p>
          <h2 className="mt-1 text-sm text-tone-300">
            Send {money(declared.amountCents)} by {declared.railLabel}
          </h2>
          {/* ONE DESTINATION. This screen used to list every handle the host
              had, which left the donor choosing between the host's payment
              identities at the moment they were trying to send money. The
              choice is made up front now, and this shows only its answer. */}
          <div className="mt-4 rounded-lg border border-tone-800 bg-tone-900 px-3.5 py-3">
            <p className="text-[11px] uppercase tracking-wider text-tone-500">
              {declared.railLabel} to
            </p>
            <p className="mt-1 text-base text-tone-100 select-all break-all">
              {declared.handle}
            </p>
          </div>
          <p className="mt-4 text-sm text-tone-400">{AWAITING_HOST_CONFIRMATION}</p>

          <button
            type="button"
            onClick={onClose}
            className="mt-5 w-full rounded-lg bg-brand px-4 py-3 text-sm font-medium text-on-brand hover:bg-brand-hover transition-colors"
          >
            Done
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70 p-0 sm:p-4">
      <div className="w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl border border-tone-800 bg-tone-950 p-5 max-h-[92vh] overflow-y-auto">
        <div className="flex items-start justify-between">
          <h2 className="text-base font-medium">Make a donation</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-tone-500 hover:text-tone-300 text-sm"
          >
            Close
          </button>
        </div>

        <p className="mt-1 text-xs text-tone-500 leading-relaxed">
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
                    ? "border-brand bg-brand text-on-brand font-medium"
                    : "border-tone-800 bg-tone-900 text-tone-300 hover:border-tone-700"
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
                  ? "border-brand bg-brand text-on-brand font-medium"
                  : "border-tone-800 bg-tone-900 text-tone-300 hover:border-tone-700"
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
              Phone
            </label>
            <input
              id="donate-phone"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className={inputClass}
            />
          </div>
        </div>

        {/* HOW WILL YOU PAY.
            
            The card-or-direct choice comes first and only when both are
            genuinely available; the generic "Zelle, Cash App, Venmo, or
            PayPal" line is gone, because it advertised methods this board may
            not accept. Everything offered here came through `acceptedRails`,
            the same source the ticket panel uses. */}
        {stripeConnected && anyHandle && (
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
                      ? "border-brand-line bg-brand-wash/20 text-tone-fg"
                      : "border-tone-800 bg-tone-900 text-tone-400 hover:border-tone-700"
                  }`}
                >
                  {m === "card" ? "Card" : "Send it directly"}
                </button>
              ))}
            </div>
          </div>
        )}

        {stripeConnected && !anyHandle && (
          <div className="mt-4 rounded-lg border border-tone-800 bg-tone-900 px-3 py-2.5">
            <p className="text-sm text-tone-300">
              Payment: <span className="text-tone-fg">Credit or debit card</span>
            </p>
          </div>
        )}

        {/* ONE RAIL, NAMED. Only what this board accepts appears. */}
        {method === "cash" && anyHandle && (
          <div className="mt-4">
            <span className={labelClass}>How will you pay?</span>
            <div className="grid grid-cols-2 gap-2">
              {rails.map((r) => (
                <button
                  key={r.rail}
                  type="button"
                  onClick={() => setRail(r.rail)}
                  className={`rounded-lg border px-3 py-2.5 text-sm transition-colors ${
                    rail === r.rail
                      ? "border-brand bg-brand text-on-brand font-medium"
                      : "border-tone-800 bg-tone-900 text-tone-300 hover:border-tone-700"
                  }`}
                >
                  {r.label}
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-xs text-tone-600 leading-relaxed">
              You send the money directly to the host. Nothing is charged here,
              and your donation counts toward the total once they mark it
              received.
            </p>
          </div>
        )}

        {error && (
          <p className="mt-3 text-sm text-bad-400" role="alert">
            {error}
          </p>
        )}

        <div className="mt-5 flex items-center justify-between rounded-lg border border-tone-800 bg-tone-900 px-3 py-2.5">
          <span className="text-sm text-tone-400">Total</span>
          <span className="text-sm font-medium">{money(amountCents)}</span>
        </div>

        <button
          type="button"
          onClick={submit}
          disabled={loading}
          className="mt-4 w-full rounded-lg bg-brand px-4 py-3 text-sm font-medium text-on-brand hover:bg-brand-hover disabled:opacity-40 transition-colors"
        >
          {loading
            ? method === "card"
              ? "Starting checkout…"
              : "Recording…"
            : method === "card"
              ? `Donate ${money(amountCents)}`
              : `I'll send ${money(amountCents)}`}
        </button>

        <p className="mt-3 text-[11px] text-tone-600 leading-relaxed">
          Your donation goes to the host running this fundraiser. Daali collects
          it on their behalf.
        </p>
      </div>
    </div>
  );
}
