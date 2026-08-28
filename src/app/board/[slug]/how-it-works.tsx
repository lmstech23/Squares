"use client";

import { useState } from "react";

// Contributor board panel — fundraiser-board-v2.md §6C.
//
// Replaces the Game Day "Payment & Payouts" panel, which is an instruction
// manual for a different product: Stripe explanations, PIN explanations, and
// an "If you win" section on a board that has no prize.
//
// Prize language is gated on `hasPrize` — that is prizePoolPercent > 0, never
// board type. A Phase B fundraiser WITH prizes needs the drawing block back,
// and gating on type would deny it.
//
// Handles are revealed on demand rather than listed. A permanent wall of
// payment handles is clutter for the card majority, and it puts the host's
// personal contact details on a public page for no reason.

interface Props {
  hasEvent: boolean;
  hasPrize: boolean;
  handles: {
    venmo: string | null;
    zelle: string | null;
    cashapp: string | null;
    paypal: string | null;
  };
}

const heading =
  "text-[10px] font-medium text-gray-500 uppercase tracking-wider";

export default function HowItWorks({ hasEvent, hasPrize, handles }: Props) {
  const [showOther, setShowOther] = useState(false);

  const listed = [
    { label: "Zelle", value: handles.zelle },
    { label: "Cash App", value: handles.cashapp },
    { label: "Venmo", value: handles.venmo },
    { label: "PayPal", value: handles.paypal },
  ].filter((h) => h.value);

  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900 p-4 space-y-5">
      <div>
        <p className={heading}>How it works</p>
        {hasEvent ? (
          <>
            <p className="text-sm mt-2 font-medium">Each square = 1 ticket</p>
            <p className="text-sm text-gray-400 mt-1 leading-relaxed">
              Choose one or more available squares. Once your contribution is
              confirmed, your ticket(s) will be emailed to you.
            </p>
          </>
        ) : (
          <p className="text-sm text-gray-400 mt-2 leading-relaxed">
            Choose one or more available squares. Once your contribution is
            confirmed, you&apos;ll get a receipt by email.
          </p>
        )}
      </div>

      {/* Only when the host configured a prize. Absent, not softened. */}
      {hasPrize && (
        <div>
          <p className={heading}>Prize drawing</p>
          <p className="text-sm text-gray-400 mt-2 leading-relaxed">
            Each paid square gives you one entry in the drawing.
            {hasEvent
              ? " Drawing details will be included with your ticket."
              : " Drawing details will be included with your receipt."}
          </p>
        </div>
      )}

      <div>
        <p className={heading}>Payment options</p>
        <div className="grid grid-cols-2 gap-2 mt-2">
          <div className="rounded-lg border border-gray-800 bg-gray-950 px-3 py-2.5 text-sm text-center">
            Credit Card
          </div>
          <button
            type="button"
            onClick={() => setShowOther((v) => !v)}
            className={`rounded-lg border px-3 py-2.5 text-sm text-center transition-colors ${
              showOther
                ? "border-gray-700 bg-gray-950 text-white"
                : "border-gray-800 bg-gray-950 text-gray-400 hover:border-gray-700"
            }`}
          >
            Other Payment Options
          </button>
        </div>

        {showOther && (
          <ul className="mt-3 space-y-1 text-sm">
            {listed.map((h) => (
              <li key={h.label}>
                <span className="text-gray-500">{h.label}</span> {h.value}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
