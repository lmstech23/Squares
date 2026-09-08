"use client";

// Fundraiser edit surface — event details and the fundraising goal.
//
// Separate from EditDetailsButton on purpose. That dialog edits gameName,
// "Team across top" and "Team down side"; the last two are Game Day axis labels
// and mean nothing on a fundraiser board. Game Day's dialog is untouched.
//
// LOCKED FIELDS ARE SHOWN, NOT HIDDEN. A host who finds a control missing
// assumes she is looking in the wrong place; one who finds it disabled with no
// explanation assumes a bug and contacts support. Each locked field stays
// visible, keeps its current value, and carries the reason inline.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { methodStatuses } from "@/lib/accepted-payments";
import { validateTicketCount, TOO_MANY_TICKETS } from "@/lib/board-inventory";

interface Props {
  boardId: string;
  hasEvent: boolean;
  /** True once a square has reached `paid`. Computed server-side. */
  locked: boolean;
  lockReason: string;
  initialName: string;
  initialVenue: string;
  /** `YYYY-MM-DDTHH:mm` already rendered in the event's own timezone. */
  initialStartsAt: string;
  initialEndsAt: string;
  initialTimezone: string;
  /** The campaign title. Board.gameName - NOT the event name. */
  initialTitle: string;
  /** "" means none set. */
  initialCause: string;
  /** Dollars, as typed. Empty string means no goal. */
  initialGoal: string;
  /** Dollars, as typed. */
  initialPrice: string;
  /** Dollars, as typed. Empty string means no early bird. */
  initialEarlyBirdPrice: string;
  /** `YYYY-MM-DD`, already rendered in the board's zone. */
  initialEarlyBirdEndsAt: string;
  currentTicketCount: number;
  /** The four direct-payment handles, as stored. "" means not set. */
  /** What the board accepts today. Editable here; nothing else writes it. */
  initialAcceptedMethods: string[];
  /**
   * Whether card COULD be accepted: a live Stripe account on this host.
   *
   * Eligibility, not intent. Stripe being connected is what makes card
   * possible; ticking it here is what makes it offered. Conflating the two is
   * how a direct-payment fundraiser came to serve a live Stripe checkout.
   */
  cardEligible: boolean;
  initialVenmo: string;
  initialZelle: string;
  initialCashapp: string;
  initialPaypal: string;
  // THE THREE PRICE LOCKS, computed by lib/board-lock.ts on the server. Passed
  // in rather than re-derived here: the form must disable exactly what the
  // route refuses, and two implementations of invariant 76 is one too many.
  inventoryLocked: boolean;
  regularLocked: boolean;
  earlyBirdLocked: boolean;
  inventoryLockReason: string;
  regularLockReason: string;
  earlyBirdLockReason: string;
  /**
   * THE CUTOFF DATE'S OWN LOCK, which is no longer `earlyBirdLocked`.
   *
   * One date drives two products - early-bird squares and early-priced Adult
   * Entry Tickets - so it freezes when EITHER has sold under it. Disabling it
   * on the square lock alone would let a host move a deadline that entry
   * buyers had already paid against.
   */
  /**
   * This board sells squares. When false there is no inventory to preview and
   * the route refuses to resize, so the panel must not promise a resize it
   * will not get. Mirrors the route's condition rather than inferring one.
   */
  raffleEnabled: boolean;
  cutoffLocked: boolean;
  cutoffLockReason: string;
  /** Dollars, as typed. "" means the tier is NOT OFFERED. */
  initialEntryChild: string;
  initialEntryAdultEarly: string;
  initialEntryAdultRegular: string;
  /// One lock per tier price, on the same principle as invariant 76: a price
  /// freezes when somebody has bought at it, and at nothing else.
  childLocked: boolean;
  adultEarlyLocked: boolean;
  adultRegularLocked: boolean;
  childLockReason: string;
  adultEarlyLockReason: string;
  adultRegularLockReason: string;
}

const ZONES = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Phoenix",
  "America/Los_Angeles",
  "America/Anchorage",
  "Pacific/Honolulu",
];

