"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

const PERIOD_LABELS = ["H1", "Final"];
const DEFAULT_PAYOUTS: Record<string, number> = { H1: 50, Final: 50 };

export default function NewBoardForm() {
  const router = useRouter();
  const [gameName, setGameName] = useState("");
  const [teamCol, setTeamCol] = useState("");
  const [teamRow, setTeamRow] = useState("");
  const [squarePrice, setSquarePrice] = useState("");
  const [hostCut, setHostCut] = useState("0");
  const [payouts, setPayouts] = useState(DEFAULT_PAYOUTS);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Payout coordination fields
  const [hostVenmo, setHostVenmo] = useState("");
  const [hostZelle, setHostZelle] = useState("");
  const [hostCashapp, setHostCashapp] = useState("");
  const hasPaymentHandle = hostVenmo.trim() || hostZelle.trim() || hostCashapp.trim();
  const [payoutVisibility, setPayoutVisibility] = useState<"public" | "pin_gated">("public");
  const [requirePlayerPayout, setRequirePlayerPayout] = useState(false);
  const [showPayoutSection, setShowPayoutSection] = useState(false);

  const payoutTotal = PERIOD_LABELS.reduce(
    (sum, label) => sum + (payouts[label] ?? 0),
    0
  );
  const payoutValid = payoutTotal === 100;

  const priceNum = parseFloat(squarePrice) || 0;
  const priceInCents = Math.round(priceNum * 100);
  const priceValid = !isNaN(priceNum) && priceNum >= 1;
  const totalPot = priceValid ? Math.round(priceNum * 100 * 100) : 0;

  const hostCutNum = parseInt(hostCut, 10);
  const hostCutValid = !isNaN(hostCutNum) && hostCutNum >= 0 && hostCutNum <= 50;
  const playerPool = hostCutValid ? Math.round(totalPot * (1 - hostCutNum / 100)) : 0;

  function updatePayout(label: string, value: string) {
    const num = parseInt(value, 10);
    setPayouts((p) => ({ ...p, [label]: isNaN(num) ? 0 : num }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!gameName.trim() || !teamCol.trim() || !teamRow.trim()) {
      setError("Game name and both team names are required.");
      return;
    }
    if (!priceValid) {
      setError("Price must be at least $1.");
      return;
    }
    if (!hostCutValid) {
      setError("Host cut must be 0–50%.");
      return;
    }
    if (!payoutValid) {
      setError("Payout percentages must total 100%.");
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/boards", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          gameName: gameName.trim(),
          teamCol: teamCol.trim(),
          teamRow: teamRow.trim(),
          squarePrice: priceInCents,
          hostCutPercent: hostCutNum,
          payoutStructure: payouts,
          // Payout coordination
          hostVenmo: hostVenmo.trim() || null,
          hostZelle: hostZelle.trim() || null,
          hostCashapp: hostCashapp.trim() || null,
          payoutVisibility,
          requirePlayerPayout,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (res.status === 402 && data.redirectTo) {
            router.push(data.redirectTo);
            return;
          }
          setError(data.error || "Failed to create board.");
          setLoading(false);
          return;
      }
      router.push(`/host/boards/${data.boardId}`);
    } catch {
      setError("Network error. Please try again.");
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {error && (
        <div className="rounded-lg border border-red-900/50 bg-red-950/30 p-3">
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}

      {/* Game Name */}
      <div>
        <label htmlFor="gameName" className="block text-sm text-gray-400 mb-1.5">
          Game
        </label>
        <input
          id="gameName"
          type="text"
          value={gameName}
          onChange={(e) => setGameName(e.target.value)}
          placeholder="March Madness — Duke vs. Vermont"
          className="w-full rounded-lg border border-gray-800 bg-gray-900 px-3 py-2.5 text-sm text-white placeholder:text-gray-600 outline-none focus:border-gray-600 transition-colors"
        />
      </div>

      {/* Team Names */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor="teamCol" className="block text-sm text-gray-400 mb-1.5">
            Team A
          </label>
          <input
            id="teamCol"
            type="text"
            value={teamCol}
            onChange={(e) => setTeamCol(e.target.value)}
            placeholder="Duke"
            className="w-full rounded-lg border border-gray-800 bg-gray-900 px-3 py-2.5 text-sm text-white placeholder:text-gray-600 outline-none focus:border-gray-600 transition-colors"
          />
        </div>
        <div>
          <label htmlFor="teamRow" className="block text-sm text-gray-400 mb-1.5">
            Team B
          </label>
          <input
            id="teamRow"
            type="text"
            value={teamRow}
            onChange={(e) => setTeamRow(e.target.value)}
            placeholder="Vermont"
            className="w-full rounded-lg border border-gray-800 bg-gray-900 px-3 py-2.5 text-sm text-white placeholder:text-gray-600 outline-none focus:border-gray-600 transition-colors"
          />
        </div>
      </div>

      {/* Price Per Square */}
      <div>
        <label htmlFor="squarePrice" className="block text-sm text-gray-400 mb-1.5">
          Price per square
        </label>
        <input
          id="squarePrice"
          type="number"
          min="1"
          step="0.01"
          value={squarePrice}
          onChange={(e) => setSquarePrice(e.target.value)}
          onBlur={() => { const n = parseFloat(squarePrice); if (!isNaN(n)) setSquarePrice(n.toFixed(2)); }}
          placeholder="e.g. 10.00"
          className="w-full rounded-lg border border-gray-800 bg-gray-900 px-3 py-2.5 text-sm text-white placeholder:text-gray-600 outline-none focus:border-gray-600 transition-colors"
        />
        {priceValid && (
          <p className="text-xs text-gray-600 mt-1.5">
            ${priceNum.toFixed(2)} per square · ${(totalPot / 100).toFixed(2)} total pot
          </p>
        )}
      </div>

      {/* Host Cut */}
      <div>
        <label htmlFor="hostCut" className="block text-sm text-gray-400 mb-1.5">
          Your cut
        </label>
        <div className="relative">
          <input
            id="hostCut"
            type="number"
            min="0"
            max="50"
            step="0.01"
            value={hostCut}
            onChange={(e) => setHostCut(e.target.value)}
            className="w-full rounded-lg border border-gray-800 bg-gray-900 px-3 py-2.5 text-sm text-white text-center outline-none focus:border-gray-600 transition-colors"
          />
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-600 text-xs">%</span>
        </div>
        {totalPot > 0 && hostCutValid && (
          <p className="text-xs text-gray-600 mt-1.5">
            You keep ${Math.round(totalPot * (hostCutNum / 100)) / 100} · Players split ${(playerPool / 100).toFixed(2)}
          </p>
        )}
        {!hostCutValid && (
          <p className="text-xs text-red-400 mt-1.5">Must be 0–50%</p>
        )}
      </div>

      {/* Payout Structure */}
      <div>
        <label className="block text-sm text-gray-400 mb-1.5">
          Player payout split
        </label>
        <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${PERIOD_LABELS.length}, 1fr)` }}>
          {PERIOD_LABELS.map((label) => (
            <div key={label}>
              <div className="text-xs text-gray-500 mb-1 text-center">{label}</div>
              <div className="relative">
                <input
                  type="number"
                  min="0"
                  max="100"
                  step="0.01"
                  value={payouts[label] || ""}
                  onChange={(e) => updatePayout(label, e.target.value)}
                  className="w-full rounded-lg border border-gray-800 bg-gray-900 px-2 py-2 text-sm text-white text-center outline-none focus:border-gray-600 transition-colors"
                />
                <span className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-600 text-xs">%</span>
              </div>
            </div>
          ))}
        </div>
        <p className={`text-xs mt-1.5 ${payoutValid ? "text-gray-600" : "text-red-400"}`}>
          Total: {payoutTotal}%{!payoutValid && " — must equal 100%"}
        </p>
      </div>

      {/* ============================================ */}
      {/* PAYOUT COORDINATION SECTION                  */}
      {/* ============================================ */}
      <div className="border-t border-gray-800 pt-6">
        <button
          type="button"
          onClick={() => setShowPayoutSection(!showPayoutSection)}
          className="flex items-center justify-between w-full text-left"
        >
          <div>
            <p className="text-sm font-medium text-gray-300">Add your payment accounts (optional)</p>
            <p className="text-xs text-gray-600 mt-0.5">
            </p>
          </div>
          <svg
            className={`w-5 h-5 text-gray-500 transition-transform ${showPayoutSection ? "rotate-180" : ""}`}
            fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
          >
            <path d="M19 9l-7 7-7-7" />
          </svg>
        </button>

        {showPayoutSection && (
          <div className="mt-4 space-y-4">
            {/* Venmo */}
            <div>
              <label htmlFor="hostVenmo" className="block text-xs text-gray-500 mb-1">
                Venmo
              </label>
              <input
                id="hostVenmo"
                type="text"
                value={hostVenmo}
                onChange={(e) => setHostVenmo(e.target.value)}
                placeholder="@your-venmo"
                className="w-full rounded-lg border border-gray-800 bg-gray-900 px-3 py-2 text-sm text-white outline-none focus:border-gray-600 transition-colors"
              />
            </div>

            {/* Zelle */}
            <div>
              <label htmlFor="hostZelle" className="block text-xs text-gray-500 mb-1">
                Zelle
              </label>
              <input
                id="hostZelle"
                type="text"
                value={hostZelle}
                onChange={(e) => setHostZelle(e.target.value)}
                placeholder="email or phone"
                className="w-full rounded-lg border border-gray-800 bg-gray-900 px-3 py-2 text-sm text-white outline-none focus:border-gray-600 transition-colors"
              />
            </div>

            {/* CashApp */}
            <div>
              <label htmlFor="hostCashapp" className="block text-xs text-gray-500 mb-1">
                CashApp
              </label>
              <input
                id="hostCashapp"
                type="text"
                value={hostCashapp}
                onChange={(e) => setHostCashapp(e.target.value)}
                placeholder="$your-cashapp"
                className="w-full rounded-lg border border-gray-800 bg-gray-900 px-3 py-2 text-sm text-white outline-none focus:border-gray-600 transition-colors"
              />
            </div>

            {/* Visibility Toggle */}
            <div className="flex items-center justify-between rounded-lg border border-gray-800 bg-gray-900 p-3">
              <div>
                <p className="text-xs text-gray-300">Show payment info to everyone</p>
                <p className="text-[10px] text-gray-600">Or only after players enter the PIN</p>
              </div>
              <button
                type="button"
                onClick={() => hasPaymentHandle && setPayoutVisibility(payoutVisibility === "public" ? "pin_gated" : "public")}
                className={`relative w-10 h-5 rounded-full transition-colors ${
                  hasPaymentHandle ? (payoutVisibility === "public" ? "bg-green-600" : "bg-gray-700") : "bg-gray-800 opacity-40 cursor-not-allowed"
                }`}
              >
                <span
                  className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                    payoutVisibility === "public" ? "translate-x-5" : ""
                  }`}
                />
              </button>
            </div>

            {/* Require Player Payout Toggle */}
            <div className="flex items-center justify-between rounded-lg border border-gray-800 bg-gray-900 p-3">
              <div>
                <p className="text-xs text-gray-300">Require players to share payout info</p>
                <p className="text-[10px] text-gray-600">Helps you pay winners faster</p>
              </div>
              <button
                type="button"
                onClick={() => setRequirePlayerPayout(!requirePlayerPayout)}
                className={`relative w-10 h-5 rounded-full transition-colors ${
                  requirePlayerPayout ? "bg-green-600" : "bg-gray-700"
                }`}
              >
                <span
                  className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                    requirePlayerPayout ? "translate-x-5" : ""
                  }`}
                />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Submit */}
      <button
        type="submit"
        disabled={loading}
        className="w-full rounded-lg bg-white text-gray-950 px-4 py-3 text-sm font-semibold hover:bg-gray-200 active:bg-gray-300 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        {loading ? "Creating…" : "Create Board"}
      </button>
    </form>
  );
}
