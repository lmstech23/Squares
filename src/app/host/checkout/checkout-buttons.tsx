"use client";

import { useState } from "react";

interface Props {
  boardId: string;
}

export default function CheckoutButtons({ boardId }: Props) {
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handlePurchase(pack: "single" | "triple") {
    setLoading(pack);
    setError(null);

    try {
      const res = await fetch("/api/credits/purchase", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ boardId, pack }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Something went wrong");
        setLoading(null);
        return;
      }

      if (data.checkoutUrl) {
        window.location.href = data.checkoutUrl;
      } else {
        setError("Missing checkout URL");
        setLoading(null);
      }
    } catch {
      setError("Failed to start checkout");
      setLoading(null);
    }
  }

  return (
    <div>
      <div className="space-y-3">
        <button
          onClick={() => handlePurchase("single")}
          disabled={loading !== null}
          className="w-full rounded-lg bg-green-600 text-white py-3 text-sm font-medium hover:bg-green-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {loading === "single" ? "Redirecting to Stripe\u2026" : "1 Board \u2014 $9"}
        </button>

        <button
          onClick={() => handlePurchase("triple")}
          disabled={loading !== null}
          className="w-full rounded-lg bg-purple-600 text-white py-3 text-sm font-medium hover:bg-purple-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {loading === "triple" ? "Redirecting to Stripe\u2026" : "3 Boards \u2014 $24"}
        </button>
      </div>

      <p className="text-xs text-gray-600 text-center mt-3">
        1 credit activates this board. Extra credits are saved for future boards.
      </p>

      {error && (
        <div className="rounded-lg border border-red-900/50 bg-red-950/30 p-3 mt-4">
          <p className="text-sm text-red-300">{error}</p>
        </div>
      )}
    </div>
  );
}
