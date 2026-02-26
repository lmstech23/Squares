"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function DismissButton({ boardId }: { boardId: string }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function handleDismiss() {
    setLoading(true);
    try {
      const res = await fetch(`/api/boards/${boardId}/dismiss`, {
        method: "PATCH",
      });
      if (res.ok) {
        router.refresh();
      }
    } catch {
      // silent — non-critical action
    } finally {
      setLoading(false);
    }
  }

  return (
    <button
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        handleDismiss();
      }}
      disabled={loading}
      className="text-xs text-gray-600 hover:text-red-400 transition-colors disabled:opacity-50"
      title="Remove from dashboard"
    >
      {loading ? "\u2026" : "Dismiss"}
    </button>
  );
}
