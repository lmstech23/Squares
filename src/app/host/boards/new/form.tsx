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
  const [hostCut, setHostCut] = useState("20");
  const [payouts, setPayouts] = useState(DEFAULT_PAYOUTS);
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const payoutTotal = PERIOD_LABELS.reduce(
    (sum, label) => sum + (payouts[label] ?? 0),
    0
  );
  const payoutValid = Math.abs(payoutTotal - 100) <= 0.01;
  const priceNum = parseFloat(squarePrice);
  const hostCutNum = parseInt(hostCut, 10) || 0;
  const hostCutValid = hostCutNum >= 0 && hostCutNum <= 50;
  const formValid =
    gameName.trim().length > 0 &&
    teamCol.trim().length > 0 &&
    teamRow.trim().length > 0 &&
    priceNum >= 1 &&
    payoutValid &&
    hostCutValid;

  const totalPot = priceNum >= 1 ? priceNum * 100 : 0;
  const playerPool = Math.round(totalPot * (1 - hostCutNum / 100));

  function updatePayout(label: string, value: string) {
    const num = parseFloat(value) || 0;
    setPayouts((prev) => ({ ...prev, [label]: num }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!formValid || submitted) return;

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
          hostCutPercent: hostCutNum,
          payoutStructure: payouts,
        }),
      });

      const data = await res.json();

      // Pending board created — redirect to dashboard to complete payment
      if (res.status === 402 && data.boardId) {
        router.push("/host/boards");
        return;
      }

      // Already have a pending board — redirect to dashboard
      if (res.status === 409 && data.pendingBoardId) {
        router.push("/host/boards");
        return;
      }

      if (!res.ok) {
        setError(data.error || "Something went wrong");
        setLoading(false);
        return;
      }

      setSubmitted(true);
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
          placeholder="e.g. UNC vs Duke"
          className="w-full rounded-lg bg-gray-900 border border-gray-800 px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-gray-600"
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
            placeholder="e.g. UNC"
            className="w-full rounded-lg bg-gray-900 border border-gray-800 px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-gray-600"
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
            placeholder="e.g. Duke"
            className="w-full rounded-lg bg-gray-900 border border-gray-800 px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-gray-600"
          />
        </div>
      </div>

      {/* Price */}
      <div>
        <label htmlFor="squarePrice" className="block text-sm text-gray-400 mb-1.5">
          Price per square
        </label>
        <div className="relative">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 text-sm">
            $
          </span>
          <input
            id="squarePrice"
            type="number"
            min="1"
            step="1"
            required
            value={squarePrice}
            onChange={(e) => setSquarePrice(e.target.value)}
            placeholder="10"
            className="w-full rounded-lg bg-gray-900 border border-gray-800 pl-7 pr-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-gray-600"
          />
        </div>
        {priceNum >= 1 && (
          <p className="text-xs text-gray-600 mt-1">
            100 squares × ${priceNum} = ${priceNum * 100} total pot
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
            step="1"
            value={hostCut}
            onChange={(e) => setHostCut(e.target.value)}
            className="w-full rounded-lg bg-gray-900 border border-gray-800 px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-gray-600 pr-8"
          />
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 text-sm">
            %
          </span>
        </div>
        {totalPot > 0 && hostCutValid && (
          <p className="text-xs text-gray-600 mt-1">
            You keep ${Math.round(totalPot * (hostCutNum / 100))} · Players
            split ${playerPool}
          </p>
        )}
      </div>

      {/* Payout Split */}
      <div>
        <label className="block text-sm text-gray-400 mb-1.5">
          Player payout split
        </label>
        <div className="grid grid-cols-2 gap-3">
          {PERIOD_LABELS.map((label) => (
            <div key={label}>
              <p className="text-xs text-gray-500 mb-1 text-center">{label}</p>
              <div className="relative">
                <input
                  type="number"
                  min="0"
                  max="100"
                  step="1"
                  value={payouts[label] ?? ""}
                  onChange={(e) => updatePayout(label, e.target.value)}
                  className="w-full rounded-lg bg-gray-900 border border-gray-800 px-3 py-2 text-sm text-white text-center focus:outline-none focus:border-gray-600 pr-8"
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 text-sm">
                  %
                </span>
              </div>
            </div>
          ))}
        </div>
        <p
          className={`text-xs mt-1.5 ${
            payoutValid
              ? "text-gray-600" : "text-red-400"
          }`}
        >
          Total: {payoutTotal}%{!payoutValid && " — must equal 100%"}
        </p>
        {payoutValid && totalPot > 0 && hostCutValid && (
          <p className="text-xs text-gray-600 mt-0.5">
            {PERIOD_LABELS.map(
              (label) =>
                `${label}: $${Math.round(playerPool * ((payouts[label] ?? 0) / 100))}`
            ).join(" · ")}
          </p>
        )}
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
        disabled={!formValid || loading || submitted}
        className="w-full rounded-lg bg-white text-gray-950 py-2.5 text-sm font-medium hover:bg-gray-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        {submitted ? "Board Created — Redirecting…" : loading ? "Creating…" : "Create Board"}
      </button>
    </form>
  );
}
