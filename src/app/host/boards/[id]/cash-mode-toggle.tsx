"use client";

import { useState } from "react";

interface CashModeToggleProps {
  boardId: string;
  initialEnabled: boolean;
  initialPin: string | null;
  liabilityAccepted: boolean;
}

export default function CashModeToggle({
  boardId,
  initialEnabled,
  initialPin,
  liabilityAccepted: initialLiability,
}: CashModeToggleProps) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [pin, setPin] = useState(initialPin ?? "");
  const [liability, setLiability] = useState(initialLiability);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [showSetup, setShowSetup] = useState(false);

  async function handleToggle() {
    // If turning ON and no liability accepted yet, show setup
    if (!enabled && !liability) {
      setShowSetup(true);
      return;
    }

    // If turning OFF
    if (enabled) {
      setLoading(true);
      setError("");
      try {
        const res = await fetch(`/api/host/boards/${boardId}/cash-mode`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: false }),
        });
        if (!res.ok) {
          const data = await res.json();
          setError(data.error || "Failed to disable cash mode.");
          setLoading(false);
          return;
        }
        setEnabled(false);
        setLoading(false);
      } catch {
        setError("Network error.");
        setLoading(false);
      }
      return;
    }

    // Turning ON with liability already accepted
    await enableCashMode();
  }

  async function enableCashMode() {
    const trimmedPin = pin.trim();
    if (!/^\d{4}$/.test(trimmedPin)) {
      setError("PIN must be exactly 4 digits.");
      return;
    }

    setLoading(true);
    setError("");

    try {
      const res = await fetch(`/api/host/boards/${boardId}/cash-mode`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true, pin: trimmedPin }),
      });

      if (!res.ok) {
        const data = await res.json();
        setError(data.error || "Failed to enable cash mode.");
        setLoading(false);
        return;
      }

      setEnabled(true);
      setLiability(true);
      setShowSetup(false);
      setLoading(false);
      // Reload to get updated board state
      window.location.reload();
    } catch {
      setError("Network error.");
      setLoading(false);
    }
  }

  // Setup flow — first time enabling
  if (showSetup && !enabled) {
    return (
      <div className="rounded-lg border border-gray-800 bg-gray-900 p-4 mb-6">
        <p className="text-sm font-medium mb-1">Enable Cash Mode</p>
        <p className="text-xs text-gray-500 mb-4">
          Players can reserve squares with cash. You collect payment in person
          and confirm on the dashboard. You&apos;re responsible for collecting
          cash — Daali doesn&apos;t process these payments.
        </p>

        <div className="mb-3">
          <label htmlFor="cashPin" className="block text-xs text-gray-400 mb-1">
            Set a 4-digit PIN
          </label>
          <input
            id="cashPin"
            type="text"
            inputMode="numeric"
            maxLength={4}
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
            placeholder="1234"
            className="w-24 rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-white text-center tracking-widest placeholder:text-gray-600 focus:outline-none focus:border-indigo-600 focus:ring-1 focus:ring-indigo-600"
          />
          <p className="text-[10px] text-gray-600 mt-1">
            Share this PIN with players paying cash.
          </p>
        </div>

        <label className="flex items-start gap-2 mb-4 cursor-pointer">
          <input
            type="checkbox"
            checked={liability}
            onChange={(e) => setLiability(e.target.checked)}
            className="mt-0.5 rounded border-gray-600 bg-gray-800 text-indigo-600 focus:ring-indigo-600"
          />
          <span className="text-xs text-gray-400">
            I understand I&apos;m responsible for collecting cash payments.
            Daali is not liable for uncollected cash.
          </span>
        </label>

        {error && <p className="text-xs text-red-400 mb-3">{error}</p>}

        <div className="flex gap-2">
          <button
            onClick={enableCashMode}
            disabled={loading || !liability || pin.length !== 4}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {loading ? "Enabling…" : "Enable Cash Mode"}
          </button>
          <button
            onClick={() => {
              setShowSetup(false);
              setError("");
            }}
            className="rounded-lg border border-gray-700 px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  // Normal toggle display
  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900 p-4 mb-6">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium">
            💵 Cash Mode{" "}
            <span className={enabled ? "text-green-400" : "text-gray-500"}>
              {enabled ? "On" : "Off"}
            </span>
          </p>
          {enabled && pin && (
            <p className="text-xs text-gray-500 mt-0.5">
              PIN: <span className="text-white font-mono tracking-wider">{pin}</span>
              {" "}— share with players paying cash
            </p>
          )}
        </div>
        <button
          onClick={handleToggle}
          disabled={loading}
          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
            enabled ? "bg-indigo-600" : "bg-gray-700"
          } ${loading ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}
        >
          <span
            className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
              enabled ? "translate-x-6" : "translate-x-1"
            }`}
          />
        </button>
      </div>
      {error && <p className="text-xs text-red-400 mt-2">{error}</p>}
    </div>
  );
}
