"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// ============================================================
// Phase 1 additions:
//   1. Sport dropdown (NBA default, drives period labels)
//   2. Shared $/% toggle for Your cut + Player payout split
//   3. "Split evenly" button on payout split
//
// Removed: nothing. All original fields preserved.
// ============================================================

type SportType = "nba" | "nfl" | "cbb";
type SplitMode = "$" | "%";

const SPORT_OPTIONS: { value: SportType; label: string }[] = [
  { value: "nba", label: "NBA" },
  { value: "nfl", label: "Football (NFL)" },
  { value: "cbb", label: "College basketball" },
];

// Period labels per sport. Server derives the same mapping — this is just UI.
const PERIOD_LABELS_BY_SPORT: Record<SportType, string[]> = {
  nba: ["Q1", "Q2", "Q3", "Final"],
  nfl: ["Q1", "Q2", "Q3", "Final"],
  cbb: ["H1", "Final"],
};

function evenPercentSplit(labels: string[]): Record<string, number> {
  const each = Math.round((100 / labels.length) * 100) / 100;
  const last = Math.round((100 - each * (labels.length - 1)) * 100) / 100;
  const out: Record<string, number> = {};
  labels.forEach((l, i) => {
    out[l] = i === labels.length - 1 ? last : each;
  });
  return out;
}

function evenDollarSplit(
  labels: string[],
  pool: number
): Record<string, number> {
  if (pool <= 0) {
    return Object.fromEntries(labels.map((l) => [l, 0]));
  }
  const each = Math.floor(pool / labels.length);
  const remainder = pool - each * labels.length;
  const out: Record<string, number> = {};
  labels.forEach((l, i) => {
    out[l] = each + (i === labels.length - 1 ? remainder : 0);
  });
  return out;
}

