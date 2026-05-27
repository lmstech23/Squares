"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// ============================================================
// PHASE 1 ADDITIONS:
//   1. Sport dropdown (NBA default) — drives period labels
//   2. Shared $/% toggle for Your cut + Player payout split
//   3. "Split evenly" button on Player payout split
//
// REMOVED: nothing. Every original field, label, toggle,
// payment account, error path, and style preserved.
// ============================================================

type SportType = "nba" | "nfl" | "cbb";
type SplitMode = "$" | "%";

const SPORT_OPTIONS: { value: SportType; label: string }[] = [
  { value: "nba", label: "NBA" },
  { value: "nfl", label: "Football (NFL)" },
  { value: "cbb", label: "College basketball" },
];

// Period labels per sport. Server uses the same mapping — this is only UI.
const PERIOD_LABELS_BY_SPORT: Record<SportType, string[]> = {
  nba: ["Q1", "Q2", "Q3", "Final"],
  nfl: ["Q1", "Q2", "Q3", "Final"],
  cbb: ["H1", "Final"],
};

function defaultPayoutsForSport(sport: SportType): Record<string, number> {
  const labels = PERIOD_LABELS_BY_SPORT[sport];
  // Even split in percent (matches original DEFAULT_PAYOUTS shape)
  if (labels.length === 2) return { [labels[0]]: 50, [labels[1]]: 50 };
  if (labels.length === 4)
    return { [labels[0]]: 25, [labels[1]]: 25, [labels[2]]: 25, [labels[3]]: 25 };
  // Generic fallback
  const each = Math.floor(100 / labels.length);
  const last = 100 - each * (labels.length - 1);
  const out: Record<string, number> = {};
  labels.forEach((l, i) => {
    out[l] = i === labels.length - 1 ? last : each;
  });
  return out;
}

interface NewBoardFormProps {
  gridType: "standard" | "double";
}

