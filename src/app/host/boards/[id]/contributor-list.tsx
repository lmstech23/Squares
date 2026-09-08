"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { purchaseUnit } from "@/lib/board-vocabulary";

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

// The row shape and the merge live in lib/contributor-rows.ts, so the fold of
// squares and donations into one person can be tested against real rows.
export type { ContributorRow } from "@/lib/contributor-rows";
import type { ContributorRow } from "@/lib/contributor-rows";

interface Props {
  rows: ContributorRow[];
  boardName: string;
  hasEvent: boolean;
  /// prizePoolPercent > 0. Names the purchase unit; see lib/board-vocabulary.
  hasPrize: boolean;
  /**
   * The money ledger for this board.
   *
   * A HREF, NOT A BOARD ID. This component knows about people; making it build
   * a route would give it an opinion about where money lives, which is the
   * separation the link exists to express.
   *
   * THE TWO SURFACES, AND WHY THEY ARE NOT THE SAME PAGE. This section is the
   * human view - who took part, how many, whether anything is outstanding. The
   * ledger is transaction-keyed: pending reservations, confirmed, released and
   * voided rows, payment rails, confirmation actions, audit detail. Neither
   * belongs inside the other, and nothing from the ledger is duplicated here.
   */
  ledgerHref: string;
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

/**
 * Whole dollars where the amount is whole, cents where it is not.
 *
 * NO CURRENCY SYMBOL - the CSV uses this too, and a leading "$" turns a number
 * into text in every spreadsheet that opens it. The row adds its own symbol.
 */
function dollars(cents: number): string {
  return (cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  });
}

export default function ContributorList({
  rows,
  boardName,
  hasEvent,
  hasPrize,
  ledgerHref,
}: Props) {
  // The SAME resolver the contributor board uses. A host texting parents "buy
  // your $25 ticket" must not be looking at a screen that says "square".
  const u = purchaseUnit({ boardType: "fundraiser", hasEvent, hasPrize });
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
    // TWO COLUMNS ADDED, MATCHING WHAT THE ROW SHOWS. dafdf7d set the rule and
    // it still holds: the export reflects the contributor row, it does not
    // become a ledger export. No rails, no reservation detail, no confirmation
    // controls, no transaction history - those live on /donations.
    //
    // "Donated" stays as the yes/no it always was, beside the amount, so a
    // sheet someone already filters on does not change meaning.
    const header = [
      "Name",
      "Email",
      u.Many,
      "Ticket amount",
      "Donated",
      "Donation amount",
      "Date",
      "Status",
    ];
    const body = visible.map((r) =>
      [
        esc(r.name),
        esc(r.email),
        String(r.tickets),
        dollars(r.ticketCents),
        r.donated ? "yes" : "no",
        dollars(r.donationCents),
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

  // NOT "View contributions". That names the people and reads as a second
  // contributor view; the destination is the financial transaction ledger.
  const ledgerLink = (
    <Link
      href={ledgerHref}
      className="text-xs text-gray-400 hover:text-white transition-colors flex-shrink-0"
    >
      View ledger &rarr;
    </Link>
  );

  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-gray-800 bg-gray-900 p-4">
        {/* THE LINK APPEARS HERE TOO, and that is deliberate rather than
            symmetry. This card is the fundraiser page's only entry point to the
            ledger now, and an empty roster does not mean an empty ledger - a
            board can hold pending reservations and confirmed money while this
            list shows nothing. Hiding the link on an empty roster would make
            the ledger unreachable exactly when a host is trying to find out
            where the money went. */}
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm font-medium">Contributors</p>
          {ledgerLink}
        </div>
        {/* "Nobody has claimed a ticket yet" was accurate and misleading: a
            host who had just taken a donation read it as nothing having
            happened. Donations are contributions and now appear in this list,
            so the empty state has to mean empty. */}
        <p className="text-xs text-gray-500 mt-1">No contributions yet.</p>
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
        <div className="flex items-center gap-3 flex-shrink-0">
          <button
            type="button"
            onClick={exportCsv}
            className="text-xs text-gray-400 hover:text-white transition-colors"
          >
            Export CSV
          </button>
          {ledgerLink}
        </div>
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
                {/* A DONATION HAS NO TICKET COUNT. It takes no inventory
                    (invariant 64), so a donation-only contributor would read
                    "0 tickets" - which says they got nothing rather than that
                    they gave. The marker replaces the count where there is
                    none, and sits beside it where there is. */}
                {/* TICKET MONEY AND DONATION MONEY STAY DISTINCT. Someone who
                    bought a ticket and added a gift reads
                    "1 ticket - $40 - $25 donation", never a single $65 they
                    cannot reconcile against what they chose. Same reason the
                    reservation page and its email show three numbers.

                    THE AMOUNTS ARE HISTORICAL. `ticketCents` sums what was
                    actually paid - `Square.pricePaidCents` and
                    `Contribution.entryAmountCents` - so an early-bird ticket
                    bought at $40 still reads $40 after the board moves to $50.

                    TWO ASYMMETRIES ARE DELIBERATE. A count with no money: a
                    square from before `pricePaidCents` existed. Money with no
                    count: a card entry purchase that has not confirmed has no
                    passes yet, so there is nothing to count. Both render what
                    is known rather than a zero that reads as a fact. */}
                <span className="text-xs text-gray-400 tabular-nums">
                  {r.tickets > 0 && (
                    <>
                      {r.tickets} {r.tickets === 1 ? u.one : u.many}
                      {r.ticketCents > 0 && (
                        <span className="text-gray-500">
                          {" \u00b7 $"}
                          {dollars(r.ticketCents)}
                        </span>
                      )}
                    </>
                  )}
                  {r.tickets === 0 && r.ticketCents > 0 && (
                    <span className="text-gray-500">${dollars(r.ticketCents)}</span>
                  )}
                  {r.donationCents > 0 && (
                    <span className="text-gray-500">
                      {r.tickets > 0 || r.ticketCents > 0 ? " \u00b7 " : ""}
                      {"$"}
                      {dollars(r.donationCents)} donation
                    </span>
                  )}
                  {r.tickets === 0 &&
                    r.ticketCents === 0 &&
                    r.donationCents === 0 && (
                      <span className="text-gray-500">donation</span>
                    )}
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
