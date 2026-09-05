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

export default function EditFundraiserButton({
  boardId, hasEvent, locked, lockReason,
  initialName, initialVenue, initialStartsAt, initialEndsAt, initialTimezone, initialGoal,
}: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(initialName);
  const [venue, setVenue] = useState(initialVenue);
  const [startsAt, setStartsAt] = useState(initialStartsAt);
  const [endsAt, setEndsAt] = useState(initialEndsAt);
  const [timezone, setTimezone] = useState(initialTimezone);
  const [goal, setGoal] = useState(initialGoal);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Adding an event to a board that never had one. The creation-time checkbox
  // used to be a one-way door: without an event there can be no SignupSheet,
  // so no volunteer sign-ups, ever. Same fields, same surface — the host opts
  // in here and the form below is the one she already knows.
  const [addingEvent, setAddingEvent] = useState(false);
  const showEventFields = hasEvent || addingEvent;

  async function save() {
    setSaving(true);
    setError(null);
    try {
      // Only send what may actually change. Omitting locked fields entirely
      // means a stale tab cannot trip the server's 409 by echoing back values
      // it merely displayed.
      const body: Record<string, unknown> = {
        fundraisingGoalCents: goal.trim() === "" ? null : Math.round(parseFloat(goal) * 100),
      };
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
        <p className="text-xs text-gray-600 mt-1">
          Ticket count locks after the first confirmed contribution.
        </p>
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