export default function NewBoardForm({ gridType }: NewBoardFormProps) {
  const router = useRouter();
  const [gameName, setGameName] = useState("");
  const [sportType, setSportType] = useState<SportType>("nba");
  const [teamCol, setTeamCol] = useState("");
  const [teamRow, setTeamRow] = useState("");
  const [squarePrice, setSquarePrice] = useState("");
  const [hostCut, setHostCut] = useState("0");

  // PHASE 1: shared toggle for Your cut + Player payout split
  const [splitMode, setSplitMode] = useState<SplitMode>("$");

  const [payouts, setPayouts] = useState<Record<string, number>>(
    Object.fromEntries(PERIOD_LABELS_BY_SPORT.nba.map((l) => [l, 0]))
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Payout coordination fields (UNCHANGED)
  const [hostVenmo, setHostVenmo] = useState("");
  const [hostZelle, setHostZelle] = useState("");
  const [hostCashapp, setHostCashapp] = useState("");
  const [hostPaypal, setHostPaypal] = useState("");
  const hasPaymentHandle = hostVenmo.trim() || hostZelle.trim() || hostCashapp.trim() || hostPaypal.trim();
  const [payoutVisibility, setPayoutVisibility] = useState<"public" | "pin_gated">("public");
  const [requirePlayerPayout, setRequirePlayerPayout] = useState(false);
  const [showPayoutSection, setShowPayoutSection] = useState(false);

  // ===== Derived values =====
  const periodLabels = PERIOD_LABELS_BY_SPORT[sportType];

  const priceNum = parseFloat(squarePrice) || 0;
  const priceInCents = Math.round(priceNum * 100);
  const priceValid = !isNaN(priceNum) && priceNum >= 1;
  const squareCount = gridType === "double" ? 25 : 100;
  const totalPot = priceValid ? Math.round(priceNum * 100 * squareCount) : 0; // cents
  const totalPotDollars = totalPot / 100;

  // hostCut interpretation depends on splitMode
  const hostCutRaw = parseFloat(hostCut);
  const hostCutDollars =
    splitMode === "$"
      ? !isNaN(hostCutRaw)
        ? hostCutRaw
        : 0
      : totalPotDollars * ((!isNaN(hostCutRaw) ? hostCutRaw : 0) / 100);
  const hostCutPercent =
    splitMode === "%"
      ? Math.round(hostCutRaw) || 0
      : totalPot > 0 && !isNaN(hostCutRaw)
      ? Math.round((hostCutRaw / totalPotDollars) * 100)
      : 0;

  const hostCutValid =
    splitMode === "%"
      ? !isNaN(hostCutRaw) && hostCutRaw >= 0 && hostCutRaw <= 50
      : !isNaN(hostCutRaw) &&
        hostCutRaw >= 0 &&
        hostCutRaw <= totalPotDollars &&
        hostCutPercent <= 50;

  const playerPoolDollars = hostCutValid
    ? Math.max(0, totalPotDollars - hostCutDollars)
    : 0;
  const playerPool = Math.round(playerPoolDollars * 100); // cents

  // Payout total (sum of inputs in current mode)
  const payoutSum = periodLabels.reduce(
    (sum, label) => sum + (payouts[label] ?? 0),
    0
  );
  const payoutValid =
    splitMode === "%"
      ? Math.abs(payoutSum - 100) <= 0.01
      : playerPoolDollars > 0 && Math.abs(payoutSum - playerPoolDollars) <= 0.5;

  function updatePayout(label: string, value: string) {
    const parsed = parseFloat(value);
    const requested = isNaN(parsed) ? 0 : Math.max(0, parsed);

    if (splitMode === "$") {
      const sumOtherPeriods = periodLabels.reduce(
        (sum, period) => sum + (period === label ? 0 : payouts[period] ?? 0),
        0
      );
      const maxForThisPeriod = Math.max(0, totalPotDollars - sumOtherPeriods);
      const nextAmount = Math.min(requested, maxForThisPeriod);
      const nextPayouts = { ...payouts, [label]: nextAmount };
      const nextPayoutSum = periodLabels.reduce(
        (sum, period) => sum + (nextPayouts[period] ?? 0),
        0
      );
      const nextHostCut = Math.max(0, totalPotDollars - nextPayoutSum);

      setPayouts(nextPayouts);
      setHostCut(String(Math.round(nextHostCut * 100) / 100));
      setError(requested > maxForThisPeriod ? "Payouts exceed total pot." : null);
    } else {
      setPayouts({ ...payouts, [label]: requested });
    }
  }
  
  // PHASE 1: change sport — reset payouts to even split for new period structure
  function changeSport(next: SportType) {
    setSportType(next);
    if (splitMode === "%") {
      setPayouts(defaultPayoutsForSport(next));
    } else {
      // $ mode — split player pool evenly if we have one, else zero
      const labels = PERIOD_LABELS_BY_SPORT[next];
      if (playerPoolDollars > 0) {
        const each = Math.floor(playerPoolDollars / labels.length);
        const last = playerPoolDollars - each * (labels.length - 1);
        const out: Record<string, number> = {};
        labels.forEach((l, i) => {
          out[l] = i === labels.length - 1 ? last : each;
        });
        setPayouts(out);
      } else {
        setPayouts(Object.fromEntries(labels.map((l) => [l, 0])));
      }
    }
  }

  // PHASE 1: toggle $ ↔ %, converting values where possible
  function changeMode(next: SplitMode) {
    if (next === splitMode) return;
    if (totalPotDollars > 0 && !isNaN(hostCutRaw)) {
      if (next === "%") {
        // $ → %
        const newHostCut = Math.round((hostCutRaw / totalPotDollars) * 100);
        setHostCut(String(newHostCut));
        const currentPool = totalPotDollars - hostCutRaw;
        if (currentPool > 0) {
          const converted: Record<string, number> = {};
          let sum = 0;
          for (let i = 0; i < periodLabels.length; i++) {
            const l = periodLabels[i];
            if (i === periodLabels.length - 1) {
              converted[l] = Math.max(0, 100 - sum);
            } else {
              const p = Math.round(((payouts[l] ?? 0) / currentPool) * 100);
              converted[l] = p;
              sum += p;
            }
          }
          setPayouts(converted);
        } else {
          setPayouts(defaultPayoutsForSport(sportType));
        }
      } else {
        // % → $
        const newHostCutDollars = Math.round(totalPotDollars * (hostCutRaw / 100));
        setHostCut(String(newHostCutDollars));
        const newPool = totalPotDollars - newHostCutDollars;
        const converted: Record<string, number> = {};
        let sum = 0;
        for (let i = 0; i < periodLabels.length; i++) {
          const l = periodLabels[i];
          if (i === periodLabels.length - 1) {
            converted[l] = Math.max(0, newPool - sum);
          } else {
            const d = Math.round(newPool * ((payouts[l] ?? 0) / 100));
            converted[l] = d;
            sum += d;
          }
        }
        setPayouts(converted);
      }
    }
    setSplitMode(next);
  }

  // PHASE 1: split evenly across periods, in current mode
  function splitEvenly() {
    if (splitMode === "%") {
      setPayouts(defaultPayoutsForSport(sportType));
    } else if (playerPoolDollars > 0) {
      const each = Math.floor(playerPoolDollars / periodLabels.length);
      const out: Record<string, number> = {};
      periodLabels.forEach((l) => {
        out[l] = each;
      });

      const assigned = each * periodLabels.length;
      const nextHostCut = totalPotDollars - assigned;

      setPayouts(out);
      setHostCut(String(Math.round(nextHostCut * 100) / 100));
    }
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
      setError(
        splitMode === "%"
          ? "Payout percentages must total 100%."
          : `Payout amounts must total $${playerPoolDollars.toFixed(2)}.`
      );
      return;
    }

    setLoading(true);
    setError(null);

    // Always convert payouts to percentages for the API
    let payoutPct: Record<string, number>;
    if (splitMode === "%") {
      payoutPct = { ...payouts };
    } else {
      payoutPct = {};
      let sum = 0;
      for (let i = 0; i < periodLabels.length; i++) {
        const l = periodLabels[i];
        if (i === periodLabels.length - 1) {
          payoutPct[l] = Math.round((100 - sum) * 100) / 100;
        } else {
          const p = Math.round(((payouts[l] ?? 0) / playerPoolDollars) * 10000) / 100;
          payoutPct[l] = p;
          sum += p;
        }
      }
    }

    try {
      const res = await fetch("/api/boards", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          gameName: gameName.trim(),
          sportType,
          teamCol: teamCol.trim(),
          teamRow: teamRow.trim(),
          squarePrice: priceInCents,
          hostCutPercent,
          payoutStructure: payoutPct,
          // Payout coordination
          hostVenmo: hostVenmo.trim() || null,
          hostZelle: hostZelle.trim() || null,
          hostCashapp: hostCashapp.trim() || null,
          hostPaypal: hostPaypal.trim() || null,
          payoutVisibility,
          requirePlayerPayout,
          gridType,
      
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
      {/* Board type chip — set by picker, read-only here */}
      <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-gray-900 border border-gray-800 text-xs">
        <span className="text-gray-500">Board type:</span>
        <span className="font-medium">
          {gridType === "standard" ? "Standard · 100 squares" : "Double · 25 squares"}
        </span>
      </div>

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

      {/* PHASE 1: Shared $/% toggle */}
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

      {/* Host Cut */}
      <div>
        <label htmlFor="hostCut" className="block text-sm text-gray-400 mb-1.5">
          Your cut
        </label>
        <div className="relative">
          {splitMode === "$" && (
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-600 text-xs">$</span>
          )}
          <input
            id="hostCut"
            type="number"
            min="0"
            step={splitMode === "$" ? "1" : "0.01"}
            value={hostCut}
            onChange={(e) => setHostCut(e.target.value)}
            className={`w-full rounded-lg border border-gray-800 bg-gray-900 ${
              splitMode === "$" ? "pl-7 pr-3" : "px-3"
            } py-2.5 text-sm text-white text-center outline-none focus:border-gray-600 transition-colors`}
          />
          {splitMode === "%" && (
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-600 text-xs">%</span>
          )}
        </div>
        {totalPot > 0 && hostCutValid && (
          <p className="text-xs text-gray-600 mt-1.5">
            You keep ${(Math.round(totalPot * (hostCutPercent / 100)) / 100).toFixed(2)} ({hostCutPercent}%) · Players split ${(playerPool / 100).toFixed(2)}
          </p>
        )}
        {!hostCutValid && (
          <p className="text-xs text-red-400 mt-1.5">Must be 0–50%</p>
        )}
      </div>

      {/* Payout Structure */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <label className="block text-sm text-gray-400">
            Player payout split
          </label>
          {/* PHASE 1: Split evenly */}
          <button
            type="button"
            onClick={splitEvenly}
            disabled={splitMode === "$" && playerPoolDollars <= 0}
            className="text-xs text-gray-400 hover:text-white disabled:text-gray-700 disabled:cursor-not-allowed transition-colors underline underline-offset-2"
          >
            Split evenly
          </button>
        </div>
        <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${periodLabels.length}, 1fr)` }}>
          {periodLabels.map((label) => (
            <div key={label}>
              <div className="text-xs text-gray-500 mb-1 text-center">{label}</div>
              <div className="relative">
                {splitMode === "$" && (
                  <span className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-600 text-xs">$</span>
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
                  <span className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-600 text-xs">%</span>
                )}
              </div>
            </div>
          ))}
        </div>
        {splitMode === "%" ? (
          <p className={`text-xs mt-1.5 ${payoutValid ? "text-gray-600" : "text-red-400"}`}>
            Total: {payoutSum}%{!payoutValid && " — must equal 100%"}
          </p>
        ) : (
          <p className={`text-xs mt-1.5 ${payoutValid ? "text-gray-600" : "text-red-400"}`}>
            Assigned: ${payoutSum.toFixed(2)} of ${playerPoolDollars.toFixed(2)}
            {!payoutValid && playerPoolDollars > 0 && ` — must equal $${playerPoolDollars.toFixed(2)}`}
            {playerPoolDollars <= 0 && " — set price and your cut first"}
            {payoutValid && " · editing payouts updates your cut"}
          </p>
        )}
      </div>

      {/* ============================================ */}
      {/* PAYOUT COORDINATION SECTION (UNCHANGED)      */}
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

            {/* PayPal */}
            <div>
              <label htmlFor="hostPaypal" className="block text-xs text-gray-500 mb-1">
                PayPal
              </label>
              <input
                id="hostPaypal"
                type="text"
                value={hostPaypal}
                onChange={(e) => setHostPaypal(e.target.value)}
                placeholder="you@email.com or @username"
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