export default function NewBoardForm() {
  const router = useRouter();

  const [gameName, setGameName] = useState("");
  const [sportType, setSportType] = useState<SportType>("nba");
  const [teamCol, setTeamCol] = useState("");
  const [teamRow, setTeamRow] = useState("");
  const [squarePrice, setSquarePrice] = useState("");

  // Shared toggle: controls both Your cut and Player payout split together.
  const [splitMode, setSplitMode] = useState<SplitMode>("$");

  // hostCut and payouts hold raw input values in the current splitMode.
  // $ mode → dollar amounts. % mode → percentages.
  const [hostCut, setHostCut] = useState("");
  const [payouts, setPayouts] = useState<Record<string, number>>(
    Object.fromEntries(PERIOD_LABELS_BY_SPORT.nba.map((l) => [l, 0]))
  );

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ===== Derived values =====
  const periodLabels = PERIOD_LABELS_BY_SPORT[sportType];
  const priceNum = parseFloat(squarePrice);
  const totalPot = priceNum >= 1 ? priceNum * 100 : 0;
  const hostCutNum = parseFloat(hostCut) || 0;

  // Always compute hostCutPercent — the API only accepts percentages.
  const hostCutPercent =
    splitMode === "%"
      ? hostCutNum
      : totalPot > 0
      ? (hostCutNum / totalPot) * 100
      : 0;

  const hostCutValid =
    splitMode === "%"
      ? hostCutNum >= 0 && hostCutNum <= 50
      : totalPot > 0 && hostCutNum >= 0 && hostCutNum <= totalPot * 0.5;

  const playerPool =
    totalPot > 0 ? Math.round(totalPot * (1 - hostCutPercent / 100)) : 0;

  const payoutSum = periodLabels.reduce(
    (s, l) => s + (payouts[l] ?? 0),
    0
  );

  const payoutValid =
    splitMode === "%"
      ? Math.abs(payoutSum - 100) <= 0.01
      : playerPool > 0 && Math.abs(payoutSum - playerPool) <= 0.5;

  const formValid =
    gameName.trim().length > 0 &&
    teamCol.trim().length > 0 &&
    teamRow.trim().length > 0 &&
    priceNum >= 1 &&
    hostCutValid &&
    payoutValid;

  // ===== Handlers =====

  function changeSport(next: SportType) {
    const newLabels = PERIOD_LABELS_BY_SPORT[next];
    setSportType(next);
    // Reset payouts to zero in the new period structure (host re-enters or hits Split evenly)
    setPayouts(Object.fromEntries(newLabels.map((l) => [l, 0])));
  }

  function changeMode(next: SplitMode) {
    if (next === splitMode) return;

    // Convert what the host already typed, if we have a price.
    if (totalPot > 0) {
      if (next === "%") {
        // $ → %
        const newHostCut = (hostCutNum / totalPot) * 100;
        setHostCut(newHostCut > 0 ? String(Math.round(newHostCut * 100) / 100) : "");
        const currentPool = totalPot - hostCutNum;
        if (currentPool > 0) {
          const converted: Record<string, number> = {};
          for (const l of periodLabels) {
            converted[l] = Math.round(((payouts[l] ?? 0) / currentPool) * 10000) / 100;
          }
          setPayouts(converted);
        } else {
          setPayouts(Object.fromEntries(periodLabels.map((l) => [l, 0])));
        }
      } else {
        // % → $
        const newHostCut = totalPot * (hostCutNum / 100);
        setHostCut(newHostCut > 0 ? String(Math.round(newHostCut)) : "");
        const newPool = totalPot - newHostCut;
        const converted: Record<string, number> = {};
        for (const l of periodLabels) {
          converted[l] = Math.round(newPool * ((payouts[l] ?? 0) / 100));
        }
        setPayouts(converted);
      }
    }

    setSplitMode(next);
  }

  function splitEvenly() {
    if (splitMode === "%") {
      setPayouts(evenPercentSplit(periodLabels));
    } else {
      setPayouts(evenDollarSplit(periodLabels, playerPool));
    }
  }

  function updatePayout(label: string, value: string) {
    const num = parseFloat(value) || 0;
    setPayouts((prev) => ({ ...prev, [label]: num }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!formValid) return;

    setLoading(true);
    setError(null);

    // Convert to percentages for the API regardless of input mode.
    let payoutStructure: Record<string, number>;
    if (splitMode === "%") {
      payoutStructure = { ...payouts };
    } else {
      payoutStructure = {};
      for (const l of periodLabels) {
        payoutStructure[l] = (payouts[l] / playerPool) * 100;
      }
    }

    try {
      const res = await fetch("/api/boards", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          gameName: gameName.trim(),
          sportType,
          squarePrice: priceNum,
          teamRow: teamRow.trim(),
          teamCol: teamCol.trim(),
          hostCutPercent: Math.round(hostCutPercent * 100) / 100,
          payoutStructure,
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

  // ===== Render =====

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {/* Game Name (unchanged) */}
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
          placeholder="e.g. NBA Finals — Lakers vs Celtics"
          className="w-full rounded-lg border border-gray-800 bg-gray-900 px-3 py-2.5 text-sm text-white placeholder-gray-600 outline-none focus:border-gray-600 transition-colors"
        />
      </div>

      {/* PHASE 1: Sport */}
      <div>
        <label htmlFor="sportType" className="block text-sm text-gray-400 mb-1.5">
          Sport
        </label>
        <select
          id="sportType"
          value={sportType}
          onChange={(e) => changeSport(e.target.value as SportType)}
          className="w-full rounded-lg border border-gray-800 bg-gray-900 px-3 py-2.5 text-sm text-white outline-none focus:border-gray-600 transition-colors"
        >
          {SPORT_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
        <p className="text-xs text-gray-600 mt-1.5">
          Periods: {periodLabels.join(" · ")}
        </p>
      </div>

      {/* Team Names (unchanged) */}
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
            placeholder="e.g. Lakers"
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
            placeholder="e.g. Celtics"
            className="w-full rounded-lg border border-gray-800 bg-gray-900 px-3 py-2.5 text-sm text-white placeholder-gray-600 outline-none focus:border-gray-600 transition-colors"
          />
        </div>
      </div>

      {/* Price per Square (unchanged) */}
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
            required
            min="1"
            step="1"
            value={squarePrice}
            onChange={(e) => setSquarePrice(e.target.value)}
            placeholder="10"
            className="w-full rounded-lg border border-gray-800 bg-gray-900 pl-7 pr-3 py-2.5 text-sm text-white placeholder-gray-600 outline-none focus:border-gray-600 transition-colors"
          />
        </div>
        {totalPot > 0 && (
          <p className="text-xs text-gray-600 mt-1.5">
            100 squares × ${priceNum} = ${totalPot} total pot
          </p>
        )}
      </div>

      {/* PHASE 1: Shared $/% toggle — controls both Your cut and Payout split */}
      <div className="flex items-center gap-2">
        <span className="text-xs text-gray-500">Enter amounts as</span>
        <div className="inline-flex border border-gray-700 rounded-lg overflow-hidden">
          <button
            type="button"
            onClick={() => changeMode("$")}
            className={`px-3 py-1 text-xs font-medium transition-colors ${
              splitMode === "$"
                ? "bg-white text-gray-950"
                : "bg-gray-900 text-gray-400 hover:text-gray-200"
            }`}
          >
            $
          </button>
          <button
            type="button"
            onClick={() => changeMode("%")}
            className={`px-3 py-1 text-xs font-medium transition-colors border-l border-gray-700 ${
              splitMode === "%"
                ? "bg-white text-gray-950"
                : "bg-gray-900 text-gray-400 hover:text-gray-200"
            }`}
          >
            %
          </button>
        </div>
      </div>

      {/* Your cut */}
      <div>
        <label htmlFor="hostCut" className="block text-sm text-gray-400 mb-1.5">
          Your cut
        </label>
        <div className="relative">
          {splitMode === "$" && (
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 text-sm">
              $
            </span>
          )}
          <input
            id="hostCut"
            type="number"
            min="0"
            step={splitMode === "$" ? "1" : "0.01"}
            value={hostCut}
            onChange={(e) => setHostCut(e.target.value)}
            placeholder={splitMode === "$" ? "e.g. 200" : "e.g. 20"}
            className={`w-full rounded-lg border border-gray-800 bg-gray-900 ${
              splitMode === "$" ? "pl-7" : "pl-3"
            } pr-7 py-2.5 text-sm text-white placeholder-gray-600 outline-none focus:border-gray-600 transition-colors`}
          />
          {splitMode === "%" && (
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-600 text-xs">
              %
            </span>
          )}
        </div>
        {totalPot > 0 && hostCutValid && hostCutNum > 0 && (
          <p className="text-xs text-gray-600 mt-1.5">
            From a ${totalPot} pot — you keep $
            {Math.round(totalPot * (hostCutPercent / 100))} · Players split $
            {playerPool}
          </p>
        )}
        {!hostCutValid && hostCut !== "" && (
          <p className="text-xs text-red-400 mt-1.5">
            {splitMode === "%"
              ? "Must be 0–50%"
              : "Must be at most 50% of the total pot"}
          </p>
        )}
      </div>

      {/* Player payout split */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <label className="block text-sm text-gray-400">
            Player payout split
          </label>
          <button
            type="button"
            onClick={splitEvenly}
            disabled={splitMode === "$" && playerPool <= 0}
            className="text-xs text-gray-400 hover:text-white disabled:text-gray-700 disabled:cursor-not-allowed transition-colors underline underline-offset-2"
          >
            Split evenly
          </button>
        </div>
        <div
          className="grid gap-2"
          style={{ gridTemplateColumns: `repeat(${periodLabels.length}, 1fr)` }}
        >
          {periodLabels.map((label) => (
            <div key={label}>
              <div className="text-xs text-gray-500 mb-1 text-center">
                {label}
              </div>
              <div className="relative">
                {splitMode === "$" && (
                  <span className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-600 text-xs">
                    $
                  </span>
                )}
                <input
                  type="number"
                  min="0"
                  step={splitMode === "$" ? "1" : "0.01"}
                  value={payouts[label] || ""}
                  onChange={(e) => updatePayout(label, e.target.value)}
                  className={`w-full rounded-lg border border-gray-800 bg-gray-900 ${
                    splitMode === "$" ? "pl-5 pr-2" : "pl-2 pr-5"
                  } py-2 text-sm text-white text-center outline-none focus:border-gray-600 transition-colors`}
                />
                {splitMode === "%" && (
                  <span className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-600 text-xs">
                    %
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
        {/* Live total + math hint */}
        {splitMode === "%" ? (
          <p
            className={`text-xs mt-1.5 ${
              payoutValid ? "text-gray-600" : "text-red-400"
            }`}
          >
            Total: {Math.round(payoutSum * 100) / 100}%
            {!payoutValid && " — must equal 100%"}
          </p>
        ) : (
          <p
            className={`text-xs mt-1.5 ${
              payoutValid ? "text-gray-600" : "text-red-400"
            }`}
          >
            Assigned: ${payoutSum} of ${playerPool}
            {!payoutValid &&
              playerPool > 0 &&
              ` — must equal $${playerPool}`}
            {playerPool <= 0 && " — enter price and your cut first"}
          </p>
        )}
        {splitMode === "%" && payoutValid && playerPool > 0 && (
          <p className="text-xs text-gray-600 mt-0.5">
            {periodLabels
              .map(
                (label) =>
                  `${label}: $${Math.round(
                    playerPool * ((payouts[label] ?? 0) / 100)
                  )}`
              )
              .join(" · ")}
          </p>
        )}
      </div>

      {/* Error */}
      {error && (
        <div className="rounded-lg border border-red-900/50 bg-red-950/30 p-3">
          <p className="text-sm text-red-300">{error}</p>
        </div>
      )}

      {/* Submit (unchanged) */}
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
