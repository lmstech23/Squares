"use client";

// Volunteer sign-up sheet — host slot builder. Sign-up addendum §8, S2.
//
// Mounted inside the existing event panel rather than grown into it: this is a
// distinct job with its own state, and event-panel.tsx already owns check-in
// staff links and donate flags.
//
// Data arrives as props from the host page's server component, the same way the
// rest of that page works. No fetch-on-mount, so there is no loading flash and
// no one-off client loading state to maintain.
//
// WHAT THIS DOES NOT DO: delete slots. S2 is create, edit, reorder and sheet
// open/close (ruling 2). Removing a helper is HOST_REMOVED and belongs with
// helper management, not here.
//
// The summary shows CURRENT OPERATIONAL STATE — filled and open capacity — and
// deliberately no cancellation count. SignupLog is append-only, so a raw
// CANCELLED tally counts cancel-and-reclaim cycles by the same person.

import { useState } from "react";
import { useRouter } from "next/navigation";

export interface PanelSlot {
  id: string;
  slotType: "SHIFT" | "ITEM";
  name: string;
  startsAt: string | null;
  endsAt: string | null;
  capacity: number;
  unitLabel: string | null;
  notes: string | null;
  sortOrder: number;
  filled: number;
}

interface Props {
  boardId: string;
  eventTimezone: string;
  sheet: { id: string; title: string | null; instructions: string | null; isOpen: boolean } | null;
  slots: PanelSlot[];
}

const input =
  "w-full rounded-lg border border-gray-800 bg-gray-900 px-3 py-2 text-sm text-white placeholder:text-gray-600 outline-none focus:border-gray-600 transition-colors";
const label = "block text-xs text-gray-500 mb-1";
const btn =
  "rounded-lg border border-gray-700 px-3 py-1.5 text-xs text-gray-300 hover:text-white hover:border-gray-600 disabled:opacity-50 transition-colors";

function timeLabel(slot: PanelSlot, tz: string): string {
  if (slot.slotType === "ITEM") return slot.unitLabel ?? "";
  if (!slot.startsAt) return "";
  const f = (iso: string) =>
    new Intl.DateTimeFormat("en-US", {
      month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: tz,
    }).format(new Date(iso));
  // An open-ended shift is legitimate — "Cleanup after the game" ends when the
  // lot is clear — so a missing end is rendered as open, never as a blank.
  return slot.endsAt ? `${f(slot.startsAt)} – ${f(slot.endsAt)}` : `${f(slot.startsAt)} onward`;
}

