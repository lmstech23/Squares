"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type PaymentMode = "stripe" | "cash" | null;

export default function PaymentSetupPage() {
  const router = useRouter();
  const [selected, setSelected] = useState<PaymentMode>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleContinue() {
    if (!selected) return;
    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/host/payment-preference", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: selected }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || "Something went wrong");
        setLoading(false);
        return;
      }

      if (selected === "stripe") {
        router.push("/host/stripe");
      } else {
        router.push("/host/boards");
      }
    } catch {
      setError("Something went wrong. Try again.");
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-[80vh] flex-col items-center justify-center px-4">
      <div className="w-full max-w-md">
        {/* Badge */}
        <div className="flex justify-center mb-6">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-indigo-500/30 bg-indigo-500/10 px-4 py-1.5 text-xs font-semibold uppercase tracking-wider text-indigo-400">
            ✦ Almost there
          </span>
        </div>

        {/* Heading */}
        <h1 className="text-center text-2xl font-bold tracking-tight text-white mb-2">
          How do you want to collect?
        </h1>
        <p className="text-center text-sm text-gray-400 mb-8">
          You can change this anytime.
        </p>

        {/* Options */}
        <div className="space-y-3 mb-6">
          {/* Credit &amp; Debit Cards */}
          <button
            type="button"
            onClick={() => setSelected("stripe")}
            className={`w-full rounded-xl border p-5 text-left transition-all ${
              selected === "stripe"
                ? "border-indigo-500 bg-indigo-500/5 ring-1 ring-indigo-500/50"
                : "border-gray-800 bg-gray-900/50 hover:border-gray-700"
            }`}
          >
            <div className="flex items-start justify-between">
              <div className="flex items-start gap-3">
                <div className="mt-0.5 flex h-10 w-10 items-center justify-center rounded-lg bg-gray-800">
                  <svg
                    className="h-5 w-5 text-gray-300"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={1.5}
                  >
                    <rect x="2" y="5" width="20" height="14" rx="2" />
                    <path d="M2 10h20" />
                  </svg>
                </div>
                <div>
                  <div className="font-semibold text-white">Credit &amp; Debit Cards</div>
                  <div className="text-sm text-gray-400">
                    Players pay online — money goes straight to your bank. No chasing.
                  </div>
                </div>
              </div>
              <div
                className={`mt-1 h-5 w-5 rounded-full border-2 flex items-center justify-center flex-shrink-0 transition-colors ${
                  selected === "stripe"
                    ? "border-indigo-500"
                    : "border-gray-600"
                }`}
              >
                {selected === "stripe" && (
                  <div className="h-2.5 w-2.5 rounded-full bg-indigo-500" />
                )}
              </div>
            </div>
            <ul className="mt-3 ml-[52px] space-y-1 text-sm text-gray-400">
              <li>• Money goes directly to your bank</li>
              <li>• Automatic — no chasing payments</li>
            </ul>
          </button>

          {/* Direct Payments */}
          <button
            type="button"
            onClick={() => setSelected("cash")}
            className={`w-full rounded-xl border p-5 text-left transition-all ${
              selected === "cash"
                ? "border-indigo-500 bg-indigo-500/5 ring-1 ring-indigo-500/50"
                : "border-gray-800 bg-gray-900/50 hover:border-gray-700"
            }`}
          >
            <div className="flex items-start justify-between">
              <div className="flex items-start gap-3">
                <div className="mt-0.5 flex h-10 w-10 items-center justify-center rounded-lg bg-gray-800">
                  <svg
                    className="h-5 w-5 text-gray-300"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={1.5}
                  >
                    <circle cx="12" cy="12" r="9" />
                    <path d="M12 7v10M9 9.5c0-.828 1.343-1.5 3-1.5s3 .672 3 1.5-1.343 1.5-3 1.5-3 .672-3 1.5 1.343 1.5 3 1.5 3-.672 3-1.5" />
                  </svg>
                </div>
                <div>
                  <div className="font-semibold text-white">Direct Payments</div>
                  <div className="text-sm text-gray-400">
                    Collect from players your way.
                  </div>
                </div>
              </div>
              <div
                className={`mt-1 h-5 w-5 rounded-full border-2 flex items-center justify-center flex-shrink-0 transition-colors ${
                  selected === "cash"
                    ? "border-indigo-500"
                    : "border-gray-600"
                }`}
              >
                {selected === "cash" && (
                  <div className="h-2.5 w-2.5 rounded-full bg-indigo-500" />
                )}
              </div>
            </div>
            <ul className="mt-3 ml-[52px] space-y-1 text-sm text-gray-400">
              <li>• Cash, Venmo, Zelle, or CashApp</li>
              <li>• You mark players as paid</li>
              <li>• Add Stripe for Credit &amp; Debit Cards anytime</li>
            </ul>
          </button>
        </div>

        {/* Error */}
        {error && (
          <div className="mb-4 rounded-lg border border-red-900/50 bg-red-950/30 p-3">
            <p className="text-sm text-red-300">{error}</p>
          </div>
        )}

        {/* Continue button */}
        <button
          onClick={handleContinue}
          disabled={!selected || loading}
          className={`w-full rounded-xl py-3.5 text-sm font-semibold transition-all ${
            selected
              ? "bg-indigo-600 text-white hover:bg-indigo-500 active:bg-indigo-700"
              : "bg-gray-800 text-gray-500 cursor-not-allowed"
          }`}
        >
          {loading
            ? "Setting up\u2026"
            : selected
              ? selected === "stripe"
                ? "Continue to Stripe setup"
                : "Continue to dashboard"
              : "Choose an option to continue"}
        </button>

        {/* Footer note */}
        <p className="mt-4 text-center text-xs text-gray-500">
          This only affects how players pay you. Board credits are separate.
        </p>
      </div>
    </div>
  );
}
