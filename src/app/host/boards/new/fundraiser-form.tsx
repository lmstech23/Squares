"use client";

import { useState } from "react";
import { ticketCountFor, MAX_TICKETS, TOO_MANY_TICKETS } from "@/lib/board-inventory";
import { useRouter } from "next/navigation";

// Fundraiser create form — fundraiser-board-v2.md §5.
//
// Not on this form: sport, teams, periods, payout split grid, host cut.
// If any of those render, the form is wrong (v2 §5).
//
// Prize fields do not render in Phase A. prizePoolPercent stays 0 and the
// server never accepts it — a host must not be able to switch on a drawing
// that has nothing behind it (v2 §16).


const inputClass =
  "w-full rounded-lg border border-gray-800 bg-gray-900 px-3 py-2.5 text-sm text-white placeholder:text-gray-600 outline-none focus:border-gray-600 transition-colors";
const labelClass = "block text-sm text-gray-400 mb-1.5";

interface Props {
  isCashHost: boolean;
  onBack: () => void;
}

export default function FundraiserForm({ isCashHost, onBack }: Props) {
  const router = useRouter();

  const [gameName, setGameName] = useState("");
  const [causeDescription, setCauseDescription] = useState("");
  const [price, setPrice] = useState("");
  const [goal, setGoal] = useState("");
  // Unchecked by default. Early bird is the exception, not the shape of the
  // form — asking every host to consider it costs more attention than it saves.
  const [earlyBirdOn, setEarlyBirdOn] = useState(false);
  const [earlyBirdPrice, setEarlyBirdPrice] = useState("");
  const [earlyBirdEndsAt, setEarlyBirdEndsAt] = useState("");
  const [campaignEndsAt, setCampaignEndsAt] = useState("");
  const [cashHoldDays, setCashHoldDays] = useState("7");

  // ENTRY TICKET TIERS. "" means the tier is NOT OFFERED - there is no separate
  // flag, exactly as with the early bird price. A host who ignores this block
  // creates a board the whole feature is invisible on.
  const [entryChild, setEntryChild] = useState("");
  const [entryAdultEarly, setEntryAdultEarly] = useState("");
  const [entryAdultRegular, setEntryAdultRegular] = useState("");

  const [hasEvent, setHasEvent] = useState(false);
  const [eventName, setEventName] = useState("");
  const [eventStartsAt, setEventStartsAt] = useState("");
  const [eventVenue, setEventVenue] = useState("");

  const [hostVenmo, setHostVenmo] = useState("");
  const [hostZelle, setHostZelle] = useState("");
  const [hostCashapp, setHostCashapp] = useState("");
  const [hostPaypal, setHostPaypal] = useState("");

  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const priceCents = Math.round(parseFloat(price || "0") * 100);
  const goalCents = goal ? Math.round(parseFloat(goal) * 100) : null;
  const earlyCents = earlyBirdPrice
    ? Math.round(parseFloat(earlyBirdPrice) * 100)
    : null;
  const toCents = (v: string) =>
    v.trim() === "" ? null : Math.round(parseFloat(v) * 100);
  const entryChildCents = toCents(entryChild);
  const entryEarlyCents = toCents(entryAdultEarly);
  const entryRegularCents = toCents(entryAdultRegular);
  // ONE CUTOFF, TWO PRODUCTS. The date is asked for once, by whichever turned
  // it on - the same instant flips square pricing and adult entry pricing.
  const needsCutoff = earlyBirdOn || entryEarlyCents != null;

  // DERIVED INVENTORY — always the REGULAR price. Early bird is a temporary
  // discount, not a resize: a $5,000 goal at $50 makes 100 tickets even if the
  // first twenty sell at $40.
  //
  // The preview states the count and nothing else.
  //
  // NO LOCK SEMANTICS ANYWHERE ON THIS FORM. When the ticket count locks, when
  // a price freezes, what "aspirational" means for a goal — none of it helps
  // someone filling in a field for the first time, and all of it was here. It
  // lives on the EDIT surface instead, which is where a host is in a position
  // to act on it.
  const ticketCount = ticketCountFor(goalCents, priceCents);
  // MVP safety cap. Shown as she types, and enforced again on the server —
  // this one is a courtesy, that one is the guarantee.
  const tooManyTickets = ticketCount != null && ticketCount > MAX_TICKETS;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    if (!gameName.trim()) {
      setError("Tell people what you're raising money for.");
      return;
    }
    if (!priceCents || priceCents < 100) {
      setError("Ticket price must be at least $1.");
      return;
    }
    if (!goalCents || goalCents < 100) {
      setError("A fundraising goal is required — it sets how many tickets the board has.");
      return;
    }
    if (tooManyTickets) {
      setError(TOO_MANY_TICKETS);
      return;
    }
    if (earlyBirdOn) {
      if (!earlyBirdPrice.trim()) {
        setError("Enter an early bird ticket price, or turn Early Bird off.");
        return;
      }
      if (!earlyBirdEndsAt) {
        setError("Choose the date early bird pricing ends, or turn Early Bird off.");
        return;
      }
      if (!earlyCents || earlyCents < 100) {
        setError("Early bird price must be at least $1.");
        return;
      }
      if (earlyCents >= priceCents) {
        setError("Early bird price must be below the standard price.");
        return;
      }
    }

    // ENTRY TICKET TIERS. Each independently optional; the same rules the
    // creation route re-checks, stated here so a host is told before a round
    // trip rather than instead of the server checking.
    for (const [cents, label] of [
      [entryChildCents, "Child entry ticket price"],
      [entryEarlyCents, "Adult early bird entry price"],
      [entryRegularCents, "Adult entry ticket price"],
    ] as const) {
      if (cents == null) continue;
      if (!Number.isFinite(cents) || cents < 100) {
        setError(`${label} must be at least $1, or left blank.`);
        return;
      }
    }
    // ADMISSION NEEDS SOMETHING TO ADMIT TO.
    if (
      !hasEvent &&
      [entryChildCents, entryEarlyCents, entryRegularCents].some((c) => c != null)
    ) {
      setError(
        "Entry ticket prices need an event. Add the event, or clear the entry prices."
      );
      return;
    }
    // ONLY THE ADULT EARLY PRICE HAS DEPENDENCIES - which is what lets a
    // child-only board exist. Mirrors boards_entry_pricing_coherent.
    if (entryEarlyCents != null) {
      if (entryRegularCents == null) {
        setError(
          "An adult early bird entry price needs an adult entry ticket price to be early against."
        );
        return;
      }
      if (entryEarlyCents >= entryRegularCents) {
        setError(
          "The adult early bird entry price must be below the adult entry ticket price."
        );
        return;
      }
    }
    // ONE CUTOFF, ASKED FOR ONCE, required by whichever product turned it on.
    if (needsCutoff && !earlyBirdEndsAt) {
      setError("Choose the date early bird pricing ends, or turn early bird pricing off.");
      return;
    }
    if (!campaignEndsAt) {
      setError("A campaign close date is required.");
      return;
    }
    if (![hostVenmo, hostZelle, hostCashapp, hostPaypal].some((h) => h.trim())) {
      setError(
        "Add at least one way to receive payment — Venmo, Zelle, Cash App, or PayPal."
      );
      return;
    }
    if (hasEvent && !eventStartsAt) {
      setError("An event date and time is required.");
      return;
    }

    setError(null);
    setLoading(true);

    try {
      const res = await fetch("/api/boards", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          boardType: "fundraiser",
          gameName: gameName.trim(),
          causeDescription: causeDescription.trim() || null,
          squarePrice: priceCents,
          fundraisingGoalCents: goalCents,
          campaignEndsAt,
          earlyBirdPriceCents: earlyCents,
          earlyBirdEndsAt: earlyBirdEndsAt || null,
          entryChildPriceCents: entryChildCents,
          entryAdultEarlyPriceCents: entryEarlyCents,
          entryAdultRegularPriceCents: entryRegularCents,
          cashHoldDays: parseInt(cashHoldDays, 10) || 7,
          hasEvent,
          eventName: eventName.trim() || null,
          eventStartsAt,
          eventVenue: eventVenue.trim() || null,
          hostVenmo: hostVenmo.trim() || null,
          hostZelle: hostZelle.trim() || null,
          hostCashapp: hostCashapp.trim() || null,
          hostPaypal: hostPaypal.trim() || null,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        if (res.status === 402 && data.redirectTo) {
          router.push(data.redirectTo);
          return;
        }
        setError(data.error || "Failed to create board.");
        setLoading(false);
        return;
      }
      router.push(`/host/boards/${data.boardId}`);
    } catch {
      setError("Network error. Please try again.");
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {error && (
        <div className="rounded-lg border border-red-900/50 bg-red-950/30 p-3">
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}

      <div className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg bg-gray-900 border border-gray-800 text-xs">
        <span>
          <span className="text-gray-500">Board type:</span>{" "}
          <span className="font-medium">Fundraiser</span>
        </span>
        <button
          type="button"
          onClick={onBack}
          className="text-gray-400 hover:text-white transition-colors"
        >
          Change
        </button>
      </div>

      {/* --- The cause --- */}
      <div>
        <label htmlFor="gameName" className={labelClass}>
          What are you raising money for?
        </label>
        <input
          id="gameName"
          value={gameName}
          onChange={(e) => setGameName(e.target.value)}
          placeholder="Hampton Homecoming Tailgate"
          className={inputClass}
        />
      </div>

      <div>
        <label htmlFor="causeDescription" className={labelClass}>
          Tell people what it&apos;s for{" "}
          <span className="text-gray-600">(optional)</span>
        </label>
        <textarea
          id="causeDescription"
          value={causeDescription}
          onChange={(e) => setCauseDescription(e.target.value)}
          rows={2}
          placeholder="Food, tents, and music for the class of 2016 tailgate."
          className={inputClass}
        />
      </div>

      {/* --- Price and goal. NO SQUARE COUNT: inventory is derived from these
           two (src/lib/board-inventory.ts). The host was previously asked to
           choose 25/50/75/100, a question about grid mechanics that has no
           relationship to what she needs to raise. --- */}
      <div>
        <label htmlFor="squarePrice" className={labelClass}>
          Ticket price
        </label>
        <input
          id="squarePrice"
          type="number"
          min="1"
          step="1"
          inputMode="decimal"
          value={price}
          onChange={(e) => setPrice(e.target.value)}
          placeholder="30"
          className={inputClass}
        />
      </div>

      <div>
        <label htmlFor="goal" className={labelClass}>
          Fundraising goal
        </label>
        <input
          id="goal"
          type="number"
          min="1"
          step="1"
          inputMode="decimal"
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          placeholder="2000"
          className={inputClass}
        />
        <p className="text-xs text-gray-600 mt-1.5">
          Sets the ticket count and progress goal.
        </p>
      </div>

      {/* --- Early bird — money doc §8B. Opt-in, off by default. --- */}
      <div className="rounded-lg border border-gray-800 p-4 space-y-4">
        <label className="flex items-start gap-2.5 cursor-pointer">
          <input
            type="checkbox"
            checked={earlyBirdOn}
            onChange={(e) => {
              setEarlyBirdOn(e.target.checked);
              // Clearing on uncheck is what makes the checkbox the single
              // source of truth: a stale price left in a hidden field would
              // still be submitted.
              if (!e.target.checked) {
                setEarlyBirdPrice("");
                setEarlyBirdEndsAt("");
              }
            }}
            className="mt-0.5 accent-green-500"
          />
          <span>
            <span className="block text-sm">Offer Early Bird pricing</span>
            <span className="block text-xs text-gray-600 mt-0.5">
              A lower price until a date you choose.
            </span>
          </span>
        </label>

        {earlyBirdOn && (
        <div>
          <label htmlFor="earlyBirdPrice" className={labelClass}>
            Early bird ticket price
          </label>
          <input
            id="earlyBirdPrice"
            type="number"
            min="1"
            step="1"
            inputMode="decimal"
            value={earlyBirdPrice}
            onChange={(e) => setEarlyBirdPrice(e.target.value)}
            placeholder="25"
            className={inputClass}
          />
          <p className="text-xs text-gray-600 mt-1.5">
            Must be lower than the ticket price.
          </p>
        </div>
        )}

        {/* THE CUTOFF DATE, SHARED. Outside the early-bird square block because
            it is no longer that block's field: the same instant flips square
            pricing and adult entry pricing, so it is shown whenever either is
            set. A board with early entry pricing and no date is one the
            database refuses. */}
        {needsCutoff && (
          <div>
            <label htmlFor="earlyBirdEndsAt" className={labelClass}>
              Early bird ends
            </label>
            <input
              id="earlyBirdEndsAt"
              type="date"
              value={earlyBirdEndsAt}
              onChange={(e) => setEarlyBirdEndsAt(e.target.value)}
              className={inputClass}
            />
            <p className="text-xs text-gray-600 mt-1.5">
              The early price applies through 11:59 PM Eastern on this date.
              {earlyBirdOn && entryEarlyCents != null
                ? " It sets both the ticket and the adult entry early price."
                : ""}
            </p>
          </div>
        )}
      </div>

      {/* --- Dates. Independent of one another; no validation relates them. --- */}
      <div>
        <label htmlFor="campaignEndsAt" className={labelClass}>
          Campaign closes
        </label>
        <input
          id="campaignEndsAt"
          type="date"
          value={campaignEndsAt}
          onChange={(e) => setCampaignEndsAt(e.target.value)}
          className={inputClass}
        />
        <p className="text-xs text-gray-600 mt-1.5">
          Closes at 11:59 PM Eastern on this date. Direct payments must be
          marked received before then.
        </p>
      </div>

      {isCashHost && (
        <div>
          <label htmlFor="cashHoldDays" className={labelClass}>
            Cash hold window
          </label>
          <input
            id="cashHoldDays"
            type="number"
            min="1"
            max="60"
            value={cashHoldDays}
            onChange={(e) => setCashHoldDays(e.target.value)}
            className={inputClass}
          />
          <p className="text-xs text-gray-600 mt-1.5">
            How long a direct-payment reservation is held.
          </p>
        </div>
      )}

      {/* --- Optional event block — v2 §5 --- */}
      <div className="rounded-lg border border-gray-800 p-4">
        <label className="flex items-start gap-2.5 cursor-pointer">
          <input
            type="checkbox"
            checked={hasEvent}
            onChange={(e) => setHasEvent(e.target.checked)}
            className="mt-0.5 accent-green-500"
          />
          <span>
            <span className="block text-sm">
              This fundraiser includes event admission
            </span>
            <span className="block text-xs text-gray-600 mt-0.5">
              Each confirmed ticket includes one admission pass to the event.
              Contributors who aren&apos;t attending can donate their passes at
              checkout.
            </span>
          </span>
        </label>

        {hasEvent && (
          <div className="space-y-4 mt-4 pt-4 border-t border-gray-800">
            <div>
              <label htmlFor="eventName" className={labelClass}>
                Event name{" "}
                <span className="text-gray-600">
                  (defaults to the campaign title)
                </span>
              </label>
              <input
                id="eventName"
                value={eventName}
                onChange={(e) => setEventName(e.target.value)}
                placeholder={gameName || "Homecoming Tailgate"}
                className={inputClass}
              />
            </div>

            <div>
              <label htmlFor="eventStartsAt" className={labelClass}>
                Date and time <span className="text-gray-600">(Eastern)</span>
              </label>
              <input
                id="eventStartsAt"
                type="datetime-local"
                value={eventStartsAt}
                onChange={(e) => setEventStartsAt(e.target.value)}
                className={inputClass}
              />
            </div>

            <div>
              <label htmlFor="eventVenue" className={labelClass}>
                Venue <span className="text-gray-600">(optional)</span>
              </label>
              <input
                id="eventVenue"
                value={eventVenue}
                onChange={(e) => setEventVenue(e.target.value)}
                placeholder="Armstrong Stadium, Lot C"
                className={inputClass}
              />
            </div>

            {/* --- Entry tickets ---------------------------------------------
                OPTIONAL, TIER BY TIER, and inside the event block because
                admission with nothing to be admitted to is not a thing to
                configure. Leaving all three blank is the ordinary case: the
                board sells no entry and contributors are shown nothing about
                it.

                HERE AT CREATION, not only on the edit panel. A host pricing a
                ticketed fundraiser should not have to create the board and
                then reopen it, and a two-step path can fail in step two for a
                reason set in step one - the shared cutoff date. ---------- */}
            <div className="rounded-lg border border-gray-800 p-3 space-y-4">
              <div>
                <span className="block text-sm">Entry tickets</span>
                <span className="block text-xs text-gray-600 mt-0.5">
                  Admission sold on its own, without claiming a spot on the
                  board. Leave a price blank and that ticket type is not
                  offered.
                </span>
              </div>

              <div>
                <label htmlFor="entryChild" className={labelClass}>
                  Child ticket price{" "}
                  <span className="text-gray-600">(optional)</span>
                </label>
                <input
                  id="entryChild"
                  type="number"
                  min="1"
                  step="1"
                  inputMode="decimal"
                  value={entryChild}
                  onChange={(e) => setEntryChild(e.target.value)}
                  placeholder="15"
                  className={inputClass}
                />
                <p className="text-xs text-gray-600 mt-1.5">
                  One price all the way through. Child tickets have no early
                  bird.
                </p>
              </div>

              <div>
                <label htmlFor="entryAdultRegular" className={labelClass}>
                  Adult ticket price{" "}
                  <span className="text-gray-600">(optional)</span>
                </label>
                <input
                  id="entryAdultRegular"
                  type="number"
                  min="1"
                  step="1"
                  inputMode="decimal"
                  value={entryAdultRegular}
                  onChange={(e) => setEntryAdultRegular(e.target.value)}
                  placeholder="50"
                  className={inputClass}
                />
              </div>

              <div>
                <label htmlFor="entryAdultEarly" className={labelClass}>
                  Adult early bird price{" "}
                  <span className="text-gray-600">(optional)</span>
                </label>
                <input
                  id="entryAdultEarly"
                  type="number"
                  min="1"
                  step="1"
                  inputMode="decimal"
                  value={entryAdultEarly}
                  onChange={(e) => setEntryAdultEarly(e.target.value)}
                  placeholder="40"
                  className={inputClass}
                />
                <p className="text-xs text-gray-600 mt-1.5">
                  Must be below the adult ticket price, and uses the same early
                  bird end date as tickets. Setting it adds that date field
                  above.
                </p>
              </div>
            </div>

          </div>
        )}
      </div>

      {/* --- How contributors pay you --- */}
      <div className="rounded-lg border border-gray-800 p-4 space-y-4">
        <div>
          <span className="block text-sm">How contributors pay you</span>
          <span className="block text-xs text-gray-600 mt-0.5">
            At least one is required. Shown to anyone paying by Zelle, Cash
            App, Venmo, or PayPal — without one there is nowhere to send money.
          </span>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="hostVenmo" className={labelClass}>
              Venmo
            </label>
            <input
              id="hostVenmo"
              value={hostVenmo}
              onChange={(e) => setHostVenmo(e.target.value)}
              placeholder="@handle"
              className={inputClass}
            />
          </div>
          <div>
            <label htmlFor="hostCashapp" className={labelClass}>
              Cash App
            </label>
            <input
              id="hostCashapp"
              value={hostCashapp}
              onChange={(e) => setHostCashapp(e.target.value)}
              placeholder="$handle"
              className={inputClass}
            />
          </div>
          <div>
            <label htmlFor="hostZelle" className={labelClass}>
              Zelle
            </label>
            <input
              id="hostZelle"
              value={hostZelle}
              onChange={(e) => setHostZelle(e.target.value)}
              placeholder="email or phone"
              className={inputClass}
            />
          </div>
          <div>
            <label htmlFor="hostPaypal" className={labelClass}>
              PayPal
            </label>
            <input
              id="hostPaypal"
              value={hostPaypal}
              onChange={(e) => setHostPaypal(e.target.value)}
              placeholder="paypal.me/handle"
              className={inputClass}
            />
          </div>
        </div>
      </div>

      {/* --- What the inputs produce. Shown BEFORE submitting, because the
           ticket count is now a consequence of her numbers rather than
           something she chose, and discovering it after creation is the
           failure this replaces. --- */}
      {tooManyTickets && (
        <div className="rounded-lg border border-red-900/60 bg-red-950/20 p-4">
          <p className="text-sm text-red-300">{TOO_MANY_TICKETS}</p>
        </div>
      )}

      {ticketCount != null && !tooManyTickets && (
        <div className="rounded-lg border border-gray-800 bg-gray-900/50 p-4">
          <p className="text-sm">
            <span className="font-semibold">{ticketCount}</span>{" "}
            {ticketCount === 1 ? "ticket" : "tickets"} will be created
          </p>
        </div>
      )}

      <button
        type="submit"
        disabled={loading}
        className="w-full rounded-lg bg-white px-4 py-3 text-sm font-medium text-gray-950 hover:bg-gray-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        {loading ? "Creating…" : "Create fundraiser"}
      </button>
    </form>
  );
}
