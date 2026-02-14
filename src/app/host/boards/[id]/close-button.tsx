"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function CloseBoardButton({ boardId }: { boardId: string }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [confirming, setConfirming] = useState(false);

  async function handleClose() {
    if (!confirming) {
      setConfirming(true);
      return;
    }

    setLoading(true);

    try {
      const res = await fetch(`/api/boards/${boardId}/close`, {
        method: "POST",
      });

      if (!res.ok) {
        const data = await res.json();
        alert(data.error || "Failed to close board");
        setLoading(false);
        setConfirming(false);
        return;
      }

      // Refresh the page to show closed state with numbers
      router.refresh();
    } catch {
      alert("Failed to close board");
      setLoading(false);
      setConfirming(false);
    }
  }

  return (
    <div className="flex items-center gap-3">
      {confirming && !loading && (
        <button
          onClick={() => setConfirming(false)}
          className="text-xs text-gray-500 hover:text-white transition-colors"
        >
          Cancel
        </button>
      )}
      <button
        onClick={handleClose}
        disabled={loading}
        className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
          confirming
            ? "bg-red-600 text-white hover:bg-red-500"
            : "bg-gray-800 text-gray-300 hover:bg-gray-700 border border-gray-700"
        } disabled:opacity-50 disabled:cursor-not-allowed`}
      >
        {loading
          ? "Closing…"
          : confirming
            ? "Confirm — close & randomize"
            : "Close Board"}
      </button>
    </div>
  );
}
