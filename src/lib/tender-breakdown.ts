import { prisma } from "./prisma.ts";
import { countsTowardRaised } from "./contributions.ts";
import { breakdownLabel } from "./tender.ts";

// The close-flow tender breakdown — payment-method addendum v1.2.8 §7.
//
// THE SAME POPULATION AS THE LEDGER HEADER, BY CONSTRUCTION. The filter is
// `countsTowardRaised` itself - confirmed AND not voided - which is the one
// definition boardTotals uses for `raised`. Writing the predicate out again
// here is how the two drift, so it is imported rather than restated, and the
// measure is the same column: totalPaidCents.
//
// READ-ONLY, AND NOT PART OF CLOSING. Nothing in close, finalization, prize,
// eligibility or fee math reads tender - invariant 122. This is a list a host
// works from at the bank, computed for display and nothing else.

export interface TenderBreakdownRow {
  /** Null on rows recorded before the method picker existed. */
  tender: string | null;
  /** Already resolved for display: "Card", "Zelle", "Unspecified". */
  label: string;
  cents: number;
}

export interface TenderBreakdown {
  rows: TenderBreakdownRow[];
  /** Must equal boardTotals(boardId).raisedCents - same population, same column. */
  totalCents: number;
  /** Confirmed, unvoided money with no recorded method. */
  unspecifiedCents: number;
}

export async function tenderBreakdown(boardId: string): Promise<TenderBreakdown> {
  const groups = await prisma.contribution.groupBy({
    by: ["tender"],
    where: { boardId, ...countsTowardRaised },
    _sum: { totalPaidCents: true },
  });

  const rows: TenderBreakdownRow[] = groups
    .map((g) => ({
      tender: g.tender,
      label: breakdownLabel(g.tender),
      cents: g._sum.totalPaidCents ?? 0,
    }))
    // Biggest first: the host is reconciling a deposit, not reading an index.
    // Ties fall back to the label so the order is stable between renders.
    .sort((a, b) => b.cents - a.cents || a.label.localeCompare(b.label));

  return {
    rows,
    totalCents: rows.reduce((n, r) => n + r.cents, 0),
    unspecifiedCents: rows.find((r) => r.tender === null)?.cents ?? 0,
  };
}
