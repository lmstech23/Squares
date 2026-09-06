// src/app/host/boards/[id]/donations/page.tsx
//
// Host contribution ledger — donations §11.
//
// THE FOUR NUMBERS, and the rows behind them. Every one is derivable from
// `Contribution` with a single grouped query; that is the payoff for making it
// the money primitive.
//
// NAMING RULE, §2: this reads "Square sales" on EVERY board type. There is no
// board on which "ticket sales" is the correct label for that number — the
// drawing ticket is derived from a square rather than sold separately, and a
// no-prize board has no ticket at all.
//
// A ROUTE, NOT A PANEL. It gates itself: a host can type this URL, so the
// product gate and host authorization are both enforced here.

import type { Metadata } from "next";
import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getHost } from "@/lib/auth";
import { boardTotals } from "@/lib/contributions";
import CashDonationForm from "./cash-donation-form";
import { ledgerCells, showConfirmedSeparately } from "@/lib/ledger-row";
import ConfirmButton from "./confirm-button";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Contributions — Daali",
};

/**
 * "Sep 5, 9:01 PM" in the board's zone.
 *
 * WITH THE TIME, deliberately. Four $25 rows from one person on one day are
 * indistinguishable without it, which is the complaint this column answers: a
 * host cannot match a row to a payment anyone remembers making.
 */
function stamp(d: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(d);
}

/** Month and day only - the secondary confirmation line needs no clock. */
function shortDay(d: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "short",
    day: "numeric",
  }).format(d);
}

