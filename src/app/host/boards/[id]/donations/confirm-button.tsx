"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// "Mark received" for a cash donation a CONTRIBUTOR declared from the board.
//
// The host-recorded path writes `confirmed` in one action because the money is
// already in her hand. This one exists because the contributor declared it
// first, so there is a pending row waiting for the transfer to land.
//
// Nothing here can reach a card contribution or a cash square: the API scopes
// its conditional update to pending + cash + donation-only, and a 409 comes
// back if the row is anything else.

export default function ConfirmButton({
  boardId,
  contributionId,
}: {
  boardId: string;
  contributionId: string;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setError(null);
    setLoading(true);
    try {
      const res = await fetch(`/api/host/boards/${boardId}/cash-donation`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contributionId }),
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
      <button
        type="button"
        onClick={confirm}
        disabled={loading}
        className="rounded border border-gray-700 px-2 py-1 text-[11px] text-gray-300 hover:text-white hover:border-gray-600 disabled:opacity-40 transition-colors"
      >
        {loading ? "Marking…" : "Mark received"}
      </button>
      {error && <span className="text-[10px] text-red-400">{error}</span>}
    </span>
  );
}
