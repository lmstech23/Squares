"use client";

import { useState } from "react";
import PassRow from "./pass-row";
import { ADMISSION } from "@/lib/board-vocabulary";

// ONE PASS IN THE DOM AT A TIME — admission addendum §7.
//
// Stacked QR codes on one phone screen let a gate scanner pick up a
// NEIGHBOURING code instead of the one being presented. A pass is consumed
// with nobody walking through, and the next person in that family is told
// "already checked in". §7 names misscans as the most common gate error and
// says the counter drifts until the host stops trusting it; a vertical stack
// produces them systematically on any multi-pass family.
//
// THE OTHER PASSES ARE ABSENT, NOT HIDDEN. This renders a single PassRow and
// nothing else — no `display:none`, no off-screen container, no zero-opacity
// sibling. A camera cannot read what is not in the document, and CSS hiding
// would leave the codes present for a scanner that ignores layout.
//
// No carousel library, no modal, no swipe gestures. Two buttons and an index.

interface Pass {
  token: string;
  used: boolean;
  label: string | null;
}

export default function PassViewer({ passes }: { passes: Pass[] }) {
  // OPEN ON THE FIRST UNUSED PASS. A family checking in over several minutes
  // comes back to this page repeatedly; making them tap past the ones already
  // consumed is the same friction in a slower form. All used — everyone is
  // in — falls back to the first.
  const firstUnused = passes.findIndex((p) => !p.used);
  const [index, setIndex] = useState(firstUnused === -1 ? 0 : firstUnused);

  const total = passes.length;
  const clamped = Math.min(Math.max(index, 0), total - 1);
  const pass = passes[clamped];
  const remaining = passes.filter((p) => !p.used).length;

  return (
    <div className="mt-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-gray-400">
          {ADMISSION.One} {clamped + 1} of {total}
        </p>
        {remaining !== total && (
          <p className="text-xs text-gray-500">
            {remaining} of {total} left
          </p>
        )}
      </div>

      <div className="mt-2">
        <PassRow
          // Keyed on the token so React swaps the whole subtree rather than
          // reusing the <img> — a reused element can briefly show the previous
          // QR while the new one loads, which at a gate is the exact failure
          // this component exists to prevent.
          key={pass.token}
          token={pass.token}
          ordinal={clamped + 1}
          total={total}
          used={pass.used}
          label={pass.label}
        />
      </div>

      {total > 1 && (
        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            onClick={() => setIndex(clamped - 1)}
            disabled={clamped === 0}
            className="flex-1 rounded-lg border border-gray-700 px-4 py-3 text-sm font-medium text-gray-200 hover:border-gray-600 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            Previous
          </button>
          <button
            type="button"
            onClick={() => setIndex(clamped + 1)}
            disabled={clamped === total - 1}
            className="flex-1 rounded-lg border border-gray-700 px-4 py-3 text-sm font-medium text-gray-200 hover:border-gray-600 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            Next
          </button>
        </div>
      )}

      {total > 1 && (
        <p className="mt-3 text-xs text-gray-600 leading-relaxed">
          One at a time, so the scanner reads the right one. Tap Next for the
          next person.
        </p>
      )}
    </div>
  );
}
