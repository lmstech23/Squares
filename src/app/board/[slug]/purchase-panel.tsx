"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// The contributor purchase panel — direct payment.
//
// Steppers for each tier, an optional donation, a running total, and the rails
// this board accepts. One transfer, one reference code, one host action.
//
// THE RAILS ARE PASSED IN, ALREADY NARROWED. The server resolves them through
// `acceptedRails`, which requires BOTH that the board lists the rail and that
// the handle exists. This component never sees a method the board does not
// accept, so it cannot offer one — the same data-boundary rule the square
// product follows.
//
// NO CARD. Not "card hidden": a card purchase is a different route with a
// different lifecycle (Stripe session, webhook confirmation, immediate passes),
// and this panel reserves. A board that accepts card gets that path elsewhere.
//
// NO COUNTDOWN. Nothing is held, so nothing runs out.
//
// THE PRICES ARE THE SERVER'S. Every amount shown was computed by
// entry-pricing.ts and passed down; this component multiplies and adds and
// decides nothing. The reservation is re-priced server-side on submit, so a
// tampered total cannot become a reservation.

export interface PanelTier {
  tier: "CHILD" | "ADULT";
  label: string;
  priceCents: number;
  /** Set only when an early-bird window is what set this price. */
  note: string | null;
}

export interface PanelRail {
  rail: "zelle" | "cashapp" | "venmo" | "paypal";
  label: string;
}

const inputClass =
  "w-full rounded-lg border border-gray-800 bg-gray-900 px-3 py-2.5 text-sm text-white placeholder:text-gray-600 outline-none focus:border-gray-600 transition-colors";
const labelClass = "block text-sm text-gray-400 mb-1.5";

