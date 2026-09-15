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
  nullTenderLabel,
  type OfflineTender,
} from "@/lib/tender";

// The ledger's Method cell, its detail reveal, and the inline correction —
// payment-method addendum v1.2.10 §5, §6.
//
// WHAT THE HOST IS ACTUALLY ASKING. Not "what does the database say" but "can
// I trust this line when I am standing at the bank". A Card row was witnessed
// by Stripe; an offline row rests on her own word, and the two must be
// distinguishable without opening anything.
//
// SO: the label carries it, and nothing else needs to. Invariant 121 makes
// CARD reachable only from a witnessed row and never from an attested one, so
// "Card" ALREADY MEANS Stripe watched it and "Zelle" already means a host said
// so. A marker beside them restated what the constraint proves - and cost a
// trailing separator and a two-line wrap to do it.
//
// A ROW WITH NO TENDER SAYS SO. "Recorded by host" was not merely unhelpful
// there, it was FALSE: nobody recorded a payment type on that row, which is
// what null means. M0's backfill refused to write CASH onto those rows on
// exactly those grounds, and this cell had put a different invented fact back
// in its place. With `cash.record` it now reads "Select payment type";
// without it, "No payment type recorded", and it does not open. The copy
// tracks the same capability the route enforces, so the cell never offers a
// control the viewer would be refused. Neither ever says "Cash".
//
// CORRECTION IS THE CELL. No modal, no edit mode, no Save, no Cancel: a native
// select, and choosing writes. It cannot touch a dollar, a state, a total or an
// eligibility - that is the entire reason it needs no ceremony, and a Save
// button on a one-field form only asks her to confirm what she already said.
// While the write is in flight the select is disabled; if it fails, the prior
// value comes back and the error sits under it.
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
  const [selected, setSelected] = useState<OfflineTender | null>(
    (tender as OfflineTender | null) ?? null
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // THE COLUMN'S WIDTH LIVES HERE, ON A BLOCK CHILD - NOT ON THE <td>.
  //
  // `min-width` on a table-cell box is not binding: CSS 2.1 17.5.2 hands
  // column sizing to the table layout algorithm, and the browser is free to
  // ignore it. A min-width on a BLOCK inside the cell is binding, because it
  // raises the cell's min-content width, which the algorithm must respect.
  // That is the difference between the first attempt at this and this one.
  //
  // Every branch below wraps in it, so the column is the same width whichever
  // rows a board happens to have - otherwise a board of Card rows would size
  // the column to `Card` and the first correction would reflow the table.
  const WIDTH = "min-w-[13rem]";

  // SYSTEM-WITNESSED. Nothing to reveal and nothing to correct: Stripe's own
  // record is the detail, and the route refuses a correction on it anyway.
  if (settlement === "STRIPE") {
    return (
      <div className={WIDTH}>
        <span className="text-gray-300">{methodLabel(settlement, tender)}</span>
      </div>
    );
  }

  const label = tender
    ? methodLabel(settlement, tender)
    : nullTenderLabel(canCorrect);

  // NOT INTERACTIVE, and the label says as much. A viewer without cash.record
  // looking at a row nobody recorded has nothing to open: no method to read,
  // and no way to supply one.
  if (!tender && !canCorrect) {
    return (
      <div className={WIDTH}>
        <span className="whitespace-nowrap text-gray-500">{label}</span>
      </div>
    );
  }

  // Shown only when it adds something. A declared Zelle confirmed as Zelle
  // repeats itself; declared Zelle confirmed as Cash is the fact worth keeping.
  const showDeclared = declaredRailDiffers(declaredRail, tender);
  const hasDetail = Boolean(recordedBy || recordedAt || reference || showDeclared);

  // NOTHING TO SHOW AND NOTHING TO DO. With the empty state gone, a disclosure
  // here would open an empty box. Unreachable today - OWNER and MANAGER both
  // hold cash.record, so canCorrect is true for anyone who can load this page -
  // and cheaper to guard than to rediscover the day a third role exists.
  if (!hasDetail && !canCorrect) {
    return (
      <div className={WIDTH}>
        <span className="whitespace-nowrap text-gray-300">{label}</span>
      </div>
    );
  }

  async function choose(next: OfflineTender) {
    if (next === selected) return;
    // The value to put back if the write is refused. Optimistic, because the
    // alternative is a select that ignores the tap until the network answers.
    const previous = selected;
    setSelected(next);
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/host/boards/${boardId}/contribution-tender`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        // TENDER ONLY. The compact cell does not collect a reference, so it
        // must not send the field at all - sending null would erase one that
        // is already there, which is a correction nobody asked for.
        body: JSON.stringify({ contributionId, tender: next }),
      });
      const data = await res.json();
      if (!res.ok) {
        setSelected(previous);
        setError(data.error || "Something went wrong.");
        setBusy(false);
        return;
      }
      setBusy(false);
      router.refresh();
    } catch {
      setSelected(previous);
      setError("Something went wrong.");
      setBusy(false);
    }
  }

  return (
    <div className={WIDTH}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="group inline-flex items-baseline gap-1 whitespace-nowrap text-left text-gray-300 decoration-dotted decoration-gray-700 underline-offset-4 transition-colors hover:text-white hover:underline"
      >
        {label}
        {/* AN AFFORDANCE, NOT A STATUS. The cell has to look openable - the
            marker used to be the only cue - but it must not spend a word on
            saying what the label already says. Hover underline plus a chevron
            that turns when the row is open, and nothing in the reading flow. */}
        <span
          aria-hidden
          className={`inline-block text-[9px] leading-none text-gray-600 transition-transform group-hover:text-gray-400 ${
            open ? "rotate-180" : ""
          }`}
        >
          ▾
        </span>
      </button>

      {open && (
        <div className="mt-1 rounded border border-gray-800 bg-gray-950 px-2 py-1.5 text-[11px] leading-relaxed text-gray-400">
          {/* NO EMPTY STATE. "Nothing further was recorded. This row
              predates the method picker." answered a question the cell used
              to raise - why is this panel blank - and the label answers it
              now by being a control rather than a description. On a row with
              nothing recorded there is nothing to reveal, so the panel opens
              straight to the select: the thing she tapped for, with no
              paragraph in front of it.

              Gated on hasDetail, not on `tender === null`. The two coincide
              on every historical row - they carry no timestamp, reference or
              declared rail, and their recorder resolves to nothing - but if
              one ever does carry a recorder, showing it beats discarding it
              to satisfy a premise. */}
          {hasDetail && (
            <>
              {recordedBy && (
                <div>
                  Recorded by <span className="text-gray-300">{recordedBy}</span>
                </div>
              )}
              {recordedAt && <div>Recorded {recordedAt}</div>}
              {/* EXISTING REFERENCES STAY VISIBLE. The compact picker stopped
                  asking for one; nothing stopped storing or showing them, and
                  the confirm paths still collect one. */}
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
          )}

          {canCorrect && (
            <div className={hasDetail ? "mt-1.5" : ""}>
              <TenderPicker
                variant="compact"
                rails={rails}
                value={selected}
                onChange={choose}
                idPrefix={`fix-${contributionId}`}
                disabled={busy}
              />
            </div>
          )}
          {error && <p className="mt-1.5 text-[11px] text-red-400">{error}</p>}
        </div>
      )}
    </div>
  );
}
