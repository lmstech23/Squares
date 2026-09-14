"use client";

import { useState } from "react";
import TenderPicker from "@/components/tender-picker";
import { TENDER_REQUIRED_ERROR, type OfflineTender } from "@/lib/tender";
import type { DirectRail } from "@/lib/accepted-payments";

// The confirm-with-a-tender interaction, shared by the three host surfaces that
// confirm money already sitting in the ledger or on a square — payment-method
// addendum v1.2.6 §4. The fourth path, Record donation, is a form and embeds
// TenderPicker directly.
//
// ONE PICKER, ONE PLACE. The button opens it; nothing is submitted until a
// method is chosen, because there is no default and the server refuses a
// missing tender anyway.

export interface ConfirmWithTenderProps {
  rails: readonly DirectRail[];
  /** Context only — what the contributor said they would send. */
  declaredRail?: DirectRail | null;
  /** What one selection covers, when the action resolves more than one thing. */
  appliesTo?: string | null;
  idPrefix: string;
  /** Closed-state button. */
  label: string;
  /** Open-state confirm button. */
  confirmLabel: string;
  pendingLabel?: string;
  /** Shown above the picker when the action deserves a sentence of its own. */
  prompt?: string | null;
  busy?: boolean;
  disabled?: boolean;
  className?: string;
  confirmClassName?: string;
  onConfirm: (tender: OfflineTender, reference: string | null) => void | Promise<void>;
}

export default function ConfirmWithTender({
  rails,
  declaredRail = null,
  appliesTo = null,
  idPrefix,
  label,
  confirmLabel,
  pendingLabel,
  prompt = null,
  busy = false,
  disabled = false,
  className = "rounded-md bg-green-800 px-2 py-1 text-xs font-medium text-white hover:bg-green-700 disabled:opacity-50 transition-colors",
  confirmClassName = "rounded-md bg-green-800 px-2 py-1 text-xs font-medium text-white hover:bg-green-700 disabled:opacity-50 transition-colors",
  onConfirm,
}: ConfirmWithTenderProps) {
  const [open, setOpen] = useState(false);
  const [tender, setTender] = useState<OfflineTender | null>(null);
  const [reference, setReference] = useState("");
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return (
      <button
        type="button"
        disabled={disabled || busy}
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
        className={className}
      >
        {busy && pendingLabel ? pendingLabel : label}
      </button>
    );
  }

  return (
    <div className="mt-1 w-full rounded-lg border border-gray-800 bg-gray-950 p-2.5">
      {prompt && <p className="text-xs text-gray-300">{prompt}</p>}

      <TenderPicker
        rails={rails}
        value={tender}
        onChange={(t) => {
          setTender(t);
          setError(null);
        }}
        reference={reference}
        onReferenceChange={setReference}
        declaredRail={declaredRail}
        appliesTo={appliesTo}
        idPrefix={idPrefix}
        disabled={busy}
      />

      {error && <p className="mt-1.5 text-[11px] text-red-400">{error}</p>}

      <div className="mt-2 flex gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={async () => {
            if (!tender) {
              setError(TENDER_REQUIRED_ERROR);
              return;
            }
            await onConfirm(tender, reference.trim() || null);
          }}
          className={confirmClassName}
        >
          {busy && pendingLabel ? pendingLabel : confirmLabel}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setOpen(false);
            setTender(null);
            setReference("");
            setError(null);
          }}
          className="rounded-md border border-gray-700 px-2 py-1 text-xs text-gray-300 hover:border-gray-500 disabled:opacity-50 transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
