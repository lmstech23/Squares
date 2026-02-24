"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";

export function CreditBuyButton({ boardId }: { boardId?: string }) {
  const [loading, setLoading] = useState<string | null>(null);

  async function handleBuy(pack: string) {
    setLoading(pack);
    try {
      const res = await fetch("/api/host/credits/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pack, ...(boardId ? { boardId } : {}) }),
      });
      const data = await res.json();
      if (data.checkoutUrl) {
        window.location.href = data.checkoutUrl;
      } else {
        alert(data.error || "Something went wrong.");
      }
    } catch {
      alert("Something went wrong.");
    }
    setLoading(null);
  }

  return (
    <div className="flex gap-2">
      <button
        onClick={() => handleBuy("1")}
        disabled={loading !== null}
        className="text-xs bg-indigo-600 hover:bg-indigo-500 text-white px-3 py-1.5 rounded-md font-medium transition-colors disabled:opacity-50"
      >
        {loading === "1" ? "Loading…" : "1 Board — $9"}
      </button>
      <button
        onClick={() => handleBuy("3")}
        disabled={loading !== null}
        className="text-xs bg-indigo-600 hover:bg-indigo-500 text-white px-3 py-1.5 rounded-md font-medium transition-colors disabled:opacity-50"
      >
        {loading === "3" ? "Loading…" : "3 Boards — $24"}
      </button>
    </div>
  );
}

export function CreditPurchasedBanner() {
  const searchParams = useSearchParams();
  const purchase = searchParams.get("purchase");

  if (purchase !== "success") return null;

  return (
    <div className="rounded-lg border border-green-900 bg-green-950/60 p-3 mb-6">
      <p className="text-sm text-green-300 font-medium">
        ✓ Board credits added! You can now create a new board.
      </p>
    </div>
  );
}