function money(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

export default function PurchasePanel({
  slug,
  tiers,
  rails,
  signupSheetExists,
  onClose,
}: {
  slug: string;
  tiers: PanelTier[];
  rails: PanelRail[];
  /** Whether this event has a sign-up sheet for the help checkbox to lead to. */
  signupSheetExists: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [donationText, setDonationText] = useState("");
  const [rail, setRail] = useState<PanelRail["rail"] | null>(
    rails.length === 1 ? rails[0].rail : null
  );
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [wantsToHelp, setWantsToHelp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const qty = (tier: string) => counts[tier] ?? 0;
  const bump = (tier: string, by: number) =>
    setCounts((c) => ({ ...c, [tier]: Math.max(0, (c[tier] ?? 0) + by) }));

  const ticketCount = tiers.reduce((n, t) => n + qty(t.tier), 0);
  const ticketCents = tiers.reduce((n, t) => n + qty(t.tier) * t.priceCents, 0);

  // Parsed defensively: an empty or unparseable box is no donation, never NaN
  // leaking into the total a contributor is about to send.
  const parsed = Math.round(parseFloat(donationText) * 100);
  const donationCents =
    donationText.trim() === "" || !Number.isFinite(parsed) || parsed < 0 ? 0 : parsed;

  const totalCents = ticketCents + donationCents;

  async function submit() {
    if (ticketCount === 0) {
      setError("Choose at least one ticket.");
      return;
    }
    if (!rail) {
      setError("Choose how you will pay.");
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
    if (!phone.trim()) {
      setError("A phone number is required.");
      return;
    }
    setError(null);
    setLoading(true);
    try {
      const res = await fetch(`/api/board/${slug}/entry/reserve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lines: tiers
            .filter((t) => qty(t.tier) > 0)
            .map((t) => ({ tier: t.tier, quantity: qty(t.tier) })),
          donationAmountCents: donationCents,
          buyerName: name.trim(),
          buyerEmail: email.trim(),
          buyerPhone: phone.trim(),
          paymentRail: rail,
          wantsToHelp,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Something went wrong. Please try again.");
        setLoading(false);
        return;
      }
      // Straight to the pending-payment screen: what to send, where, and the
      // reference code.
      //
      // THE IMMEDIATE VIEW, NOT THE ONLY ONE. This said "that page is the only
      // thing a direct payer needs", and it was the design assumption until a
      // closed tab was recognised as taking the reference code with it - the
      // one thing the host needs to match a bank memo to this row. The reserve
      // route now emails the same details as a recovery path. The page stays
      // the authority, because it recomputes from the board and can say a
      // handle was cleared; the email is frozen at send and points back here.
      //
      // router.push, not window.location. This is an INTERNAL route - the
      // sheets that assign window.location.href are leaving for an external
      // Stripe URL, which is a different thing. A client navigation keeps the
      // app shell and avoids a full reload on a phone.
      router.push(`/reservation/${data.reservationId}`);
    } catch {
      setError("Something went wrong. Please try again.");
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70 p-0 sm:p-4">
      <div className="w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl border border-gray-800 bg-gray-950 p-5 max-h-[92vh] overflow-y-auto">
        <div className="flex items-start justify-between">
          <h2 className="text-base font-medium">Get your tickets</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-500 hover:text-gray-300 text-sm"
          >
            Close
          </button>
        </div>

        <p className="mt-1 text-xs text-gray-500 leading-relaxed">
          Admission to the event. Each ticket admits one person.
        </p>

        {/* ---- tiers ---- */}
        <div className="mt-4 space-y-2">
          {tiers.map((t) => (
            <div
              key={t.tier}
              className="flex items-center justify-between gap-3 rounded-lg border border-gray-800 bg-gray-900 px-3 py-2.5"
            >
              <div className="min-w-0">
                <p className="text-sm text-gray-200">{t.label}</p>
                <p className="text-xs text-gray-500">
                  {money(t.priceCents)}
                  {t.note && <span className="text-gray-600"> · {t.note}</span>}
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  aria-label={`One fewer ${t.label}`}
                  onClick={() => bump(t.tier, -1)}
                  disabled={qty(t.tier) === 0}
                  className="h-9 w-9 rounded-lg border border-gray-800 text-lg text-gray-300 disabled:text-gray-700 hover:border-gray-700 transition-colors"
                >
                  −
                </button>
                <span className="w-6 text-center text-sm tabular-nums">{qty(t.tier)}</span>
                <button
                  type="button"
                  aria-label={`One more ${t.label}`}
                  onClick={() => bump(t.tier, 1)}
                  className="h-9 w-9 rounded-lg border border-gray-800 text-lg text-gray-300 hover:border-gray-700 transition-colors"
                >
                  +
                </button>
              </div>
            </div>
          ))}
        </div>

        {/* ---- optional donation ---- */}
        <div className="mt-4">
          <label className={labelClass} htmlFor="panel-donation">
            Add a donation <span className="text-gray-600">(optional)</span>
          </label>
          <div className="flex items-center gap-2">
            <span className="text-sm text-gray-500">$</span>
            <input
              id="panel-donation"
              inputMode="decimal"
              value={donationText}
              onChange={(e) => setDonationText(e.target.value)}
              placeholder="25"
              className={inputClass}
            />
          </div>
          <p className="mt-1 text-xs text-gray-600">
            Sent in the same transfer. It buys no ticket — it goes straight to
            the cause.
          </p>
        </div>

        {/* ---- running total ---- */}
        <div className="mt-4 rounded-lg border border-gray-800 bg-gray-900 p-3.5">
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="text-gray-400">
              {ticketCount} {ticketCount === 1 ? "ticket" : "tickets"}
            </span>
            <span className="tabular-nums text-gray-200">{money(ticketCents)}</span>
          </div>
          {donationCents > 0 && (
            <div className="mt-1.5 flex items-baseline justify-between gap-3 text-sm">
              <span className="text-gray-400">Donation</span>
              <span className="tabular-nums text-gray-200">{money(donationCents)}</span>
            </div>
          )}
          <div className="mt-2.5 flex items-baseline justify-between border-t border-gray-800 pt-2.5">
            <span className="text-sm font-medium">Total to send</span>
            <span className="text-xl font-bold tabular-nums">{money(totalCents)}</span>
          </div>
        </div>

        {/* ---- rails ---- */}
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
                    ? "border-white bg-white text-gray-950 font-medium"
                    : "border-gray-800 bg-gray-900 text-gray-300 hover:border-gray-700"
                }`}
              >
                {r.label}
              </button>
            ))}
          </div>
          <p className="mt-1.5 text-xs text-gray-600 leading-relaxed">
            You send the money directly to the host. Nothing is charged here.
          </p>
        </div>

        {/* ---- who ---- */}
        <div className="mt-4 space-y-3">
          <div>
            <label className={labelClass} htmlFor="panel-name">
              Your name
            </label>
            <input
              id="panel-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={inputClass}
            />
          </div>
          <div>
            <label className={labelClass} htmlFor="panel-email">
              Email
            </label>
            <input
              id="panel-email"
              type="email"
              inputMode="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={inputClass}
            />
            <p className="mt-1 text-xs text-gray-600">
              Your passes are emailed here once the host confirms.
            </p>
          </div>
          <div>
            <label className={labelClass} htmlFor="panel-phone">
              Phone
            </label>
            <input
              id="panel-phone"
              type="tel"
              inputMode="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className={inputClass}
            />
          </div>
        </div>


        {/* THE HELP CHECKBOX — sign-up addendum SS4, invariant 36.

            Asked at purchase because that is the one moment the buyer is
            already thinking about the event; asking later means an email
            nobody opens. Word for word the claim sheet's, because a ticket
            buyer and a square buyer are answering the same question.

            IT CLAIMS NOTHING. Ticking it puts nobody on the host's volunteer
            list - that list is HelperSignup rows, actual commitments. This
            decides whether the sign-up link is put in front of this person.

            Gated on the sheet existing: with no sheet there is nowhere for the
            link to go, so the question would be a promise Daali cannot keep. */}
        {signupSheetExists && (
          <label className="flex items-start gap-2.5 cursor-pointer mt-4">
            <input
              type="checkbox"
              checked={wantsToHelp}
              onChange={(e) => setWantsToHelp(e.target.checked)}
              className="mt-0.5 accent-green-500"
            />
            <span>
              <span className="block text-sm">
                I&apos;d like to help with the event
              </span>
              <span className="block text-xs text-gray-600 mt-0.5">
                Volunteer sign-up details will be sent with tickets after payment is confirmed.
              </span>
            </span>
          </label>
        )}

        {error && <p className="mt-3 text-sm text-red-400">{error}</p>}

        <button
          type="button"
          onClick={submit}
          disabled={loading || ticketCount === 0}
          className="mt-5 w-full rounded-lg bg-white px-4 py-3 text-sm font-medium text-gray-950 hover:bg-gray-200 disabled:opacity-50 transition-colors"
        >
          {loading
            ? "One moment…"
            : ticketCount === 0
              ? "Choose your tickets"
              : `Reserve ${money(totalCents)}`}
        </button>
      </div>
    </div>
  );
}
