"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import ConfirmWithTender from "@/components/confirm-with-tender";
import type { DirectRail } from "@/lib/accepted-payments";

// "Mark received" for a cash donation a CONTRIBUTOR declared from the board.
//
// The host-recorded path writes `confirmed` in one action because the money is
// already in her hand. This one exists because the contributor declared it
// first, so there is a pending row waiting for the transfer to land.
//
// Nothing here can reach a card contribution or a cash square: the API scopes
// its conditional update to pending + OFFLINE + donation-only, and a 409 comes
// back if the row is anything else.
//
// THE DECLARED RAIL IS SHOWN, NEVER SELECTED — payment-method addendum §2, §4.
// It is what the contributor said on Tuesday; the tender is what the host had
// on Saturday, and a parent who declared Zelle and handed over two twenties is
// an ordinary evening. The disagreement is the information.

export default function ConfirmButton({
  boardId,
  contributionId,
  rails,
  declaredRail = null,
}: {
  boardId: string;
  contributionId: string;
  /// Configured rails, resolved live at render by the page — §4.
  rails: DirectRail[];
  declaredRail?: DirectRail | null;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm(tender: string) {
    setError(null);
    setLoading(true);
    try {
      const res = await fetch(`/api/host/boards/${boardId}/cash-donation`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contributionId, tender }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Something went wrong.");
        setLoading(false);
        return;
      }
      router.refresh();
    } catch {
      setError("Something went wrong.");
      setLoading(false);
    }
  }

  return (
    <span className="inline-flex flex-col items-start gap-1">
      <ConfirmWithTender
        rails={rails}
        declaredRail={declaredRail}
        idPrefix={`cd-${contributionId}`}
        label="Mark received"
        confirmLabel="Mark received"
        pendingLabel="Marking…"
        busy={loading}
        className="rounded border border-gray-700 px-2 py-1 text-[11px] text-gray-300 hover:text-white hover:border-gray-600 disabled:opacity-40 transition-colors"
        confirmClassName="rounded border border-gray-700 px-2 py-1 text-[11px] text-gray-300 hover:text-white hover:border-gray-600 disabled:opacity-40 transition-colors"
        onConfirm={confirm}
      />
      {error && <span className="text-[10px] text-red-400">{error}</span>}
    </span>
  );
}
