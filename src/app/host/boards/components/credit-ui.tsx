"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";

export function CreditBuyButton() {
  const [loading, setLoading] = useState(false);

  async function handleBuy() {
    setLoading(true);
    try {
      const res = await fetch("/api/credits/purchase", { method: "POST" });
      const data = await res.json();
      if (data.checkoutUrl) {
        window.location.href = data.checkoutUrl;
      } else {
        alert(data.error || "Something went wrong.");
      }
    } catch {
      alert("Something went wrong.");
    }
    setLoading(false);
  }

  return (
    <button
      onClick={handleBuy}
      disabled={loading}
      className="text-xs bg-indigo-600 hover:bg-indigo-500 text-white px-3 py-1.5 rounded-md font-medium transition-colors disabled:opacity-50"
    >
      {loading ? "Loading…" : "Buy Credit — $9"}
    </button>
  );
}

export function CreditPurchasedBanner() {
  const searchParams = useSearchParams();
  const purchased = searchParams.get("credit_purchased");

  if (purchased !== "true") return null;

  return (
    <div className="rounded-lg border border-green-900 bg-green-950/60 p-3 mb-6">
      <p className="text-sm text-green-300 font-medium">
        ✓ Board credit added! You can now create a new board.
      </p>
    </div>
  );
}
