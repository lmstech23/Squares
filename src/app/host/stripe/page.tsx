"use client";

import Link from "next/link";
import { useState } from "react";
import { useSearchParams } from "next/navigation";

export default function StripePage() {
  const searchParams = useSearchParams();
  const isRefresh = searchParams.get("refresh") === "true";
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleConnect() {
    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/stripe/connect", { method: "POST" });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Something went wrong");
        setLoading(false);
        return;
      }

      // Redirect to Stripe onboarding
      window.location.href = data.url;
    } catch {
      setError("Failed to connect to Stripe");
      setLoading(false);
    }
  }

  return (
    <div className="max-w-md mx-auto py-12">
      <h1 className="text-xl font-bold mb-2">Connect Stripe</h1>
      <p className="text-sm text-gray-500 mb-8">
        {isRefresh
          ? "Your onboarding link expired. Click below to pick up where you left off."
          : "Players pay you directly through Stripe. This takes a few minutes — Stripe handles it."}
      </p>

      {error && (
        <div className="rounded-lg border border-red-900/50 bg-red-950/30 p-3 mb-4">
          <p className="text-sm text-red-300">{error}</p>
        </div>
      )}

      <button
        onClick={handleConnect}
        disabled={loading}
        className="w-full rounded-lg bg-indigo-600 text-white py-3 text-sm font-medium hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        {loading
          ? "Setting up…"
          : isRefresh
            ? "Resume Stripe setup"
            : "Connect with Stripe"}
      </button>

      <p className="text-xs text-gray-600 mt-4 text-center">
        You&apos;ll be redirected to Stripe to complete setup, then brought back
        here.
      </p>

      {/* The only way off this page other than completing Stripe onboarding.
          Without it a host who opened Connect setup and changed her mind has
          nothing but the browser Back button — which on mobile is a gesture
          some people do not know, and in an in-app browser may not exist. */}
      <Link
        href="/host/boards"
        className="mt-4 block text-center text-sm text-gray-500 hover:text-gray-300 transition-colors"
      >
        Back to boards
      </Link>
    </div>
  );
}
