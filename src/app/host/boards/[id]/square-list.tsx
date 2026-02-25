"use client";

import { useState, useMemo } from "react";

type PaymentStatus = "open" | "pending" | "paid" | "failed" | "expired" | "reserved_cash";

type SquareData = {
  squareId: string;
  position: number;
  playerName: string | null;
  paymentStatus: PaymentStatus;
};

type FilterValue = "all" | "filled" | "empty" | "pending" | "paid";

const FILTERS: { label: string; value: FilterValue }[] = [
  { label: "All", value: "all" },
  { label: "Filled", value: "filled" },
  { label: "Empty", value: "empty" },
  { label: "Pending", value: "pending" },
  { label: "Paid", value: "paid" },
];

export default function SquareList({ squares }: { squares: SquareData[] }) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<FilterValue>("all");

  // Summary counts — explicit per status
  const summary = useMemo(() => {
    let paid = 0;
    let pending = 0;
    let open = 0;
    let failed = 0;
    let expired = 0;
    let reservedCash = 0;
    for (const sq of squares) {
      switch (sq.paymentStatus) {
        case "paid":
          paid++;
          break;
        case "pending":
          pending++;
          break;
        case "failed":
          failed++;
          break;
        case "expired":
          expired++;
          break;
        case "reserved_cash":
          reservedCash++;
          break;
        default:
          open++;
      }
    }
    return {
      paid,
      pending,
      open,
      failed,
      expired,
      filled: paid + pending + reservedCash,
      empty: open,
    };
  }, [squares]);

  // Filter and search
  const filtered = useMemo(() => {
    const sorted = [...squares].sort((a, b) => a.position - b.position);

    return sorted.filter((sq) => {
      const s = sq.paymentStatus;
      const isFilled = s === "paid" || s === "pending" || s === "reserved_cash";
      const isEmpty = s === "open";

      // "filled" = paid + pending (taken squares)
      if (filter === "filled" && !isFilled) return false;
      if (filter === "empty" && !isEmpty) return false;
      if (filter === "pending" && s !== "pending") return false;
      if (filter === "paid" && s !== "paid") return false;

      // Search by player name
      if (search.trim()) {
        const q = search.trim().toLowerCase();
        if (!sq.playerName?.toLowerCase().includes(q)) return false;
      }

      return true;
    });
  }, [squares, filter, search]);

  const padNum = (n: number) => String(n + 1).padStart(2, "0");

  // Display helpers per status
  function getRowLabel(sq: SquareData): string {
    switch (sq.paymentStatus) {
      case "paid":
        return sq.playerName || "—";
      case "pending":
        return sq.playerName || "Pending checkout";
      case "failed":
        return sq.playerName || "Failed";
      case "expired":
        return sq.playerName || "Expired";
      default:
        return "Available";
    }
  }

  function getRowStyle(sq: SquareData): string {
    switch (sq.paymentStatus) {
      case "paid":
        return "text-gray-200 font-semibold";
      case "pending":
        return "text-yellow-500/80 font-semibold";
      case "failed":
        return "text-red-400/70 italic";
      case "expired":
        return "text-gray-500 italic";
      default:
        return "text-gray-600 italic";
    }
  }

  function getStatusBadge(
    sq: SquareData
  ): { label: string; classes: string } | null {
    switch (sq.paymentStatus) {
      case "paid":
        return {
          label: "Paid",
          classes:
            "bg-green-950 text-green-400 border border-green-900/50",
        };
      case "pending":
        return {
          label: "Pending",
          classes:
            "bg-yellow-950 text-yellow-500 border border-yellow-900/50",
        };
      case "failed":
        return {
          label: "Failed",
          classes: "bg-red-950 text-red-400 border border-red-900/50",
        };
      case "expired":
        return {
          label: "Expired",
          classes: "bg-gray-800 text-gray-500 border border-gray-700/50",
        };
      default:
        return null;
    }
  }

  return (
    <div className="mt-6">
      {/* Section header */}
      <h3 className="text-sm font-semibold text-gray-300 mb-3">Players</h3>

      {/* Summary bar */}
      <div className="flex items-center gap-3 text-xs text-gray-500 mb-3 tabular-nums flex-wrap">
        <span>
          Filled:{" "}
          <span className="text-gray-300 font-medium">{summary.filled}</span>
          {" "}/ {squares.length}
        </span>
        <span className="text-gray-700">·</span>
        <span>
          Empty:{" "}
          <span className="text-gray-300 font-medium">{summary.empty}</span>
        </span>
        {summary.pending > 0 && (
          <>
            <span className="text-gray-700">·</span>
            <span>
              Pending:{" "}
              <span className="text-yellow-400 font-medium">
                {summary.pending}
              </span>
            </span>
          </>
        )}
        {summary.expired > 0 && (
          <>
            <span className="text-gray-700">·</span>
            <span>
              Expired:{" "}
              <span className="text-gray-400 font-medium">
                {summary.expired}
              </span>
            </span>
          </>
        )}
        {summary.failed > 0 && (
          <>
            <span className="text-gray-700">·</span>
            <span>
              Failed:{" "}
              <span className="text-red-400 font-medium">
                {summary.failed}
              </span>
            </span>
          </>
        )}
      </div>

      {/* Controls: Search + Filter */}
      <div className="flex flex-col sm:flex-row gap-2 mb-3">
        {/* Search */}
        <div className="relative flex-1">
          <svg
            className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-600"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z"
            />
          </svg>
          <input
            type="text"
            placeholder="Type a name…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full bg-gray-900 border border-gray-800 rounded-md pl-8 pr-3 py-1.5 text-xs text-gray-300 placeholder:text-gray-600 focus:outline-none focus:border-gray-700 focus:ring-1 focus:ring-gray-700"
          />
        </div>

        {/* Filter pills */}
        <div className="flex gap-1 flex-wrap">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              onClick={() => setFilter(f.value)}
              className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                filter === f.value
                  ? "bg-gray-700 text-gray-200"
                  : "bg-gray-900 text-gray-500 hover:text-gray-400 border border-gray-800"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {/* Square list */}
      <div className="rounded-lg border border-gray-800 bg-gray-900 overflow-hidden">
        {filtered.length === 0 ? (
          <div className="px-4 py-6 text-center text-xs text-gray-600">
            {search.trim()
              ? `No squares found for "${search.trim()}"`
              : "No squares match this filter"}
          </div>
        ) : (
          <div className="divide-y divide-gray-800/50 max-h-[400px] overflow-y-auto">
            {filtered.map((sq) => {
              const badge = getStatusBadge(sq);

              return (
                <div
                  key={sq.squareId}
                  className="flex items-center gap-3 px-3 py-2 text-xs"
                >
                  {/* Square number — fixed width, mono */}
                  <span className="text-gray-600 font-mono w-6 text-right shrink-0">
                    #{padNum(sq.position)}
                  </span>

                  {/* Player name / status label */}
                  <span className={`flex-1 truncate ${getRowStyle(sq)}`}>
                    {getRowLabel(sq)}
                  </span>

                  {/* Status badge — right aligned */}
                  {badge && (
                    <span
                      className={`shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium ${badge.classes}`}
                    >
                      {badge.label}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
