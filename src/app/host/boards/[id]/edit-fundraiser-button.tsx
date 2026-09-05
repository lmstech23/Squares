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
  /** Dollars, as typed. Empty string means no goal. */
  initialGoal: string;
  /** Dollars, as typed. */
  initialPrice: string;
  /** Dollars, as typed. Empty string means no early bird. */
  initialEarlyBirdPrice: string;
  /** `YYYY-MM-DD`, already rendered in the board's zone. */
  initialEarlyBirdEndsAt: string;
  currentTicketCount: number;
  // THE THREE PRICE LOCKS, computed by lib/board-lock.ts on the server. Passed
  // in rather than re-derived here: the form must disable exactly what the
  // route refuses, and two implementations of invariant 76 is one too many.
  inventoryLocked: boolean;
  regularLocked: boolean;
  earlyBirdLocked: boolean;
  inventoryLockReason: string;
  regularLockReason: string;
  earlyBirdLockReason: string;
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
  initialPrice, initialEarlyBirdPrice, initialEarlyBirdEndsAt, currentTicketCount,
  inventoryLocked, regularLocked, earlyBirdLocked,
  inventoryLockReason, regularLockReason, earlyBirdLockReason,
}: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(initialName);
  const [venue, setVenue] = useState(initialVenue);
  const [startsAt, setStartsAt] = useState(initialStartsAt);
  const [endsAt, setEndsAt] = useState(initialEndsAt);
  const [timezone, setTimezone] = useState(initialTimezone);
  const [goal, setGoal] = useState(initialGoal);
  const [price, setPrice] = useState(initialPrice);
  // Reflects whether the board HAS an early bird price, not a stored flag -
  // there is no such column. Clearing the price is how a host turns it off.
  const [earlyBirdOn, setEarlyBirdOn] = useState(initialEarlyBirdPrice !== "");
  const [earlyPrice, setEarlyPrice] = useState(initialEarlyBirdPrice);
  const [earlyEndsAt, setEarlyEndsAt] = useState(initialEarlyBirdEndsAt);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Adding an event to a board that never had one. The creation-time checkbox
  // used to be a one-way door: without an event there can be no SignupSheet,
  // so no volunteer sign-ups, ever. Same fields, same surface — the host opts
  // in here and the form below is the one she already knows.
  const [addingEvent, setAddingEvent] = useState(false);
  const showEventFields = hasEvent || addingEvent;

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
    !inventoryLocked && (goalChanged || priceChanged)
      ? validateTicketCount(goalCents, priceCents)
      : null;
  const nextCount = preview && preview.ok ? preview.count : null;
  const willResize = nextCount != null && nextCount !== currentTicketCount;

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
      if (!earlyEndsAt) {
        setError("Choose the date early bird pricing ends, or turn Early Bird off.");
        return;
      }
      if (priceCents != null && earlyCents >= priceCents) {
        setError("Early bird price must be below the ticket price.");
        return;
      }
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
      };
      // A LOCKED PRICE FIELD IS NOT SENT AT ALL. It is disabled and merely
      // displaying its stored value; echoing that value back would be a write
      // the route answers with 409 even though nothing changed.
      if (!regularLocked) body.squarePrice = priceCents;
      if (!earlyBirdLocked) {
        body.earlyBirdPriceCents = earlyBirdOn ? earlyCents : null;
        // Sent as `YYYY-MM-DD`; the route resolves it to 11:59:59 PM in the
        // board's zone, the same rule creation and campaign close use.
        body.earlyBirdEndsAt = earlyBirdOn ? earlyEndsAt : null;
      }
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
        Edit campaign details
      </button>
    );
  }

  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900 p-4 space-y-4">
      <h3 className="text-sm font-semibold text-white">Campaign details</h3>

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

            <div>
              <label htmlFor="earlyEndsAt" className={labelClass}>Early bird ends</label>
              <input
                id="earlyEndsAt" type="date"
                className={inputClass} value={earlyEndsAt} disabled={earlyBirdLocked}
                onChange={(e) => setEarlyEndsAt(e.target.value)}
              />
              {!earlyBirdLocked && (
                <p className="text-xs text-gray-600 mt-1">
                  The early price applies through 11:59 PM Eastern on this date.
                </p>
              )}
            </div>
          </>
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