export default function SignupPanel({ boardId, eventTimezone, sheet, slots }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const [slotType, setSlotType] = useState<"SHIFT" | "ITEM">("SHIFT");
  const [name, setName] = useState("");
  const [capacity, setCapacity] = useState("1");
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [unitLabel, setUnitLabel] = useState("");

  const totalCapacity = slots.reduce((n, s) => n + s.capacity, 0);
  const totalFilled = slots.reduce((n, s) => n + s.filled, 0);

  async function call(url: string, method: string, body?: unknown, key = "x") {
    setBusy(key);
    setError(null);
    try {
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "Something went wrong.");
        return false;
      }
      router.refresh();
      return true;
    } catch {
      setError("Could not reach the server. Check your connection.");
      return false;
    } finally {
      setBusy(null);
    }
  }

  function resetForm() {
    setName(""); setCapacity("1"); setStartsAt(""); setEndsAt(""); setUnitLabel("");
    setSlotType("SHIFT"); setAdding(false); setEditingId(null);
  }

  // --- no sheet -----------------------------------------------------------
  if (!sheet) {
    return (
      <div className="rounded-lg border border-gray-800 bg-gray-900 p-4">
        <p className="text-sm font-medium text-white">Volunteer sign-up</p>
        <p className="text-xs text-gray-500 mt-1 leading-relaxed">
          Ask the people already supporting this campaign to bring something or
          work a shift. Only confirmed supporters can sign up.
        </p>
        {error && <p className="text-xs text-red-400 mt-2">{error}</p>}
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => call(`/api/host/boards/${boardId}/signup-sheet`, "POST", undefined, "create")}
          className={`${btn} mt-3`}
        >
          {busy === "create" ? "Creating…" : "Create volunteer sign-up"}
        </button>
      </div>
    );
  }

  const slotForm = (
    <div className="rounded-lg border border-gray-800 bg-gray-950 p-3 space-y-3 mt-3">
      <div className="flex gap-2">
        {(["SHIFT", "ITEM"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => { setSlotType(t); setStartsAt(""); setEndsAt(""); setUnitLabel(""); }}
            className={`flex-1 rounded-lg border py-2 text-xs transition-colors ${
              slotType === t
                ? "border-green-500 bg-green-950/20 text-white"
                : "border-gray-800 bg-gray-900 text-gray-400 hover:border-gray-700"
            }`}
          >
            {t === "SHIFT" ? "A shift" : "Something to bring"}
          </button>
        ))}
      </div>

      <div>
        <label className={label} htmlFor="slotName">Name</label>
        <input id="slotName" className={input} value={name} onChange={(e) => setName(e.target.value)}
               placeholder={slotType === "SHIFT" ? "Main gate" : "Cases of water"} />
      </div>

      {slotType === "SHIFT" ? (
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className={label} htmlFor="slotStart">Starts</label>
            <input id="slotStart" type="datetime-local" className={input}
                   value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
          </div>
          <div>
            <label className={label} htmlFor="slotEnd">Ends (optional)</label>
            <input id="slotEnd" type="datetime-local" className={input}
                   value={endsAt} onChange={(e) => setEndsAt(e.target.value)} />
          </div>
        </div>
      ) : (
        <div>
          <label className={label} htmlFor="slotUnit">Unit (optional)</label>
          <input id="slotUnit" className={input} value={unitLabel}
                 onChange={(e) => setUnitLabel(e.target.value)} placeholder="case of water" />
        </div>
      )}

      <div>
        <label className={label} htmlFor="slotCap">
          {slotType === "SHIFT" ? "How many people?" : "How many needed?"}
        </label>
        <input id="slotCap" type="number" min={1} className={input}
               value={capacity} onChange={(e) => setCapacity(e.target.value)} />
      </div>

      {error && <p className="text-xs text-red-400">{error}</p>}

      <div className="flex gap-2">
        <button
          type="button"
          disabled={busy !== null}
          onClick={async () => {
            const payload = {
              slotType, name, capacity: parseInt(capacity, 10),
              startsAt: slotType === "SHIFT" ? startsAt || null : null,
              endsAt: slotType === "SHIFT" ? endsAt || null : null,
              unitLabel: slotType === "ITEM" ? unitLabel || null : null,
            };
            const url = editingId
              ? `/api/host/boards/${boardId}/signup-slots/${editingId}`
              : `/api/host/boards/${boardId}/signup-slots`;
            if (await call(url, editingId ? "PATCH" : "POST", payload, "save")) resetForm();
          }}
          className="rounded-lg bg-white px-3 py-1.5 text-xs font-medium text-black hover:bg-gray-200 disabled:opacity-50 transition-colors"
        >
          {busy === "save" ? "Saving…" : editingId ? "Save" : "Add"}
        </button>
        <button type="button" onClick={() => { resetForm(); setError(null); }} className={btn}>
          Cancel
        </button>
      </div>
    </div>
  );

  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-white">
            {sheet.title ?? "Volunteer Sign-Up"}{" "}
            <span className={sheet.isOpen ? "text-green-400" : "text-gray-500"}>
              · {sheet.isOpen ? "open" : "closed"}
            </span>
          </p>
          {slots.length > 0 && (
            <p className="text-xs text-gray-500 mt-0.5 tabular-nums">
              {totalFilled} of {totalCapacity} filled ·{" "}
              {Math.max(0, totalCapacity - totalFilled)} open
            </p>
          )}
        </div>
        <button
          type="button"
          disabled={busy !== null}
          onClick={() =>
            call(`/api/host/boards/${boardId}/signup-sheet`, "PATCH", { isOpen: !sheet.isOpen }, "toggle")
          }
          className={btn}
        >
          {busy === "toggle" ? "…" : sheet.isOpen ? "Close sign-ups" : "Reopen sign-ups"}
        </button>
      </div>

      {!sheet.isOpen && (
        <p className="text-xs text-gray-600 mt-2 leading-relaxed">
          Closed to new sign-ups. People who already signed up can still see and
          cancel theirs, and you can keep editing this sheet.
        </p>
      )}

      {slots.length === 0 && !adding && (
        <p className="text-xs text-gray-500 mt-3">Add your first volunteer need.</p>
      )}

      {slots.length > 0 && (
        <div className="mt-3 space-y-1.5">
          {slots.map((s, i) => (
            <div key={s.id} className="flex items-center gap-2 rounded-lg border border-gray-800 bg-gray-950 px-3 py-2">
              <div className="flex flex-col gap-0.5">
                <button type="button" aria-label="Move up" disabled={i === 0 || busy !== null}
                  onClick={() => {
                    const ids = slots.map((x) => x.id);
                    [ids[i - 1], ids[i]] = [ids[i], ids[i - 1]];
                    call(`/api/host/boards/${boardId}/signup-slots/reorder`, "POST", { slotIds: ids }, "order");
                  }}
                  className="text-[10px] text-gray-600 hover:text-white disabled:opacity-30">▲</button>
                <button type="button" aria-label="Move down" disabled={i === slots.length - 1 || busy !== null}
                  onClick={() => {
                    const ids = slots.map((x) => x.id);
                    [ids[i], ids[i + 1]] = [ids[i + 1], ids[i]];
                    call(`/api/host/boards/${boardId}/signup-slots/reorder`, "POST", { slotIds: ids }, "order");
                  }}
                  className="text-[10px] text-gray-600 hover:text-white disabled:opacity-30">▼</button>
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm text-white truncate">{s.name}</p>
                <p className="text-xs text-gray-600 truncate">{timeLabel(s, eventTimezone)}</p>
              </div>
              <span className="text-xs tabular-nums flex-shrink-0 text-gray-400">
                {s.filled}/{s.capacity}
              </span>
              <button type="button" disabled={busy !== null} className={btn}
                onClick={() => {
                  setEditingId(s.id); setAdding(true); setSlotType(s.slotType);
                  setName(s.name); setCapacity(String(s.capacity));
                  setUnitLabel(s.unitLabel ?? "");
                  setStartsAt(s.startsAt ? s.startsAt.slice(0, 16) : "");
                  setEndsAt(s.endsAt ? s.endsAt.slice(0, 16) : "");
                }}>
                Edit
              </button>
            </div>
          ))}
        </div>
      )}

      {adding ? slotForm : (
        <button type="button" onClick={() => setAdding(true)} className={`${btn} mt-3`}>
          Add a volunteer need
        </button>
      )}

      {error && !adding && <p className="text-xs text-red-400 mt-2">{error}</p>}
    </div>
  );
}
