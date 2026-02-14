"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// Phase 1: default to halves for March Madness
// Future: surface a period type selector for CFB/NFL
const PERIOD_LABELS = ["H1", "Final"];
const DEFAULT_PAYOUTS: Record<string, number> = { H1: 50, Final: 50 };

export default function NewBoardForm() {
  const router = useRouter();
  const [gameName, setGameName] = useState("");
  const [teamCol, setTeamCol] = useState("");
  const [teamRow, setTeamRow] = useState("");
  const [squarePrice, setSquarePrice] = useState("");
  const [payouts, setPayouts] = useState(DEFAULT_PAYOUTS);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const payoutTotal = PERIOD_LABELS.reduce(
    (sum, label) => sum + (payouts[label] ?? 0),
    0
  );
  const payoutValid = Math.abs(payoutTotal - 100) <= 0.01;
  const priceNum = parseFloat(squarePrice);
  const formValid =
    gameName.trim().length > 0 &&
    teamCol.trim().length > 0 &&
    teamRow.trim().length > 0 &&
    priceNum >= 1 &&
    payoutValid;

  function updatePayout(label: string, value: string) {
    const num = parseFloat(value) || 0;
    setPayouts((prev) => ({ ...prev, [label]: num }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!formValid) return;

    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/boards", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          gameName: gameName.trim(),
          squarePrice: priceNum,
          teamRow: teamRow.trim(),
          teamCol: teamCol.trim(),
          periodType: "halves",
          payoutStructure: payouts,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Something went wrong");
        setLoading(false);
        return;
      }

      router.push(`/host/boards/${data.boardId}`);
    } catch {
      setError("Failed to create board");
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {/* Game Name */}
      <div>
        <label htmlFor="gameName" className="block text-sm text-gray-400 mb-1.5">
          Game
        </label>
        <input
          id="gameName"
          type="text"
          required
          value={gameName}
          onChange={(e) => setGameName(e.target.value)}
          placeholder="e.g. March Madness R1 — Duke vs Vermont"
          className="w-full rounded-lg border border-gray-800 bg-gray-900 px-3 py-2.5 text-sm text-white placeholder-gray-600 outline-none focus:border-gray-600 transition-colors"
        />
      </div>

      {/* Team Names */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor="teamCol" className="block text-sm text-gray-400 mb-1.5">
            Team across top
          </label>
          <input
            id="teamCol"
            type="text"
            required
            value={teamCol}
            onChange={(e) => setTeamCol(e.target.value)}
            placeholder="e.g. Duke"
            className="w-full rounded-lg border border-gray-800 bg-gray-900 px-3 py-2.5 text-sm text-white placeholder-gray-600 outline-none focus:border-gray-600 transition-colors"
          />
        </div>
        <div>
          <label htmlFor="teamRow" className="block text-sm text-gray-400 mb-1.5">
            Team down side
          </label>
          <input
            id="teamRow"
            type="text"
            required
            value={teamRow}
            onChange={(e) => setTeamRow(e.target.value)}
            placeholder="e.g. Vermont"
            className="w-full rounded-lg border border-gray-800 bg-gray-900 px-3 py-2.5 text-sm text-white placeholder-gray-600 outline-none focus:border-gray-600 transition-colors"
          />
        </div>
      </div>

      {/* Price per Square */}
      <div>
        <label
          htmlFor="squarePrice"
          className="block text-sm text-gray-400 mb-1.5"
        >
          Price per square
        </label>
        <div className="relative">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 text-sm">
            $
          </span>
          <input
            id="squarePrice"
            type="number"
            required
            min="1"
            step="1"
            value={squarePrice}
            onChange={(e) => setSquarePrice(e.target.value)}
            placeholder="10"
            className="w-full rounded-lg border border-gray-800 bg-gray-900 pl-7 pr-3 py-2.5 text-sm text-white placeholder-gray-600 outline-none focus:border-gray-600 transition-colors"
          />
        </div>
        {priceNum >= 1 && (
          <p className="text-xs text-gray-600 mt-1.5">
            100 squares × ${priceNum} = ${priceNum * 100} total pot
          </p>
        )}
      </div>

      {/* Payout Structure — dynamic from period labels */}
      <div>
        <label className="block text-sm text-gray-400 mb-1.5">
          Payout split
        </label>
        <div className={`grid gap-2`} style={{ gridTemplateColumns: `repeat(${PERIOD_LABELS.length}, 1fr)` }}>
          {PERIOD_LABELS.map((label) => (
            <div key={label}>
              <div className="text-xs text-gray-500 mb-1 text-center">
                {label}
              </div>
              <div className="relative">
                <input
                  type="number"
                  min="0"
                  max="100"
                  step="1"
                  value={payouts[label] || ""}
                  onChange={(e) => updatePayout(label, e.target.value)}
                  className="w-full rounded-lg border border-gray-800 bg-gray-900 px-2 py-2 text-sm text-white text-center outline-none focus:border-gray-600 transition-colors"
                />
                <span className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-600 text-xs">
                  %
                </span>
              </div>
            </div>
          ))}
        </div>
        <p
          className={`text-xs mt-1.5 ${
            payoutValid ? "text-gray-600" : "text-red-400"
          }`}
        >
          Total: {payoutTotal}%{!payoutValid && " — must equal 100%"}
        </p>
      </div>

      {/* Error */}
      {error && (
        <div className="rounded-lg border border-red-900/50 bg-red-950/30 p-3">
          <p className="text-sm text-red-300">{error}</p>
        </div>
      )}

      {/* Submit */}
      <button
        type="submit"
        disabled={!formValid || loading}
        className="w-full rounded-lg bg-white text-gray-950 py-2.5 text-sm font-medium hover:bg-gray-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        {loading ? "Creating…" : "Create Board"}
      </button>
    </form>
  );
}
