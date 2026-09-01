"use client";

// The supporter's view of the sign-up sheet. Sign-up addendum §6.
//
// THE STEPPER IS A DESIRED TOTAL, NOT "ADD N". Its value is what she wants to
// hold after saving, and the server takes the same number. A stepper meaning
// "add" while the server means "set" is the mismatch that makes a double-tap
// cost someone four cases of water instead of two.
//
// Ceiling is `yourCurrent + available`, not `available`: a supporter holding 2
// of 6 with 1 left may set 3. Her own positions are not an obstacle to her own
// target.
//
// Nothing here is a separate "cancel" control. Cancelling is target 0 and
// reducing is a smaller target — one path, one set of edge cases.

import { useState } from "react";
import { useRouter } from "next/navigation";

export interface SheetSlot {
  id: string;
  name: string;
  slotType: "SHIFT" | "ITEM";
  unitLabel: string | null;
  notes: string | null;
  startsAt: string | null;
  endsAt: string | null;
  capacity: number;
  filled: number;
  available: number;
  yourCurrent: number;
  maxTarget: number;
}

interface Props {
  token: string;
  firstName: string;
  title: string;
  instructions: string | null;
  isOpen: boolean;
  canClaim: boolean;
  eventName: string | null;
  eventVenue: string | null;
  eventTimezone: string;
  slots: SheetSlot[];
}

function when(slot: SheetSlot, tz: string): string | null {
  if (slot.slotType === "ITEM") return slot.unitLabel;
  if (!slot.startsAt) return null;
  const f = (iso: string) =>
    new Intl.DateTimeFormat("en-US", {
      weekday: "short", hour: "numeric", minute: "2-digit", timeZone: tz,
    }).format(new Date(iso));
  // An open-ended shift is legitimate, so a missing end reads as open rather
  // than as a blank.
  return slot.endsAt ? `${f(slot.startsAt)} – ${f(slot.endsAt)}` : `${f(slot.startsAt)} onward`;
}