const labelClass = "block text-xs font-medium text-gray-400 mb-1";
const inputClass =
  "w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-white placeholder-gray-600 focus:border-gray-500 focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed";

/** Dollars as typed -> integer cents, or null when unusable. */
function toCents(v: string): number | null {
  const n = parseFloat(v);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

export default function EditFundraiserButton({
  boardId, hasEvent, locked, lockReason,
  initialName, initialVenue, initialStartsAt, initialEndsAt, initialTimezone, initialGoal,
  initialTitle, initialCause,
  initialPrice, initialEarlyBirdPrice, initialEarlyBirdEndsAt, currentTicketCount,
  initialAcceptedMethods, cardEligible,
  initialVenmo, initialZelle, initialCashapp, initialPaypal,
  inventoryLocked, regularLocked, earlyBirdLocked,
  inventoryLockReason, regularLockReason, earlyBirdLockReason,
  raffleEnabled,
  cutoffLocked, cutoffLockReason,
  initialEntryChild, initialEntryAdultEarly, initialEntryAdultRegular,
  childLocked, adultEarlyLocked, adultRegularLocked,
  childLockReason, adultEarlyLockReason, adultRegularLockReason,
}: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(initialName);
  const [venue, setVenue] = useState(initialVenue);
  const [startsAt, setStartsAt] = useState(initialStartsAt);
  const [endsAt, setEndsAt] = useState(initialEndsAt);
  const [timezone, setTimezone] = useState(initialTimezone);
  // THE CAMPAIGN TITLE, and it goes to a DIFFERENT ROUTE than everything else
  // on this panel - see save(). Board.gameName, never Event.name.
  const [title, setTitle] = useState(initialTitle);
  const [cause, setCause] = useState(initialCause);
  const [goal, setGoal] = useState(initialGoal);
  const [price, setPrice] = useState(initialPrice);
  // Reflects whether the board HAS an early bird price, not a stored flag -
  // there is no such column. Clearing the price is how a host turns it off.
  const [earlyBirdOn, setEarlyBirdOn] = useState(initialEarlyBirdPrice !== "");
  const [earlyPrice, setEarlyPrice] = useState(initialEarlyBirdPrice);
  const [earlyEndsAt, setEarlyEndsAt] = useState(initialEarlyBirdEndsAt);
  // ENTRY TICKET TIERS. "" means not offered, which is how a host turns a tier
  // off — there is no separate flag, exactly as with the early bird price.
  const [entryChild, setEntryChild] = useState(initialEntryChild);
  const [entryAdultEarly, setEntryAdultEarly] = useState(initialEntryAdultEarly);
  const [entryAdultRegular, setEntryAdultRegular] = useState(initialEntryAdultRegular);
  const [methods, setMethods] = useState<string[]>(initialAcceptedMethods);
  const [venmo, setVenmo] = useState(initialVenmo);
  const [zelle, setZelle] = useState(initialZelle);
  const [cashapp, setCashapp] = useState(initialCashapp);
  const [paypal, setPaypal] = useState(initialPaypal);

  // THE SAME PREDICATES THE CONTRIBUTOR PAGE USES, against the form's CURRENT
  // values rather than the saved ones. Paste a Venmo username and the Venmo row
  // stops saying it needs one, before saving - the host sees the effect of the
  // edit they are making, which is the whole reason this is derived here rather
  // than rendered from props.
  const statuses = methodStatuses(
    {
      acceptedPaymentMethods: methods,
      hostZelle: zelle.trim() || null,
      hostCashapp: cashapp.trim() || null,
      hostVenmo: venmo.trim() || null,
      hostPaypal: paypal.trim() || null,
    },
    cardEligible
  );
  const anyOfferable = statuses.some((m) => m.offerable);
  const handleFor: Record<string, { value: string; set: (v: string) => void; placeholder: string }> = {
    zelle: { value: zelle, set: setZelle, placeholder: "Phone or email" },
    cashapp: { value: cashapp, set: setCashapp, placeholder: "$cashtag" },
    venmo: { value: venmo, set: setVenmo, placeholder: "@username" },
    paypal: { value: paypal, set: setPaypal, placeholder: "paypal.me/you or email" },
  };
  const toggle = (m: string) =>
    setMethods((cur) => (cur.includes(m) ? cur.filter((x) => x !== m) : [...cur, m]));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Adding an event to a board that never had one. The creation-time checkbox
  // used to be a one-way door: without an event there can be no SignupSheet,
  // so no volunteer sign-ups, ever. Same fields, same surface — the host opts
  // in here and the form below is the one she already knows.
  const [addingEvent, setAddingEvent] = useState(false);
  const showEventFields = hasEvent || addingEvent;

  // v2 §11: after the first confirmed contribution every title change is
  // appended to titleHistory by /details. `inventoryLocked` is exactly the
  // predicate "a confirmed square exists" - reused rather than adding a second
  // prop that could disagree with it.
  const titleRecorded = inventoryLocked;

  // The regular price actually in force after this save. When the field is
  // locked it is disabled and still holds the stored value, but reading the
  // prop is what makes the early-bird comparison correct rather than
  // incidentally correct.
  const priceCents = regularLocked ? toCents(initialPrice) : toCents(price);
  const earlyCents = earlyBirdOn ? toCents(earlyPrice) : null;
  const goalCents = goal.trim() === "" ? null : toCents(goal);

  // INVENTORY PREVIEW — MIRRORS THE ROUTE'S RESIZE CONDITION EXACTLY.
  //
  // Only meaningful while the count can still move, and only when the goal or
  // the price ACTUALLY MOVED. The route resizes on nothing else, so previewing
  // on nothing else is what keeps this line honest: a board whose stored count
  // already disagrees with ceil(goal / price) would otherwise be promised a
  // resize on a save that changes neither number and triggers nothing.
  //
  // Compared in cents against the stored values, same as the server. "50" and
  // "50.00" are the same price.
  const initialGoalCents = initialGoal.trim() === "" ? null : toCents(initialGoal);
  const goalChanged = goalCents !== initialGoalCents;
  const priceChanged = !regularLocked && priceCents !== toCents(initialPrice);
  const preview =
    raffleEnabled && !inventoryLocked && (goalChanged || priceChanged)
      ? validateTicketCount(goalCents, priceCents)
      : null;
  const nextCount = preview && preview.ok ? preview.count : null;
  const willResize = nextCount != null && nextCount !== currentTicketCount;

  // Derived once, used by validation, the save body and the render.
  const entryChildCents = entryChild.trim() === "" ? null : toCents(entryChild);
  const entryEarlyCents = entryAdultEarly.trim() === "" ? null : toCents(entryAdultEarly);
  const entryRegularCents =
    entryAdultRegular.trim() === "" ? null : toCents(entryAdultRegular);
  // The cutoff date is now needed by EITHER product, so the field is shown and
  // required whenever either is on.
  const needsCutoff = earlyBirdOn || entryEarlyCents != null;

  async function save() {
    // Same rules as the creation form, and the same rules the route enforces.
    // Checked here so the host is told before a round trip, NOT instead of the
    // server checking - the route re-validates every one of these.
    if (!regularLocked && (!priceCents || priceCents < 100)) {
      setError("Ticket price must be at least $1.");
      return;
    }
    if (!earlyBirdLocked && earlyBirdOn) {
      if (!earlyCents || earlyCents < 100) {
        setError("Early bird price must be at least $1.");
        return;
      }
      if (priceCents != null && earlyCents >= priceCents) {
        setError("Early bird price must be below the ticket price.");
        return;
      }
    }
    // ENTRY TIERS. Each is independently optional; only the ADULT EARLY price
    // has dependencies, which is what lets a child-only board exist.
    for (const [cents, label, locked] of [
      [entryChildCents, "Child entry ticket price", childLocked],
      [entryEarlyCents, "Adult early bird entry price", adultEarlyLocked],
      [entryRegularCents, "Adult entry ticket price", adultRegularLocked],
    ] as const) {
      if (locked || cents == null) continue;
      if (cents < 100) {
        setError(`${label} must be at least $1, or left blank.`);
        return;
      }
    }
    if (entryEarlyCents != null) {
      if (entryRegularCents == null) {
        setError(
          "An adult early bird entry price needs an adult entry ticket price to be early against."
        );
        return;
      }
      if (entryEarlyCents >= entryRegularCents) {
        setError("The adult early bird entry price must be below the adult entry ticket price.");
        return;
      }
    }
    // ONE DATE, EITHER PRODUCT. Asked for once, whichever turned it on.
    if (needsCutoff && !cutoffLocked && !earlyEndsAt) {
      setError("Choose the date early bird pricing ends, or turn early bird pricing off.");
      return;
    }
    if (title.trim().length === 0) {
      setError("A campaign title is required.");
      return;
    }
    // Mirrors the route. At least one handle must survive - clearing Venmo
    // while Zelle remains is fine; clearing the last one leaves contributors a
    // board with nowhere to send money.
    // THE SAVE RULE, mirrored from the route so the host learns it here rather
    // than from a 400. Selected is not offerable: a board with only Venmo
    // ticked and no Venmo handle looks configured and can collect nothing.
    if (!anyOfferable) {
      setError(
        "Choose at least one payment method contributors can actually use. " +
          "A method needs its details filled in, and card needs Stripe connected."
      );
      return;
    }
    if (![venmo, zelle, cashapp, paypal].some((h) => h.trim())) {
      setError(
        "Add at least one way to receive payment — Venmo, Zelle, Cash App, or PayPal."
      );
      return;
    }
    if (preview && !preview.ok && goalCents != null) {
      setError(preview.error === TOO_MANY_TICKETS ? TOO_MANY_TICKETS : preview.error);
      return;
    }

    setSaving(true);
    setError(null);
    try {
      // Only send what may actually change. Omitting locked fields entirely
      // means a stale tab cannot trip the server's 409 by echoing back values
      // it merely displayed.
      const body: Record<string, unknown> = {
        fundraisingGoalCents: goalCents,
        causeDescription: cause.trim() || null,
      };
      // THE TITLE IS NOT IN THIS BODY, AND MUST NEVER BE.
      //
      // `name` on /fundraiser-details is the EVENT name. Putting the campaign
      // title there would rename the event AND skip the titleHistory append
      // that v2 §11 requires — two failures from one plausible-looking
      // line. /details is the title's only owner; it is sent below.
      // A LOCKED PRICE FIELD IS NOT SENT AT ALL. It is disabled and merely
      // displaying its stored value; echoing that value back would be a write
      // the route answers with 409 even though nothing changed.
      // ALL FOUR, ALWAYS. Nothing locks them at any point in the board's life,
      // so there is no locked value to avoid echoing back, and sending the full
      // set is what lets a host clear one.
      // ALWAYS SENT, beside the handles and written in the same transaction as
      // them. A host pasting a Venmo username and ticking Venmo in one save
      // must never end up with one and not the other.
      body.acceptedPaymentMethods = methods;
      body.hostVenmo = venmo.trim() || null;
      body.hostZelle = zelle.trim() || null;
      body.hostCashapp = cashapp.trim() || null;
      body.hostPaypal = paypal.trim() || null;
      if (!regularLocked) body.squarePrice = priceCents;
      if (!earlyBirdLocked) {
        body.earlyBirdPriceCents = earlyBirdOn ? earlyCents : null;
      }
      // THE CUTOFF IS SENT SEPARATELY, under its own lock, and is cleared only
      // when NEITHER product needs it. Clearing it because the square early
      // bird was switched off would break the entry pricing CHECK and reject
      // the whole save.
      //
      // Sent as `YYYY-MM-DD`; the route resolves it to 11:59:59 PM in the
      // board's zone, the same rule creation and campaign close use.
      if (!cutoffLocked) {
        body.earlyBirdEndsAt = needsCutoff ? earlyEndsAt : null;
      }
      // A LOCKED TIER IS NOT SENT AT ALL, for the reason a locked square price
      // is not: the field is disabled and merely displaying a stored value.
      if (!childLocked) body.entryChildPriceCents = entryChildCents;
      if (!adultEarlyLocked) body.entryAdultEarlyPriceCents = entryEarlyCents;
      if (!adultRegularLocked) body.entryAdultRegularPriceCents = entryRegularCents;
      if (showEventFields) {
        body.name = name;
        body.venue = venue;
        // When ADDING, the date and zone are the whole point and there is
        // nothing locked to protect — the board has no event date yet.
        if (!locked || !hasEvent) {
          body.startsAt = startsAt;
          body.endsAt = endsAt || null;
          body.timezone = timezone;
        }
      }
      const res = await fetch(`/api/host/boards/${boardId}/fundraiser-details`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Could not save.");
        return;
      }

      // THE TITLE, SECOND AND SEPARATELY, and only when it actually changed.
      //
      // ORDER IS DELIBERATE. Everything else goes first, so a failure there
      // writes nothing at all. If the title then fails, the host is told
      // exactly what did and did not save and can retry the cheapest field.
      // The other order would append a titleHistory entry recording a save the
      // host believes failed.
      if (title.trim() !== initialTitle) {
        const titleRes = await fetch(`/api/host/boards/${boardId}/details`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ gameName: title.trim() }),
        });
        const titleData = await titleRes.json();
        if (!titleRes.ok) {
          router.refresh();
          setError(
            "Saved, except the title: " + (titleData.error ?? "could not save it.")
          );
          return;
        }
      }

      setOpen(false);
      router.refresh();
    } catch {
      setError("Could not save. Check your connection and try again.");
    } finally {
      setSaving(false);
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="rounded-lg border border-gray-700 px-3 py-1.5 text-xs text-gray-300 hover:text-white hover:border-gray-600 transition-colors"
      >
        Edit details
      </button>
    );
  }

  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900 p-4 space-y-4">
      <h3 className="text-sm font-semibold text-white">Campaign details</h3>

      {/* --- Campaign ---------------------------------------------------------
          THE TITLE LIVES HERE NOW. It used to be behind a second, low-emphasis
          "Edit details" link sitting beside this button - two controls with
          overlapping names editing disjoint fields, which read as duplicates
          and left the host guessing which one held what.

          It still SAVES to /details, not to this panel's route. See save().
          ------------------------------------------------------------------- */}
      <div>
        <label htmlFor="title" className={labelClass}>Campaign title</label>
        <input
          id="title" className={inputClass} value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        {titleRecorded && (
          <p className="text-xs text-gray-600 mt-1">
            Changes are recorded now that this campaign has contributions.
          </p>
        )}
      </div>

      <div>
        <label htmlFor="cause" className={labelClass}>
          What are you raising money for?
        </label>
        <textarea
          id="cause" rows={3} className={inputClass} value={cause}
          placeholder="Supporters read this first."
          onChange={(e) => setCause(e.target.value)}
        />
      </div>

      <div>
        <label htmlFor="goal" className={labelClass}>
          Fundraising goal (optional)
        </label>
        <input
          id="goal" type="number" min="0" step="1" inputMode="decimal"
          className={inputClass} value={goal} placeholder="No goal set"
          onChange={(e) => setGoal(e.target.value)}
        />
        <p className="text-xs text-gray-600 mt-1">
          Editable at any time — a goal is aspirational, not a term of the deal.
          Leave blank to hide the progress bar.
        </p>
        {/* The lock lives HERE, not on the creation form: this is where a host
            is in a position to act on it. The line above is about the GOAL
            staying editable; this one is about the ticket count no longer
            following it. They are different facts and both are true. */}
        {inventoryLocked ? (
          <p className="text-xs text-gray-600 mt-1">
            {currentTicketCount} tickets. {inventoryLockReason}
          </p>
        ) : (
          <p className="text-xs text-gray-600 mt-1">
            Ticket count locks after the first confirmed contribution.
          </p>
        )}
      </div>

      {/* --- Tickets and pricing ---------------------------------------------
          Invariant 76: the early bird fields and the regular price lock
          INDEPENDENTLY, at the first confirmed square bought under each. A
          board running early bird can still have its regular price corrected,
          because nobody has paid it yet.

          A LOCKED FIELD STAYS ON SCREEN, disabled, holding its real value,
          with the reason beside it - same rule as the event fields above. The
          host learns she cannot change it by looking, not by saving. -------- */}
      <div className="space-y-4 rounded-lg border border-gray-800 p-3">
        <p className="text-xs font-semibold text-gray-300">Tickets and pricing</p>

        <div>
          <label htmlFor="price" className={labelClass}>Ticket price</label>
          <input
            id="price" type="number" min="1" step="1" inputMode="decimal"
            className={inputClass} value={price} disabled={regularLocked}
            onChange={(e) => setPrice(e.target.value)}
          />
          {regularLocked ? (
            <p className="text-xs text-amber-200/80 mt-1">{regularLockReason}</p>
          ) : (
            <p className="text-xs text-gray-600 mt-1">
              {willResize
                ? "Saving changes this board from " + currentTicketCount +
                  " tickets to " + nextCount + "."
                : currentTicketCount + " tickets."}
            </p>
          )}
        </div>

        <label className="flex items-start gap-2">
          <input
            type="checkbox" checked={earlyBirdOn} disabled={earlyBirdLocked}
            className="mt-0.5 accent-green-500 disabled:opacity-50"
            onChange={(e) => {
              setEarlyBirdOn(e.target.checked);
              if (!e.target.checked) {
                setEarlyPrice("");
                setEarlyEndsAt("");
              }
            }}
          />
          <span className="text-sm">Offer Early Bird pricing</span>
        </label>

        {earlyBirdLocked && (
          <p className="text-xs text-amber-200/80">{earlyBirdLockReason}</p>
        )}

        {earlyBirdOn && (
          <>
            <div>
              <label htmlFor="earlyPrice" className={labelClass}>
                Early bird ticket price
              </label>
              <input
                id="earlyPrice" type="number" min="1" step="1" inputMode="decimal"
                className={inputClass} value={earlyPrice} disabled={earlyBirdLocked}
                onChange={(e) => setEarlyPrice(e.target.value)}
              />
              {!earlyBirdLocked && (
                <p className="text-xs text-gray-600 mt-1">
                  Must be lower than the ticket price.
                </p>
              )}
            </div>

          </>
        )}

        {/* THE CUTOFF DATE, SHARED. It sits outside the early-bird square block
            because it is no longer that block's field: the same instant flips
            square pricing and Adult Entry Ticket pricing, so it is shown
            whenever either is on and locked when either has sold under it. */}
        {needsCutoff && (
          <div>
            <label htmlFor="earlyEndsAt" className={labelClass}>Early bird ends</label>
            <input
              id="earlyEndsAt" type="date"
              className={inputClass} value={earlyEndsAt} disabled={cutoffLocked}
              onChange={(e) => setEarlyEndsAt(e.target.value)}
            />
            {cutoffLocked ? (
              <p className="text-xs text-amber-200/80 mt-1">{cutoffLockReason}</p>
            ) : (
              <p className="text-xs text-gray-600 mt-1">
                The early price applies through 11:59 PM Eastern on this date.
                {entryEarlyCents != null && earlyBirdOn
                  ? " It sets both the ticket and the adult entry early price."
                  : ""}
              </p>
            )}
          </div>
        )}
      </div>

      {/* --- Event entry tickets ----------------------------------------------
          OPTIONAL, TIER BY TIER. A blank field means the tier is not offered,
          and a board that leaves all three blank sells no entry at all and
          shows contributors nothing about it. That optionality is the point:
          this is a platform capability, not one event's requirements.

          Only shown on a board that HAS an event. Admission with nothing to be
          admitted to is not a thing to configure. -------------------------- */}
      {showEventFields && (
      <div className="space-y-4 rounded-lg border border-gray-800 p-3">
        <p className="text-xs font-semibold text-gray-300">Event entry tickets</p>
        <p className="text-xs text-gray-600 leading-relaxed">
          Admission sold on its own, without claiming a spot on the board. Leave
          a price blank and that ticket type is not offered.
        </p>

        <div>
          <label htmlFor="entryChild" className={labelClass}>Child ticket price</label>
          <input
            id="entryChild" type="number" min="1" step="1" inputMode="decimal"
            className={inputClass} value={entryChild} disabled={childLocked}
            onChange={(e) => setEntryChild(e.target.value)}
          />
          {childLocked ? (
            <p className="text-xs text-amber-200/80 mt-1">{childLockReason}</p>
          ) : (
            <p className="text-xs text-gray-600 mt-1">
              One price, all the way through. Child tickets have no early bird.
            </p>
          )}
        </div>

        <div>
          <label htmlFor="entryAdultRegular" className={labelClass}>
            Adult ticket price
          </label>
          <input
            id="entryAdultRegular" type="number" min="1" step="1" inputMode="decimal"
            className={inputClass} value={entryAdultRegular} disabled={adultRegularLocked}
            onChange={(e) => setEntryAdultRegular(e.target.value)}
          />
          {adultRegularLocked && (
            <p className="text-xs text-amber-200/80 mt-1">{adultRegularLockReason}</p>
          )}
        </div>

        <div>
          <label htmlFor="entryAdultEarly" className={labelClass}>
            Adult early bird price
          </label>
          <input
            id="entryAdultEarly" type="number" min="1" step="1" inputMode="decimal"
            className={inputClass} value={entryAdultEarly} disabled={adultEarlyLocked}
            onChange={(e) => setEntryAdultEarly(e.target.value)}
          />
          {adultEarlyLocked ? (
            <p className="text-xs text-amber-200/80 mt-1">{adultEarlyLockReason}</p>
          ) : (
            <p className="text-xs text-gray-600 mt-1">
              Optional. Must be below the adult ticket price, and uses the same
              early bird end date as tickets.
            </p>
          )}
        </div>
      </div>
      )}

      {/* --- Direct payment handles ------------------------------------------
          NEVER LOCKED, at any point in the board's life. These were immutable
          until now only because no route wrote them - nothing protected them,
          and no invariant names them. A mistyped Cash App tag sends real money
          to a stranger every time a contributor reads it, and that is most
          urgent AFTER contributions start, not before.

          No format validation, matching creation. There is no reliable shape
          for a Cash App tag, a Zelle enrolment or a PayPal.me link, and a regex
          that rejected a valid handle would block the very correction this
          exists to allow. ---------------------------------------------------- */}
      <div className="space-y-3 rounded-lg border border-gray-800 p-3">
        <p className="text-xs font-semibold text-gray-300">How contributors pay</p>
        <p className="text-xs text-gray-600 leading-relaxed">
          Tick what this fundraiser accepts. A method is only offered once its
          details are filled in, so you can tick one now and come back to it.
        </p>

        {statuses.map((m) => {
          const h = handleFor[m.method];
          return (
            <div key={m.method} className="rounded-lg border border-gray-800 bg-gray-900 p-2.5">
              <label
                className={`flex items-start gap-2.5 ${m.blocked ? "cursor-not-allowed" : "cursor-pointer"}`}
              >
                <input
                  type="checkbox"
                  checked={m.selected}
                  disabled={m.blocked}
                  onChange={() => toggle(m.method)}
                  className="mt-0.5 accent-green-500 disabled:opacity-40"
                />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline justify-between gap-2">
                    <span className={`text-sm ${m.blocked ? "text-gray-600" : "text-gray-200"}`}>
                      {m.label}
                    </span>
                    {m.offerable && (
                      <span className="text-[11px] uppercase tracking-wide text-green-400">
                        Offered
                      </span>
                    )}
                  </span>
                  {/* WHAT IS STILL REQUIRED, shown only when it matters: the
                      method is ticked and cannot yet be offered. An unticked
                      row nagging about a missing handle is noise. Card's
                      requirement shows always, because it is the one blocker
                      the host cannot clear from this form. */}
                  {m.requirement && (m.selected || m.blocked) && (
                    <span className="block text-xs text-amber-400/80 mt-0.5">
                      {m.requirement}
                    </span>
                  )}
                </span>
              </label>

              {/* The handle sits WITH its toggle. Ticking a rail and filling in
                  its details are one action to a host, and they are written in
                  one transaction, so they belong in one place on screen. */}
              {h && (
                <input
                  aria-label={`${m.label} details`}
                  className={`${inputClass} mt-2`}
                  value={h.value}
                  placeholder={h.placeholder}
                  onChange={(e) => h.set(e.target.value)}
                />
              )}
            </div>
          );
        })}

        {!anyOfferable && (
          <p className="text-xs text-red-400 leading-relaxed">
            Nothing here can take money yet. Tick a method and fill in its
            details, or connect Stripe to accept cards.
          </p>
        )}
      </div>

      {!hasEvent && !addingEvent && (
        <div className="rounded-lg border border-gray-800 bg-gray-900 p-3">
          <p className="text-sm font-medium">No event on this fundraiser</p>
          <p className="text-xs text-gray-500 mt-1 leading-relaxed">
            Add one to issue admission passes and run volunteer sign-ups.
            Contributions that already confirmed will not receive passes.
          </p>
          <button
            type="button"
            onClick={() => setAddingEvent(true)}
            className="mt-3 rounded-lg border border-gray-700 px-3 py-1.5 text-xs text-gray-300 hover:text-white hover:border-gray-600 transition-colors"
          >
            Add an event
          </button>
        </div>
      )}

      {showEventFields && (
        <>
          <div>
            <label htmlFor="eventName" className={labelClass}>Event name</label>
            <input id="eventName" className={inputClass} value={name}
                   placeholder="Homecoming Tailgate"
                   onChange={(e) => setName(e.target.value)} />
          </div>

          <div>
            <label htmlFor="venue" className={labelClass}>Venue</label>
            <input id="venue" className={inputClass} value={venue}
                   placeholder="Armstrong Stadium lot C"
                   onChange={(e) => setVenue(e.target.value)} />
          </div>

          {/* Locked fields stay visible with their values, and say why. */}
          {locked && (
            <div className="rounded-lg border border-amber-900/50 bg-amber-950/30 p-3">
              <p className="text-xs text-amber-200 leading-relaxed">
                <span className="font-semibold">Event timing is locked. </span>
                {lockReason}
              </p>
              <p className="text-xs text-amber-200/70 mt-1.5 leading-relaxed">
                Name and venue can still be corrected. If the date itself is
                wrong, contact support — changing it after people have given
                needs those contributors told, which we do by hand for now.
              </p>
            </div>
          )}

          <div>
            <label htmlFor="startsAt" className={labelClass}>Event starts</label>
            <input id="startsAt" type="datetime-local" className={inputClass}
                   value={startsAt} disabled={locked}
                   onChange={(e) => setStartsAt(e.target.value)} />
          </div>

          <div>
            <label htmlFor="endsAt" className={labelClass}>Event ends (optional)</label>
            <input id="endsAt" type="datetime-local" className={inputClass}
                   value={endsAt} disabled={locked}
                   onChange={(e) => setEndsAt(e.target.value)} />
          </div>

          <div>
            <label htmlFor="timezone" className={labelClass}>Event timezone</label>
            <select id="timezone" className={inputClass} value={timezone} disabled={locked}
                    onChange={(e) => setTimezone(e.target.value)}>
              {ZONES.map((z) => (
                <option key={z} value={z}>{z.split("/")[1].replace(/_/g, " ")}</option>
              ))}
              {!ZONES.includes(timezone) && <option value={timezone}>{timezone}</option>}
            </select>
            {!locked && (
              <p className="text-xs text-gray-600 mt-1">
                Times above are wall-clock in this zone.
              </p>
            )}
          </div>
        </>
      )}

      {error && <p className="text-xs text-red-400">{error}</p>}

      <div className="flex gap-2">
        <button onClick={save} disabled={saving}
                className="rounded-lg bg-white px-3 py-2 text-xs font-medium text-black hover:bg-gray-200 disabled:opacity-50 transition-colors">
          {saving ? "Saving…" : "Save"}
        </button>
        <button onClick={() => { setOpen(false); setError(null); }} disabled={saving}
                className="rounded-lg border border-gray-700 px-3 py-2 text-xs text-gray-300 hover:text-white disabled:opacity-50 transition-colors">
          Cancel
        </button>
      </div>
    </div>
  );
}
