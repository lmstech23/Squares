"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

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
  const router = useRouter();
  const [enabled, setEnabled] = useState(initialEnabled);
  const [pin, setPin] = useState(initialPin ?? "");
  const [editing, setEditing] = useState(false);
  const [showLiability, setShowLiability] = useState(false);
  const [liabilityAccepted, setLiabilityAccepted] = useState(initialLiability);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleEnable() {
    if (!/^\d{4}$/.test(pin)) {
      setError("PIN must be exactly 4 digits");
      return;
    }

    if (!liabilityAccepted) {
      setShowLiability(true);
      return;
    }

    await toggleCashMode(true);
  }

  async function handleAcceptLiability() {
    await toggleCashMode(true, true);
  }

  async function toggleCashMode(enable: boolean, acceptLiability = false) {
    setLoading(true);
    setError("");

    try {
      const body: Record<string, unknown> = { enabled: enable };
      if (enable) body.pin = pin;
      if (acceptLiability) body.liabilityAccepted = true;

      const res = await fetch(`/api/host/boards/${boardId}/cash-mode`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Failed to update");
        setLoading(false);
        return;
      }

      setEnabled(enable);
      setEditing(false);
      setShowLiability(false);
      if (acceptLiability) setLiabilityAccepted(true);
      router.refresh();
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900 p-4 mb-6">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium flex items-center gap-2">
            💵 Cash Mode
            {enabled && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-green-950 text-green-400 border border-green-900">
                ON
              </span>
            )}
          </p>
          <p className="text-xs text-gray-500 mt-0.5">
            {enabled
              ? `PIN: ${pin} — share with players paying cash`
              : "Allow players to reserve squares with cash"}
          </p>
        </div>

        {!editing && !showLiability && (
          <button
            onClick={() => (enabled ? toggleCashMode(false) : setEditing(true))}
            disabled={loading}
            className={`text-xs px-3 py-1.5 rounded-lg font-medium transition-colors ${
              enabled
                ? "border border-gray-700 text-gray-400 hover:text-white hover:border-gray-600"
                : "bg-indigo-600 text-white hover:bg-indigo-500"
            } disabled:opacity-50`}
          >
            {loading ? "…" : enabled ? "Disable" : "Enable"}
          </button>
        )}
      </div>

      {/* PIN entry */}
      {editing && !showLiability && (
        <div className="mt-3 flex items-center gap-2">
          <input
            type="text"
            inputMode="numeric"
            maxLength={4}
            value={pin}
            onChange={(e) => {
              setPin(e.target.value.replace(/\D/g, "").slice(0, 4));
              setError("");
            }}
            placeholder="4-digit PIN"
            className="w-24 rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-white text-center tracking-widest placeholder:text-gray-600 focus:outline-none focus:border-indigo-600"
            autoFocus
          />
          <button
            onClick={handleEnable}
            disabled={loading || pin.length !== 4}
            className="text-xs px-3 py-2 rounded-lg bg-indigo-600 text-white font-medium hover:bg-indigo-500 disabled:opacity-50 transition-colors"
          >
            {loading ? "…" : "Save & Enable"}
          </button>
          <button
            onClick={() => { setEditing(false); setError(""); }}
            className="text-xs px-2 py-2 text-gray-500 hover:text-white transition-colors"
          >
            Cancel
          </button>
        </div>
      )}

      {/* Liability acceptance */}
      {showLiability && (
        <div className="mt-3 rounded-lg border border-yellow-900/50 bg-yellow-950/30 p-3">
          <p className="text-xs text-yellow-300 font-medium mb-1">
            Cash Payment Responsibility
          </p>
          <p className="text-xs text-gray-400 mb-3">
            You are responsible for collecting and managing all cash payments.
            Squares reserves squares on your behalf but does not handle cash
            transactions.
          </p>
          <div className="flex gap-2">
            <button
              onClick={handleAcceptLiability}
              disabled={loading}
              className="text-xs px-3 py-2 rounded-lg bg-green-700 text-white font-medium hover:bg-green-600 disabled:opacity-50 transition-colors"
            >
              {loading ? "…" : "I Accept — Enable Cash Mode"}
            </button>
            <button
              onClick={() => { setShowLiability(false); setError(""); }}
              className="text-xs px-2 py-2 text-gray-500 hover:text-white transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {error && <p className="text-xs text-red-400 mt-2">{error}</p>}
    </div>
  );
}
