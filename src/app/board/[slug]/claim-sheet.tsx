"use client";

import { useState } from "react";
import { purchaseUnit, ADMISSION } from "@/lib/board-vocabulary";

// Claim sheet — fundraiser-board-v2.md §6.
//
// QUANTITY-FIRST, AND ONLY QUANTITY. Choose how many, the next open squares in
// board-position order are assigned, the numbers and total are shown, continue.
//
// The grid picker that used to live in this modal is gone, not demoted. It
// rendered all 100 squares in a scrolling box inside a popup, which made
// "just take the next open ones" — the path almost everyone wants — read as
// the secondary option. The board grid is still on the page behind this sheet
// as progress and availability; it is simply not how a purchase is made.
//
// SELECTION IS DISPLAY ONLY. Choosing a quantity computes which squares WOULD
// be assigned. Nothing is reserved or claimed until `submit()` posts to
// /api/checkout or /cash-reserve — the same commit point as before. Opening
// this sheet and backing out consumes nothing. This is a UI change; if it ever
// moves when squares get consumed, it is wrong.
//
// Not collected here: payout handles. That is Game Day behavior — winners are
// asked for a handle after the draw, four people rather than a hundred.


interface OpenSquare {
  squareId: string;
  position: number;
}

interface Props {
  openSquares: OpenSquare[];
  priceCents: number;
  hasEvent: boolean;
  /// prizePoolPercent > 0. Only used to name the purchase unit.
  hasPrize: boolean;
  cashModeEnabled: boolean;
  stripeConnected: boolean;
  /// Where a direct payment should be sent. At least one is present on a
  /// fundraiser board — §6C.
  handles: {
    venmo: string | null;
    zelle: string | null;
    cashapp: string | null;
    paypal: string | null;
  };
  slug: string;
  /// Squares to preselect — used when re-claiming after a hold expired.
  initialPicked?: string[];
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
  hasPrize,
  cashModeEnabled,
  stripeConnected,
  handles,
  slug,
  initialPicked,
  onClose,
}: Props) {
  // A re-claim after an expired hold arrives with the exact squares that were
  // held. Honour those rather than re-assigning, so someone reclaiming gets
  // back what they had — but the quantity control still drives everything, and
  // changing it falls through to normal assignment.
  const reclaiming = (initialPicked?.length ?? 0) > 0;
  // No MAX_PER_CLAIM clamp: a reclaim restores exactly what was held, and
  // inventory is the only fundraiser ceiling.
  //
  // HELD AS A STRING, NOT A NUMBER. The donor must be able to clear the field
  // and type their own figure, and "" is not representable in a number state.
  // The previous version coerced on every keystroke with `NaN ? 1`, so deleting
  // the digit wrote 1 straight back and the box could never be emptied.
  const [quantityText, setQuantityText] = useState(
    reclaiming ? String(initialPicked!.length) : "1"
  );
  const [useReclaim, setUseReclaim] = useState(reclaiming);

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [donateAdmissions, setDonateAdmissions] = useState(false);
  // Extra donation riding on this checkout - donations SS6. One session,
  // two line items, one Contribution (invariant 59). Held as text for the
  // same reason the quantity is: the field has to be clearable.
  const [donationText, setDonationText] = useState("");

  const [method, setMethod] = useState<"card" | "cash">(
    stripeConnected ? "card" : "cash"
  );

  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Contributor-facing noun. A board with an event sells TICKETS — the square
  // is an implementation detail the buyer never asked about. Without an event
  // nothing is admitted, so "ticket" would name something they do not receive
  // and the word stays "square". Same hasEvent predicate as the CTA.
  //
  // NOTHING INTERNAL IS RENAMED: Square, columns, APIs, variables and schema
  // concepts are untouched. This is copy only.
  // One shared resolver — src/lib/board-vocabulary.ts. Never branched locally.
  const u = purchaseUnit({ boardType: "fundraiser", hasEvent, hasPrize });

  // The donor's intent, as a number. Empty or unparsable reads as 0, which
  // flows through to `count === 0` and the existing "choose at least one"
  // guard — no second validation path. Capped for DISPLAY only, so the summary
  // and total never promise more than exists while she is still typing.
  const parsedQuantity = parseInt(quantityText, 10);
  const quantity = Number.isNaN(parsedQuantity)
    ? 0
    : Math.min(parsedQuantity, openSquares.length);

  // The next open squares in board-position order. `openSquares` arrives sorted
  // by position, so slicing takes the lowest-numbered available.
  //
  // NOTHING IS RESERVED HERE. This only decides what to display.
  const selected = useReclaim
    ? initialPicked!
    : openSquares.slice(0, quantity).map((s) => s.squareId);

  const selectedPositions = selected
    .map((id) => openSquares.find((sq) => sq.squareId === id)?.position)
    .filter((pos): pos is number => pos != null)
    .map((pos) => pos + 1)
    .sort((a, b) => a - b);

  const count = selected.length;
  const squareTotal = count * priceCents;

  // Empty or unparsable reads as 0, which flows through to "no donation" with
  // no second validation path. The $5 floor is enforced server-side too.
  const parsedDonation = Math.round(parseFloat(donationText) * 100);
  const donationCents =
    method === "card" && Number.isFinite(parsedDonation) && parsedDonation > 0
      ? parsedDonation
      : 0;
  const total = squareTotal + donationCents;

  // Per TRANSACTION, and never more than are actually open.
  // INVENTORY IS THE ONLY CEILING on a fundraiser board. No MAX_PER_CLAIM
  // here — see src/lib/claim-limits.ts for why that constant is Game Day only.
  const maxQuantity = openSquares.length;

  async function submit() {
    if (count === 0) {
      setError(`Choose at least one ${u.one}.`);
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
    // Donations SS6: minimum card donation is $5. Below that Stripe's
    // per-transaction cost consumes most of the gift.
    if (donationCents > 0 && donationCents < 500) {
      setError("The minimum donation is $5.");
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
          ...(donationCents > 0 ? { donationAmountCents: donationCents } : {}),
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Something went wrong. Please try again.");
        setLoading(false);
        return;
      }

      if (method === "card" && data.checkoutUrl) {
        // Remember the hold so the board can show the countdown if they come
        // back without paying. Per-browser and disposable — never state we
        // rely on, since the server timestamp is the truth.
        if (data.holdExpiresAt) {
          try {
            sessionStorage.setItem(
              `daali-hold-${slug}`,
              JSON.stringify({
                holdExpiresAt: data.holdExpiresAt,
                squareIds: data.squareIds ?? selected,
              })
            );
          } catch {
            // Private browsing or storage disabled — the countdown is a
            // convenience, so losing it must not block checkout.
          }
        }
        // assign() rather than `location.href = ...`: same navigation, but a
        // method call rather than a mutation of a binding outside the component.
        window.location.assign(data.checkoutUrl);
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
          {/* The heading used to duplicate the first control. With a
              quantity-first flow the question IS the heading. */}
          <h2 className="text-lg font-semibold">How many {u.many}?</h2>
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

        {/* How many — free entry, bounded only by what is open.
            MAX_PER_CLAIM is a GAME DAY concept: 10 of 100 makes sense for a
            game with a prize pool, and is backwards for a fundraiser, where a
            contributor who wants 20 is the best thing that can happen.

            NO PRESET BUTTONS. 1 / 2 / 5 / 10 anchored the donor to a number the
            app chose, and the four that fit a phone row are not the four any
            given campaign needs. The field is the control. */}
        <div className="mb-4">
          <label htmlFor="quantity" className={labelClass}>
            How many {u.many}?
          </label>
          <input
            id="quantity"
            type="number"
            inputMode="numeric"
            min={1}
            max={maxQuantity}
            value={quantityText}
            onChange={(e) => {
              // STORES, NEVER COERCES. No clamping on the way in: clamping per
              // keystroke is what stopped the field being clearable, and it also
              // rewrites a number mid-entry — typing toward 150 became 100 the
              // moment the third digit landed. Digits only, so type="number"
              // cannot smuggle in "e" or a minus sign.
              setQuantityText(e.target.value.replace(/[^0-9]/g, ""));
              setUseReclaim(false);
            }}
            onBlur={() => {
              // Clamp DOWN only. An entry above what is left is impossible and
              // gets corrected; an empty field is a donor mid-decision and is
              // left alone. Restoring 1 would be the app choosing a quantity on
              // her behalf, which is the behaviour being removed.
              const n = parseInt(quantityText, 10);
              if (!Number.isNaN(n) && n > maxQuantity) {
                setQuantityText(String(maxQuantity));
              }
            }}
            className={inputClass}
          />
          <p className="text-xs text-gray-600 mt-1.5">
            {maxQuantity} {maxQuantity === 1 ? `${u.one} is` : `${u.many} are`} left.
          </p>
        </div>

        {/* Add a donation on top - donations SS6. Card only: a cash donation
            is a host action with no reserve step (SS7), so there is nothing for
            this field to do on the direct-payment path. */}
        {method === "card" && (
          <div className="mb-4">
            <label className={labelClass} htmlFor="claim-donation">
              Add a donation{" "}
              <span className="text-gray-600">(optional, $5 minimum)</span>
            </label>
            <input
              id="claim-donation"
              inputMode="decimal"
              value={donationText}
              onChange={(e) => setDonationText(e.target.value)}
              placeholder="0"
              className={inputClass}
            />
            <p className="text-xs text-gray-600 mt-1.5">
              This is one payment. If your hold expires, nothing is charged —
              including the extra donation.
            </p>
          </div>
        )}

        {/* What you are getting, by number. Shown before checkout so the
            assignment is never a surprise on the receipt. */}
        <div className="rounded-lg bg-gray-900 border border-gray-800 px-3 py-3 mb-4">
          <p className="text-sm">
            {count} {count === 1 ? u.one : u.many} —{" "}
            <span className="font-semibold">{money(squareTotal)}</span>
          </p>
          {donationCents > 0 && (
            <p className="text-sm mt-1">
              Donation —{" "}
              <span className="font-semibold">{money(donationCents)}</span>
            </p>
          )}
          {donationCents > 0 && (
            <p className="text-sm mt-1 border-t border-gray-800 pt-1">
              Total — <span className="font-semibold">{money(total)}</span>
            </p>
          )}
          {/* NUMBERS ONLY ON A PRIZE BOARD. On a prize board these are drawing
              ENTRY numbers: the contributor verifies them against the public
              audit before the draw, so they are the point. On a no-prize board
              they are raw grid positions the contributor never chose and can
              do nothing with, and a numbered list sitting under a quantity box
              reads as "here are the ones you picked" — the square-picking
              model this flow exists to hide.

              The post-purchase confirmation on fundraiser-view already gates
              its entry line the same way. This makes the sheet agree with it
              instead of promising numbers that then disappear. */}
          {hasPrize && selectedPositions.length > 0 && (
            <p className="text-xs text-gray-500 mt-1 tabular-nums">
              {/* Summarised past a dozen. Ninety-seven numbers is not
                  information, it is a wall — and reintroducing a purchase cap
                  to avoid rendering it would be solving a display problem with
                  a product rule. */}
              {selectedPositions.length === 1
                ? `${u.One} #${selectedPositions[0]}`
                : selectedPositions.length <= 12
                  ? `${u.Many} ` + selectedPositions.map((n) => `#${n}`).join(" · ")
                  : `${u.Many} #${selectedPositions[0]}–#${
                      selectedPositions[selectedPositions.length - 1]
                    }`}
            </p>
          )}
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

        {/* Admission — one square, one ticket. Addendum §1.
            Display says "ticket"; the model is still AdmissionPass. People say
            tickets for getting into an event and entries for a drawing, so the
            words follow them rather than the schema. */}
        {hasEvent && (
          <label className="flex items-start gap-2.5 cursor-pointer mb-4">
            <input
              type="checkbox"
              checked={donateAdmissions}
              onChange={(e) => setDonateAdmissions(e.target.checked)}
              className="mt-0.5 accent-green-500"
            />
            <span>
              {/* "Donate my tickets" read as giving them to another person, or
                  as donating money on top. Neither is what happens: the
                  contribution stands, no passes are minted, and the headcount
                  drops by one. Say that. */}
              <span className="block text-sm">I won&apos;t be attending</span>
              <span className="block text-xs text-gray-600 mt-0.5">
                {/* The pairing read as a contradiction because the LABEL is an
                    action ("I won't be attending") while this line described
                    current state ("1 ticket, one per square"). The specified
                    copy replaced only the checked branch, leaving the unchecked
                    one to look like a rebuttal of the label above it.
                    Both branches now describe the same thing — what admission
                    you end up with — so they read as one sentence either way. */}
                {donateAdmissions
                  ? "My contribution still supports the fundraiser, but I don't need admission tickets."
                  : `Includes ${count} admission ${count === 1 ? ADMISSION.one : ADMISSION.many}.`}
              </span>
            </span>
          </label>
        )}

        {/* How would you like to pay? — §6C.
            This picker is what replaces the PIN. A PIN exists so a host can
            hand a code to someone standing in front of her; on a fundraiser
            nobody is standing in front of her. Only methods that actually
            work are offered. */}
        {/* One method available: no choice to make, so state what will happen
            and continue. Previously the picker simply vanished and a cash-only
            board routed to a Zelle/CashApp flow with no label — worse than a
            picker, because the contributor learned the method after committing. */}
        {!(stripeConnected && cashModeEnabled) && (
          <div className="rounded-lg border border-gray-800 bg-gray-900 px-3 py-2.5 mb-4">
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

        {stripeConnected && cashModeEnabled && (
          <div className="mb-4">
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

        {method === "cash" && (
          <div className="rounded-lg border border-gray-800 bg-gray-900 p-3 mb-4">
            <p className="text-sm mb-2">Send {money(total)} to:</p>
            <ul className="space-y-1 text-sm">
              {handles.zelle && (
                <li>
                  <span className="text-gray-500">Zelle</span> {handles.zelle}
                </li>
              )}
              {handles.cashapp && (
                <li>
                  <span className="text-gray-500">Cash App</span>{" "}
                  {handles.cashapp}
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
              Your {u.many} are held until the host marks your payment received.
            </p>
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
