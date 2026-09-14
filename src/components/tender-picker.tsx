"use client";

import type { DirectRail } from "@/lib/accepted-payments";
import {
  RAIL_TENDER,
  TENDER_LABEL,
  TENDER_REFERENCE_MAX,
  offlineTenderOptions,
  referencePlaceholder,
  type OfflineTender,
} from "@/lib/tender";

// THE ONE TENDER PICKER, used by all four confirm paths — payment-method
// addendum v1.2.6 §4. Four copies would drift, and the one that drifts is
// whichever gets looked at least.
//
// NO DEFAULT SELECTION, and no prefill from the declared rail. A preselected
// method is a method the host taps past, and the row it produces says FACT
// while meaning "she did not correct the guess". That is the exact failure this
// whole change exists to end.
//
// THE DECLARED RAIL IS CONTEXT AND NOTHING ELSE. It is what a contributor said
// on Tuesday; the tender is what the host had on Saturday, and they are allowed
// to disagree. Shown as a line of text, never as a selection.
//
// CARD IS NEVER AN OPTION. offlineTenderOptions cannot return it.

export interface TenderPickerProps {
  /** The board's configured rails, resolved live at render by the server
   *  component that owns the board row. Cash, Check and Other are always
   *  offered, so an unconfigured board still has three answers. */
  rails: readonly DirectRail[];
  value: OfflineTender | null;
  onChange: (tender: OfflineTender) => void;
  reference: string;
  onReferenceChange: (reference: string) => void;
  /** Context only: "Contributor said: Zelle". Never preselects. */
  declaredRail?: DirectRail | null;
  /** What one selection covers, when an action confirms more than one thing —
   *  an entry reservation is one contribution for every pass on it. */
  appliesTo?: string | null;
  /** Unique per instance: a page can render several of these at once. */
  idPrefix: string;
  disabled?: boolean;
}

export default function TenderPicker({
  rails,
  value,
  onChange,
  reference,
  onReferenceChange,
  declaredRail = null,
  appliesTo = null,
  idPrefix,
  disabled = false,
}: TenderPickerProps) {
  const options = offlineTenderOptions(rails);
  // Shown for everything except cash: a cash handover has no memo to record.
  const showReference = value !== null && value !== "CASH";

  return (
    <div className="mt-2">
      {declaredRail && (
        <p className="text-[11px] text-gray-500">
          Contributor said: {TENDER_LABEL[RAIL_TENDER[declaredRail]]}
        </p>
      )}

      <div
        role="radiogroup"
        aria-label="How the money arrived"
        className="mt-1 flex flex-wrap gap-1.5"
      >
        {options.map((tender) => {
          const selected = value === tender;
          return (
            <button
              key={tender}
              type="button"
              role="radio"
              aria-checked={selected}
              id={`${idPrefix}-tender-${tender}`}
              disabled={disabled}
              onClick={() => onChange(tender)}
              className={`rounded-md border px-2 py-1 text-[11px] transition-colors disabled:opacity-40 ${
                selected
                  ? "border-green-700 bg-green-900/40 text-white"
                  : "border-gray-700 text-gray-300 hover:border-gray-600 hover:text-white"
              }`}
            >
              {TENDER_LABEL[tender]}
            </button>
          );
        })}
      </div>

      {showReference && (
        <input
          type="text"
          id={`${idPrefix}-tender-reference`}
          value={reference}
          maxLength={TENDER_REFERENCE_MAX}
          disabled={disabled}
          onChange={(e) => onReferenceChange(e.target.value)}
          placeholder={referencePlaceholder(value)}
          aria-label="Reference (optional)"
          className="mt-1.5 w-full rounded-md border border-gray-800 bg-gray-900 px-2 py-1 text-[11px] text-white placeholder:text-gray-600 outline-none focus:border-gray-600 transition-colors"
        />
      )}

      {appliesTo && (
        <p className="mt-1.5 text-[11px] text-gray-500">
          One method for {appliesTo}.
        </p>
      )}
    </div>
  );
}
