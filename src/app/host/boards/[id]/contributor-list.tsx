"use client";

import { useMemo, useState } from "react";

// Contributor list — fundraiser-board-v2.md §9.
//
// The tiles say how the campaign is doing. They do not settle an argument:
// "I paid you" against a number on a dashboard is not a conversation a host
// can win. She needs a row with a name on it.
//
// FOUR FIELDS, and the restraint is the design. Deliberately absent: square
// numbers, dollar amounts, payment method, timestamps, who marked a payment
// received. A host scanning this list is looking for a name and whether they
// paid; everything else makes the name harder to find. Amounts are already in
// the raised total, square numbers are on the grid, and if a specific dispute
// needs that detail it belongs behind a row tap rather than on every row.

export interface ContributorRow {
  name: string;
  email: string;
  tickets: number;
  /// Earliest claim date across their squares, ISO. Null on old rows that
  /// predate claimed_at.
  claimedAt: string | null;
  status: "CONFIRMED" | "AWAITING" | "MIXED";
}

interface Props {
  rows: ContributorRow[];
  boardName: string;
  hasEvent: boolean;
}

type SortKey = "name" | "date";

/** Date only, no time — v2 §9. In the board's zone, not the viewer's. */
function shortDate(iso: string | null): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "America/New_York",
  }).format(new Date(iso));
}

const STATUS_STYLE: Record<ContributorRow["status"], string> = {
  CONFIRMED: "text-green-400 border-green-900/50 bg-green-950/30",
  AWAITING: "text-yellow-400 border-yellow-900/50 bg-yellow-950/30",
  MIXED: "text-yellow-400 border-yellow-900/50 bg-yellow-950/30",
};

export default function ContributorList({ rows, boardName, hasEvent }: Props) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("date");

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? rows.filter(
          (r) =>
            r.name.toLowerCase().includes(q) || r.email.toLowerCase().includes(q)
        )
      : rows;

    return [...filtered].sort((a, b) => {
      if (sort === "name") return a.name.localeCompare(b.name);
      // Most recent first. Rows with no date sort last rather than to the top,
      // where they would look like today's contributions.
      if (!a.claimedAt) return 1;
      if (!b.claimedAt) return -1;
      return b.claimedAt.localeCompare(a.claimedAt);
    });
  }, [rows, query, sort]);

  // A treasurer reconciling against a bank statement should not retype thirty
  // rows. Built in the browser — no endpoint, nothing to secure.
  function exportCsv() {
    const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
    const header = ["Name", "Email", hasEvent ? "Tickets" : "Squares", "Date", "Status"];
    const body = visible.map((r) =>
      [
        esc(r.name),
        esc(r.email),
        String(r.tickets),
        esc(shortDate(r.claimedAt)),
        r.status,
      ].join(",")
    );
    const csv = [header.join(","), ...body].join("\r\n");

    const url = URL.createObjectURL(
      new Blob([csv], { type: "text/csv;charset=utf-8;" })
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `${boardName.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-contributors.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-gray-800 bg-gray-900 p-4">
        <p className="text-sm font-medium">Contributors</p>
        <p className="text-xs text-gray-500 mt-1">
          Nobody has claimed a square yet.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900 p-4">
      <div className="flex items-center justify-between gap-3 mb-3">
        <p className="text-sm font-medium">
          Contributors{" "}
          <span className="text-gray-500 font-normal">({rows.length})</span>
        </p>
        <button
          type="button"
          onClick={exportCsv}
          className="text-xs text-gray-400 hover:text-white transition-colors"
        >
          Export CSV
        </button>
      </div>

      <div className="flex gap-2 mb-3">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search name or email"
          className="flex-1 rounded-lg border border-gray-800 bg-gray-950 px-3 py-2 text-sm text-white placeholder:text-gray-600 outline-none focus:border-gray-600 transition-colors"
        />
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as SortKey)}
          aria-label="Sort contributors"
          className="rounded-lg border border-gray-800 bg-gray-950 px-2 py-2 text-sm text-white outline-none focus:border-gray-600"
        >
          <option value="date">Newest</option>
          <option value="name">Name</option>
        </select>
      </div>

      {visible.length === 0 ? (
        <p className="text-xs text-gray-500 py-2">No contributor matches that.</p>
      ) : (
        <div className="space-y-1.5">
          {visible.map((r) => (
            <div
              key={r.email}
              className="flex items-center justify-between gap-3 rounded-lg border border-gray-800 bg-gray-950 px-3 py-2.5"
            >
              <div className="min-w-0">
                <p className="text-sm truncate">{r.name}</p>
                <p className="text-xs text-gray-500 truncate">{r.email}</p>
              </div>
              <div className="flex items-center gap-3 flex-shrink-0">
                <span className="text-xs text-gray-400 tabular-nums">
                  {r.tickets}{" "}
                  {hasEvent
                    ? r.tickets === 1
                      ? "ticket"
                      : "tickets"
                    : r.tickets === 1
                      ? "square"
                      : "squares"}
                </span>
                <span className="text-xs text-gray-500 tabular-nums w-14 text-right">
                  {shortDate(r.claimedAt)}
                </span>
                <span
                  className={`text-[10px] font-medium px-2 py-1 rounded border ${STATUS_STYLE[r.status]}`}
                >
                  {r.status}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