function money(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export default async function DonationsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const host = await getHost();
  if (!host) redirect("/login");

  const board = await prisma.board.findUnique({
    where: { boardId: id },
    select: {
      boardId: true,
      hostId: true,
      slug: true,
      gameName: true,
      boardType: true,
      status: true,
      prizePoolPercent: true,
      // The Date column renders in the BOARD's zone, never the viewer's - a
      // host in another timezone reading her own ledger must see the day the
      // payment happened where the event is.
      timezone: true,
    },
  });

  if (!board || board.hostId !== host.id) notFound();
  // Game Day never accumulates donation money — donations §5.
  if (board.boardType !== "fundraiser") notFound();

  const totals = await boardTotals(board.boardId);

  const contributions = await prisma.contribution.findMany({
    where: { boardId: board.boardId },
    orderBy: { createdAt: "desc" },
    take: 100,
    select: {
      id: true,
      status: true,
      paymentMethod: true,
      squareAmountCents: true,
      donationAmountCents: true,
      totalPaidCents: true,
      contributorName: true,
      contributorEmail: true,
      confirmedAt: true,
      voidedAt: true,
      createdAt: true,
      _count: { select: { squares: true } },
    },
  });

  const hasPrize = board.prizePoolPercent > 0;
  // Every board carries one; the fallback matches what api/boards writes.
  const tz = board.timezone ?? "America/New_York";

  // Contributor-declared direct payments that have not landed yet. Scoped the
  // same way the confirm endpoint is: cash, donation-only, still pending.
  const awaitingCash = contributions.filter(
    (c) =>
      c.status === "pending" &&
      c.paymentMethod === "cash" &&
      c.squareAmountCents === 0 &&
      c.donationAmountCents > 0
  );

  return (
    <main className="min-h-screen bg-gray-950 text-white">
      <div className="mx-auto max-w-3xl px-4 py-6">
        <Link
          href={`/host/boards/${board.boardId}`}
          className="text-sm text-gray-500 hover:text-gray-300"
        >
          ← Back to board
        </Link>

        <h1 className="mt-3 text-lg font-medium">{board.gameName}</h1>
        <p className="text-sm text-gray-500">Contributions</p>

        {/* The four numbers — donations §11. */}
        <div className="mt-5 rounded-lg border border-gray-800 bg-gray-900 p-4">
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between">
              <dt className="text-gray-400">Square sales</dt>
              <dd className="tabular-nums">{money(totals.squareCents)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-400">Donations</dt>
              <dd className="tabular-nums">{money(totals.donationCents)}</dd>
            </div>
            <div className="flex justify-between border-t border-gray-800 pt-2 font-medium">
              <dt>Raised</dt>
              <dd className="tabular-nums">{money(totals.raisedCents)}</dd>
            </div>
            {hasPrize && (
              <div className="flex justify-between pt-2 text-gray-400">
                {/* Invariant 57: prize math reads the basis, never raised. */}
                <dt>Prize basis</dt>
                <dd className="tabular-nums">{money(totals.prizeBasisCents)}</dd>
              </div>
            )}
          </dl>
          <p className="mt-3 text-[11px] text-gray-600">
            {totals.contributionCount} confirmed contribution
            {totals.contributionCount === 1 ? "" : "s"}. Donations never reach the
            prize basis.
          </p>
        </div>

        {/* Declared by a contributor, not yet in hand. These are the people who
            chose Zelle/CashApp/Venmo/PayPal on the board and said they would
            send it. Nothing is held and nothing expires - a donation takes no
            inventory (invariants 55 and 64) - so a row sitting here forever is
            simply someone who changed their mind. */}
        {awaitingCash.length > 0 && (
          <div className="mt-5 rounded-lg border border-amber-900/60 bg-amber-950/10 p-4">
            <p className="text-sm font-medium">Awaiting payment</p>
            <p className="mt-1 text-xs text-gray-500 leading-relaxed">
              Declared on the board. Not counted in the totals above until you
              mark it received.
            </p>
            <ul className="mt-3 space-y-2">
              {awaitingCash.map((c) => (
                <li
                  key={c.id}
                  className="flex items-center justify-between gap-3 text-sm"
                >
                  <span className="min-w-0">
                    <span className="text-gray-200">{c.contributorName}</span>
                    <span className="text-gray-500"> — {money(c.totalPaidCents)}</span>
                    {c.contributorEmail && (
                      <span className="block text-xs text-gray-600 truncate">
                        {c.contributorEmail}
                      </span>
                    )}
                  </span>
                  <ConfirmButton boardId={board.boardId} contributionId={c.id} />
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="mt-5">
          <CashDonationForm boardId={board.boardId} />
        </div>

        <h2 className="mt-6 text-sm font-medium">Ledger</h2>
        <p className="mt-1 text-xs text-gray-500">
          One row per payment, including released and voided. The totals above
          count only confirmed, unvoided contributions. A dash means the column
          does not apply to that kind of row.
        </p>

        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="text-gray-500">
              <tr className="border-b border-gray-800">
                <th className="py-2 pr-3 font-normal">Contributor</th>
                <th className="py-2 pr-3 font-normal">Type</th>
                <th className="py-2 pr-3 font-normal">Date</th>
                <th className="py-2 pr-3 font-normal">Method</th>
                <th className="py-2 pr-3 font-normal">Status</th>
                <th className="py-2 pr-3 font-normal text-right">Tickets</th>
                <th className="py-2 pr-3 font-normal text-right">Ticket $</th>
                <th className="py-2 pr-3 font-normal text-right">Donation $</th>
                <th className="py-2 font-normal text-right">Total</th>
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {contributions.length === 0 && (
                <tr>
                  <td colSpan={9} className="py-4 text-gray-600">
                    No contributions yet.
                  </td>
                </tr>
              )}
              {contributions.map((c) => {
                // TYPE AND THE DASHES ARE DERIVED, not stored - see
                // lib/ledger-row.ts. A dash means the field does not apply to
                // this kind of row; a real zero is never hidden behind one.
                const cells = ledgerCells(c, c._count.squares);
                const showConfirmed = showConfirmedSeparately(
                  c.createdAt,
                  c.confirmedAt,
                  tz
                );
                return (
                <tr key={c.id} className="border-b border-gray-900">
                  <td className="py-2 pr-3">
                    <span className="text-gray-200">{c.contributorName}</span>
                    {c.contributorEmail && (
                      <span className="block text-gray-600">
                        {c.contributorEmail}
                      </span>
                    )}
                  </td>
                  <td className="py-2 pr-3 text-gray-300 whitespace-nowrap">
                    {cells.type}
                  </td>
                  <td className="py-2 pr-3 text-gray-400 whitespace-nowrap">
                    {stamp(c.createdAt, tz)}
                    {/* Only when it lands on a different day. A card payment
                        confirmed seconds later would just repeat itself; a
                        cash payment confirmed three days later is the fact a
                        host is actually looking for. */}
                    {showConfirmed && c.confirmedAt && (
                      <span className="block text-[11px] text-gray-600">
                        confirmed {shortDay(c.confirmedAt, tz)}
                      </span>
                    )}
                  </td>
                  <td className="py-2 pr-3 text-gray-400">
                    {c.paymentMethod === "cash" ? "cash" : "card"}
                  </td>
                  <td className="py-2 pr-3">
                    <span
                      className={
                        c.voidedAt
                          ? "text-amber-400"
                          : c.status === "confirmed"
                            ? "text-emerald-400"
                            : c.status === "pending"
                              ? "text-gray-400"
                              : "text-gray-600"
                      }
                    >
                      {c.voidedAt ? "voided" : c.status}
                    </span>
                  </td>
                  <td className="py-2 pr-3 text-right text-gray-400">
                    {cells.tickets === null ? (
                      <span className="text-gray-700">{"—"}</span>
                    ) : (
                      cells.tickets
                    )}
                  </td>
                  <td className="py-2 pr-3 text-right">
                    {cells.ticketCents === null ? (
                      <span className="text-gray-700">{"—"}</span>
                    ) : (
                      money(cells.ticketCents)
                    )}
                  </td>
                  <td className="py-2 pr-3 text-right">
                    {cells.donationCents === null ? (
                      <span className="text-gray-700">{"—"}</span>
                    ) : (
                      money(cells.donationCents)
                    )}
                  </td>
                  <td className="py-2 text-right font-medium">
                    {money(c.totalPaidCents)}
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <p className="mt-6 text-[11px] text-gray-600 leading-relaxed">
          Daali does not provide tax advice. The host running this fundraiser is
          the contributor&apos;s counterparty.
        </p>
      </div>
    </main>
  );
}
