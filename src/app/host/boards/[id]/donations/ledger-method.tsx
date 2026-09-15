"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import TenderPicker from "@/components/tender-picker";
import type { DirectRail } from "@/lib/accepted-payments";
import {
  RAIL_TENDER,
  TENDER_LABEL,
  declaredRailDiffers,
  methodLabel,
  type OfflineTender,
} from "@/lib/tender";

// The ledger's Method cell, its detail reveal, and the inline correction —
// payment-method addendum v1.2.7 §5, §6.
//
// WHAT THE HOST IS ACTUALLY ASKING. Not "what does the database say" but "can
// I trust this line when I am standing at the bank". A Card row was witnessed
// by Stripe; an offline row rests on her own word, and the two must be
// distinguishable without opening anything.
//
// SO: Card renders plain, and every offline row with a tender carries the amber
// marker. A row whose tender predates recording says "Recorded by host" -
// NEVER "Cash", which would assert a fact nobody recorded.
//
// CORRECTION IS INLINE AND HAS NO MODAL. It cannot touch a dollar or a state,
// which is the entire reason it needs no ceremony. Correcting one of the
// historical null-tender rows is the PRIMARY path, so the empty state offers
// the edit action rather than hiding it behind a populated one.
//
// NOTHING HERE REACHES THE PUBLIC BOARD. Money doc §10 gives the public two
// numbers; tender, reference, recorder and declared rail are host-only.

export interface LedgerMethodProps {
  boardId: string;
  contributionId: string;
  settlement: "STRIPE" | "OFFLINE";
  tender: string | null;
  reference: string | null;
  /** Already resolved to a name or email by the page; null when unknown. */
  recordedBy: string | null;
  /** Already formatted in the board's timezone by the page. */
  recordedAt: string | null;
  declaredRail: DirectRail | null;
  /** The board's configured rails, resolved live at render — §4. */
  rails: DirectRail[];
  /** Whether this viewer may correct. The route checks again regardless. */
  canCorrect: boolean;
}

export default function LedgerMethod({
  boardId,
  contributionId,
  settlement,
  tender,
  reference,
  recordedBy,
  recordedAt,
  declaredRail,
  rails,
  canCorrect,
}: LedgerMethodProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draftTender, setDraftTender] = useState<OfflineTender | null>(
    (tender as OfflineTender | null) ?? null
  );
  const [draftReference, setDraftReference] = useState(reference ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const label = methodLabel(settlement, tender);

  // SYSTEM-WITNESSED. Nothing to reveal and nothing to correct: Stripe's own
  // record is the detail, and the route refuses a correction on it anyway.
  if (settlement === "STRIPE") {
    return <span className="text-gray-300">{label}</span>;
  }

  // Shown only when it adds something. A declared Zelle confirmed as Zelle
  // repeats itself; declared Zelle confirmed as Cash is the fact worth keeping.
  const showDeclared = declaredRailDiffers(declaredRail, tender);
  const hasDetail = Boolean(recordedBy || recordedAt || reference || showDeclared);

  async function save() {
    // Only what actually changed. The route logs per field, and a field sent
    // at its current value would write nothing anyway.
    const body: Record<string, unknown> = { contributionId };
    if (draftTender && draftTender !== tender) body.tender = draftTender;
    const nextReference = draftReference.trim() || null;
    if (nextReference !== (reference ?? null)) body.tenderReference = nextReference;

    if (Object.keys(body).length === 1) {
      setEditing(false);
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/host/boards/${boardId}/contribution-tender`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Something went wrong.");
        setBusy(false);
        return;
      }
      setEditing(false);
      setBusy(false);
      router.refresh();
    } catch {
      setError("Something went wrong.");
      setBusy(false);
    }
  }

  return (
    <div className="min-w-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="text-left text-gray-300 hover:text-white transition-colors"
      >
        {label}
        {/* THE MARKER. Host-attested at a glance, without a second column and
            without shouting: a Card row simply does not have it. Redundant on
            a null tender, where the label already says who recorded it. */}
        {tender && (
          <span className="ml-1 text-[10px] uppercase tracking-wider text-amber-600/90">
            · recorded
          </span>
        )}
      </button>

      {open && (
        <div className="mt-1 rounded border border-gray-800 bg-gray-950 px-2 py-1.5 text-[11px] leading-relaxed text-gray-400">
          {editing ? (
            <div>
              <TenderPicker
                rails={rails}
                value={draftTender}
                onChange={(t) => {
                  setDraftTender(t);
                  setError(null);
                }}
                reference={draftReference}
                onReferenceChange={setDraftReference}
                declaredRail={declaredRail}
                idPrefix={`fix-${contributionId}`}
                disabled={busy}
              />
              {error && <p className="mt-1.5 text-[11px] text-red-400">{error}</p>}
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={save}
                  className="rounded border border-gray-700 px-2 py-1 text-[11px] text-gray-200 hover:border-gray-500 disabled:opacity-40 transition-colors"
                >
                  {busy ? "Saving…" : "Save"}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setEditing(false);
                    setDraftTender((tender as OfflineTender | null) ?? null);
                    setDraftReference(reference ?? "");
                    setError(null);
                  }}
                  className="rounded border border-gray-800 px-2 py-1 text-[11px] text-gray-400 hover:border-gray-600 disabled:opacity-40 transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <>
              {hasDetail ? (
                <>
                  {recordedBy && (
                    <div>
                      Recorded by <span className="text-gray-300">{recordedBy}</span>
                    </div>
                  )}
                  {recordedAt && <div>Recorded {recordedAt}</div>}
                  {reference && (
                    <div className="truncate">
                      Reference <span className="text-gray-300">{reference}</span>
                    </div>
                  )}
                  {showDeclared && declaredRail && (
                    <div>
                      Contributor said{" "}
                      <span className="text-gray-300">
                        {TENDER_LABEL[RAIL_TENDER[declaredRail]]}
                      </span>
                    </div>
                  )}
                </>
              ) : (
                // AN HONEST EMPTY STATE, AND THE WAY IN. No blank panel and
                // nothing invented: this row predates method recording, which
                // is what the 14 recorder-less rows on the live board are. The
                // edit action sits right here because correcting one of them is
                // the primary path, not an afterthought.
                <div>
                  Nothing further was recorded. This row predates the method
                  picker.
                </div>
              )}
              {canCorrect && (
                <button
                  type="button"
                  onClick={() => setEditing(true)}
                  className="mt-1 text-[11px] text-gray-500 underline underline-offset-2 hover:text-gray-300 transition-colors"
                >
                  {tender ? "Correct method" : "Record the method"}
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