export default function SignupSheetView({
  token, firstName, title, instructions, isOpen, canClaim,
  eventName, eventVenue, eventTimezone, slots,
}: Props) {
  const router = useRouter();
  const [drafts, setDrafts] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState<string | null>(null);

  const draftFor = (s: SheetSlot) => drafts[s.id] ?? s.yourCurrent;

  async function save(slot: SheetSlot, target: number) {
    setBusy(slot.id);
    setErrors((e) => ({ ...e, [slot.id]: "" }));
    try {
      const res = await fetch(`/api/signup/${token}/claim`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slotId: slot.id, target }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErrors((e) => ({ ...e, [slot.id]: data.error ?? "Something went wrong." }));
        // Capacity moved under her. Resync the stepper to what she CAN have and
        // let her confirm — never submit the smaller number for her.
        if (typeof data.maxTarget === "number") {
          setDrafts((d) => ({ ...d, [slot.id]: Math.min(target, data.maxTarget) }));
        }
        return;
      }
      setDrafts((d) => { const n = { ...d }; delete n[slot.id]; return n; });
      setSaved(slot.id);
      router.refresh();
    } catch {
      setErrors((e) => ({ ...e, [slot.id]: "Couldn't reach the server. Try again." }));
    } finally {
      setBusy(null);
    }
  }

  const helping = slots.filter((s) => s.yourCurrent > 0);

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <div className="max-w-lg mx-auto px-4 py-6">
        <h1 className="text-xl font-bold leading-tight">{title}</h1>
        {eventName && (
          <p className="text-sm text-gray-400 mt-1">
            {eventName}
            {eventVenue && ` · ${eventVenue}`}
          </p>
        )}
        <p className="text-sm text-gray-500 mt-2">Hi {firstName} — thank you for chipping in.</p>

        {instructions && (
          <p className="text-sm text-gray-300 mt-4 leading-relaxed">{instructions}</p>
        )}

        {/* Closed stops NEW sign-ups only. Say so plainly, because a helper who
            thinks she is stuck with a shift she cannot work simply will not
            show up, which is worse for the host than being told. */}
        {!isOpen && (
          <div className="mt-4 rounded-lg border border-gray-800 bg-gray-900 p-3">
            <p className="text-sm">Sign-ups are closed.</p>
            <p className="text-xs text-gray-500 mt-1 leading-relaxed">
              You can still see what you signed up for, and cancel or reduce it
              if your plans change.
            </p>
          </div>
        )}

        {/* Not active: her commitments stand and stay withdrawable. §10 keeps
            them deliberately so the host can review, so this page must show
            them rather than refuse to render. */}
        {!canClaim && (
          <div className="mt-4 rounded-lg border border-amber-900/50 bg-amber-950/30 p-3">
            <p className="text-sm text-amber-200">
              We can&apos;t confirm your contribution right now.
            </p>
            <p className="text-xs text-amber-200/70 mt-1 leading-relaxed">
              You can&apos;t sign up for anything new until that&apos;s sorted, but
              anything you already signed up for is still yours — and you can still
              cancel it. Reach out to the host if this looks wrong.
            </p>
          </div>
        )}

        {helping.length > 0 && (
          <div className="mt-5 rounded-lg border border-green-900/50 bg-green-950/20 p-3">
            <p className="text-xs font-medium text-green-300 uppercase tracking-wider">
              You&apos;re helping with
            </p>
            <ul className="mt-1.5 space-y-0.5">
              {helping.map((s) => (
                <li key={s.id} className="text-sm text-green-100">
                  {s.slotType === "ITEM" ? `${s.yourCurrent} × ` : ""}
                  {s.name}
                </li>
              ))}
            </ul>
          </div>
        )}

        {slots.length === 0 && (
          <p className="text-sm text-gray-500 mt-6">
            The host hasn&apos;t added any volunteer needs yet. Keep this link — it
            will work when she does.
          </p>
        )}

        <div className="mt-6 space-y-2">
          {slots.map((slot) => {
            const draft = draftFor(slot);
            const dirty = draft !== slot.yourCurrent;
            const full = slot.available === 0 && slot.yourCurrent === 0;
            const locked = !canClaim || (!isOpen && draft > slot.yourCurrent);
            const err = errors[slot.id];

            return (
              <div key={slot.id} className="rounded-lg border border-gray-800 bg-gray-900 p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{slot.name}</p>
                    {when(slot, eventTimezone) && (
                      <p className="text-xs text-gray-500 mt-0.5">{when(slot, eventTimezone)}</p>
                    )}
                    {slot.notes && (
                      <p className="text-xs text-gray-600 mt-1 leading-relaxed">{slot.notes}</p>
                    )}
                  </div>
                  <span className="flex-shrink-0 text-xs tabular-nums text-gray-400">
                    {full ? "FULL" : `${slot.available} of ${slot.capacity} open`}
                  </span>
                </div>

                {(!full || slot.yourCurrent > 0) && (
                  <div className="mt-3 flex items-center gap-2">
                    {slot.slotType === "ITEM" ? (
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          aria-label="Fewer"
                          disabled={busy !== null || draft <= 0}
                          onClick={() => setDrafts((d) => ({ ...d, [slot.id]: draft - 1 }))}
                          className="h-8 w-8 rounded-lg border border-gray-700 text-sm text-gray-300 disabled:opacity-30"
                        >
                          −
                        </button>
                        <span className="w-8 text-center text-sm tabular-nums">{draft}</span>
                        <button
                          type="button"
                          aria-label="More"
                          // Ceiling is yourCurrent + available, computed server-side.
                          disabled={busy !== null || draft >= slot.maxTarget}
                          onClick={() => setDrafts((d) => ({ ...d, [slot.id]: draft + 1 }))}
                          className="h-8 w-8 rounded-lg border border-gray-700 text-sm text-gray-300 disabled:opacity-30"
                        >
                          +
                        </button>
                      </div>
                    ) : null}

                    {slot.slotType === "SHIFT" ? (
                      <button
                        type="button"
                        disabled={busy !== null || locked || (slot.yourCurrent === 0 && full)}
                        onClick={() => save(slot, slot.yourCurrent === 1 ? 0 : 1)}
                        className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-40 ${
                          slot.yourCurrent === 1
                            ? "border border-gray-700 text-gray-300 hover:text-white"
                            : "bg-white text-gray-950 hover:bg-gray-200"
                        }`}
                      >
                        {busy === slot.id
                          ? "…"
                          : slot.yourCurrent === 1
                            ? "Cancel"
                            : "Sign up"}
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={busy !== null || !dirty || locked}
                        onClick={() => save(slot, draft)}
                        className="rounded-lg bg-white px-3 py-1.5 text-sm font-medium text-gray-950 hover:bg-gray-200 disabled:opacity-40 transition-colors"
                      >
                        {busy === slot.id ? "…" : dirty ? "Save" : "Saved"}
                      </button>
                    )}

                    {saved === slot.id && !dirty && !err && (
                      <span className="text-xs text-green-400">Saved</span>
                    )}
                  </div>
                )}

                {err && <p className="text-xs text-red-400 mt-2">{err}</p>}
              </div>
            );
          })}
        </div>

        <p className="text-xs text-gray-600 mt-8 leading-relaxed">
          Keep this link — it always shows what you signed up for, and you can
          change it any time.
        </p>
      </div>
    </div>
  );
}
