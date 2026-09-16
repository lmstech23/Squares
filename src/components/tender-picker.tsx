"use client";

import type { DirectRail } from "@/lib/accepted-payments";
import {
  RAIL_TENDER,
  TENDER_LABEL,
  TENDER_REFERENCE_MAX,
  offlineTenderOptions,
  referencePlaceholder,
  TENDER_PLACEHOLDER_LABEL,
  type OfflineTender,
} from "@/lib/tender";

// THE ONE TENDER PICKER, used by all four confirm paths — payment-method
// addendum v1.2.10 §4. Four copies would drift, and the one that drifts is
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
//
// TWO PRESENTATIONS, ONE PICKER — §4, §5.
//
//   radio    the confirm paths. She has already stopped to confirm a payment,
//            the options deserve to be visible at a glance, and the reference
//            field needs somewhere to live.
//   compact  the ledger's correction cell. A native <select>: one line, and on
//            a phone it opens the platform's own wheel. The radio stack ran
//            taller than three donor rows and pushed the ledger down the page,
//            which is the wrong trade for fixing a row in a backlog.
//
// ONLY PRESENTATION DIFFERS. Same options, same CARD exclusion, same route
// behind it. A second component is how those three quietly stop matching.
//
// THE REFERENCE FIELD IS RADIO-ONLY, AND THAT IS A UI JUDGEMENT, NOT A
// CAPABILITY CHANGE. Correcting a September row is recall — "it was Cash App" —
// not transcription; there is no check in her hand to read a number off. The
// column, the route, the audit log and the detail reveal all still carry
// `tender_reference`, existing references still display, and the confirm paths
// still collect one. The compact variant simply does not ask. The prop is not
// merely ignored there: the type does not accept it.

interface TenderPickerBase {
  /** The board's configured rails, resolved live at render by the server
   *  component that owns the board row. Cash, Check and Other are always
   *  offered, so an unconfigured board still has three answers. */
  rails: readonly DirectRail[];
  value: OfflineTender | null;
  onChange: (tender: OfflineTender) => void;
  /** Unique per instance: a page can render several of these at once. */
  idPrefix: string;
  disabled?: boolean;
}

interface TenderPickerRadioProps extends TenderPickerBase {
  variant?: "radio";
  reference: string;
  onReferenceChange: (reference: string) => void;
  /** Context only: "Contributor said: Zelle". Never preselects. */
  declaredRail?: DirectRail | null;
  /** What one selection covers, when an action confirms more than one thing —
   *  an entry reservation is one contribution for every pass on it. */
  appliesTo?: string | null;
}

interface TenderPickerCompactProps extends TenderPickerBase {
  variant: "compact";
}

export type TenderPickerProps =
  | TenderPickerRadioProps
  | TenderPickerCompactProps;

export default function TenderPicker(props: TenderPickerProps) {
  const { rails, value, onChange, idPrefix, disabled = false } = props;
  const configured = offlineTenderOptions(rails);

  // THE ROW'S OWN VALUE IS NOT AN OFFER, BUT IT MUST STILL SHOW. A tender
  // recorded before this rule, or on a rail the board has since dropped, is
  // not in `configured` - and a <select> whose value matches no option renders
  // as the wrong one. It is prepended so the control states the truth about
  // the row it sits on; it is not thereby offered to any other row.
  const options =
    value && !configured.includes(value) ? [value, ...configured] : configured;

  if (props.variant === "compact") {
    // NOTHING CONFIGURED, NOTHING TO OFFER. A board with no rails set up has
    // no methods, and a select holding only a placeholder is a dead control.
    if (options.length === 0) return null;
    return (
      <select
        id={`${idPrefix}-tender`}
        value={value ?? ""}
        disabled={disabled}
        aria-label="How the money arrived"
        onChange={(e) => {
          const next = e.target.value;
          // The placeholder is `disabled` below and cannot be chosen, but the
          // guard is here rather than assumed: an empty value is not a tender
          // and must never reach the route.
          if (next) onChange(next as OfflineTender);
        }}
        className="w-full max-w-[13rem] rounded-md border border-gray-700 bg-gray-900 px-2 py-1 text-[11px] text-white outline-none transition-colors focus:border-gray-500 disabled:opacity-40"
      >
        {/* NEUTRAL ON PURPOSE. The cell's own label already says what
            choosing does, and it sits directly above this; repeating it made
            an open row show the same sentence twice. */}
        {value === null && (
          <option value="" disabled>
            {TENDER_PLACEHOLDER_LABEL}
          </option>
        )}
        {options.map((tender) => (
          <option key={tender} value={tender}>
            {TENDER_LABEL[tender]}
          </option>
        ))}
      </select>
    );
  }

  const {
    reference,
    onReferenceChange,
    declaredRail = null,
    appliesTo = null,
  } = props;
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
