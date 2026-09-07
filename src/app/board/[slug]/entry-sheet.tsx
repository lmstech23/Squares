"use client";

import { useState } from "react";

// Standalone Entry Ticket purchase.
//
// ADMISSION, NOT A SQUARE. Nothing on this screen claims a spot on the board,
// enters a drawing, or holds inventory, so there is no countdown and no
// position number. Someone who only wants to come to the event buys here.
//
// NO DONATE-ADMISSIONS TOGGLE — STANDALONE ENTRY NEVER DONATES ADMISSION.
// Buying your own admission and then donating it back is not a thing anyone
// means to do; the control would read as a trap. The server writes the grant
// with donateAdmissions false and a database CHECK makes any other value on a
// standalone grant unrepresentable, so the absence of this control is enforced
// rather than merely intended.
//
// CARD ONLY. A direct payment is reserved-then-confirmed, and there is nowhere
// to remember the priced tier lines between those two moments — passes are
// minted only inside the confirmation transaction. Rather than show a payment
// option the server cannot honour, the picker is not offered here.
//
// THE PRICES ARE THE SERVER'S. Every amount shown was computed by
// entry-pricing.ts and passed down; this component multiplies and adds and
// decides nothing. The purchase is re-priced server-side on submit anyway, so a
// tampered total cannot become a charge.

export interface EntryTierOffer {
  tier: "CHILD" | "ADULT";
  label: string;
  priceCents: number;
  /** Shown under the price when an early-bird window is what set it. */
  note: string | null;
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

export default function EntrySheet({
  slug,
  offers,
  onClose,
}: {
  slug: string;
  /** Only the tiers this board actually offers. An empty list means this sheet
      should never have been opened, and the CTA that opens it is hidden. */
  offers: EntryTierOffer[];
  onClose: () => void;
}) {
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const qty = (tier: string) => counts[tier] ?? 0;
  const bump = (tier: string, by: number) =>
    setCounts((c) => ({ ...c, [tier]: Math.max(0, (c[tier] ?? 0) + by) }));

  const totalPasses = offers.reduce((n, o) => n + qty(o.tier), 0);
  const totalCents = offers.reduce((n, o) => n + qty(o.tier) * o.priceCents, 0);

  async function submit() {
    if (totalPasses === 0) {
      setError("Choose at least one ticket.");
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
    // Both identity keys are required on every contribution. The server is the
    // enforcement; this is the courtesy that saves a round trip.
    if (!phone.trim()) {
      setError("A phone number is required.");
      return;
    }
    setError(null);
    setLoading(true);
    try {
      const res = await fetch(`/api/board/${slug}/entry`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lines: offers
            .filter((o) => qty(o.tier) > 0)
            .map((o) => ({ tier: o.tier, quantity: qty(o.tier) })),
          buyerName: name.trim(),
          buyerEmail: email.trim(),
          buyerPhone: phone.trim() || null,
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
          <h2 className="text-base font-medium">Buy entry tickets</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-500 hover:text-gray-300 text-sm"
          >
            Close
          </button>
        </div>

        <p className="mt-1 text-xs text-gray-500 leading-relaxed">
          Admission to the event. Each ticket admits one person. This
          doesn&apos;t claim a spot on the board.
        </p>

        <div className="mt-4 space-y-2">
          {offers.map((o) => (
            <div
              key={o.tier}
              className="flex items-center justify-between gap-3 rounded-lg border border-gray-800 bg-gray-900 px-3 py-2.5"
            >
              <div className="min-w-0">
                <p className="text-sm text-gray-200">{o.label}</p>
                <p className="text-xs text-gray-500">
                  {money(o.priceCents)}
                  {o.note && <span className="text-gray-600"> · {o.note}</span>}
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  aria-label={`One fewer ${o.label}`}
                  onClick={() => bump(o.tier, -1)}
                  disabled={qty(o.tier) === 0}
                  className="h-8 w-8 rounded-lg border border-gray-800 text-gray-300 disabled:text-gray-700 hover:border-gray-700 transition-colors"
                >
                  −
                </button>
                <span className="w-6 text-center text-sm tabular-nums">
                  {qty(o.tier)}
                </span>
                <button
                  type="button"
                  aria-label={`One more ${o.label}`}
                  onClick={() => bump(o.tier, 1)}
                  className="h-8 w-8 rounded-lg border border-gray-800 text-gray-300 hover:border-gray-700 transition-colors"
                >
                  +
                </button>
              </div>
            </div>
          ))}
        </div>

        {totalPasses > 0 && (
          <p className="mt-3 text-sm text-gray-300">
            {totalPasses} {totalPasses === 1 ? "pass" : "passes"} ·{" "}
            <span className="font-medium">{money(totalCents)}</span>
          </p>
        )}

        <div className="mt-4 space-y-3">
          <div>
            <label className={labelClass} htmlFor="entry-name">
              Your name
            </label>
            <input
              id="entry-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={inputClass}
            />
          </div>
          <div>
            <label className={labelClass} htmlFor="entry-email">
              Email
            </label>
            <input
              id="entry-email"
              type="email"
              inputMode="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={inputClass}
            />
            <p className="mt-1 text-xs text-gray-600">
              Your passes are emailed here.
            </p>
          </div>
          <div>
            <label className={labelClass} htmlFor="entry-phone">
              Phone
            </label>
            <input
              id="entry-phone"
              type="tel"
              inputMode="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className={inputClass}
            />
          </div>
        </div>

        {error && <p className="mt-3 text-sm text-red-400">{error}</p>}

        <button
          type="button"
          onClick={submit}
          disabled={loading || totalPasses === 0}
          className="mt-5 w-full rounded-lg bg-white px-4 py-3 text-sm font-medium text-gray-950 hover:bg-gray-200 disabled:opacity-50 transition-colors"
        >
          {loading
            ? "One moment…"
            : totalPasses === 0
              ? "Choose your tickets"
              : `Pay ${money(totalCents)}`}
        </button>
      </div>
    </div>
  );
}
