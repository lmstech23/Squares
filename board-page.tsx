import { getHost } from "@/lib/auth";
import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { redirect, notFound } from "next/navigation";
import ShareCard from "./share-card";
import BoardGrid from "./grid";
import CloseBoardButton from "./close-button";
import ScoreEntry from "./score-entry";
import CashModeToggle from "./cash-mode-toggle";
import CashReservePanel from "./cash-reserve-panel";
import SquareList from "./square-list";
import { calculateWinnersFromArrays } from "@/lib/winners";
import NotifyWinnerButton from "./notify-winner-button";
export const dynamic = "force-dynamic";


interface Props {
  params: Promise<{ id: string }>;
}

export default async function HostBoardPage({ params }: Props) {
  const { id } = await params;
  const host = await getHost();
  if (!host) redirect("/login");

  const board = await prisma.board.findUnique({
    where: { boardId: id },
    include: {
      squares: {
        orderBy: { position: "asc" },
        select: {
          squareId: true,
          position: true,
          playerName: true,
          playerEmail: true,
          paymentStatus: true,
          paymentMethod: true,
          stripePaymentId: true,
          checkoutExpiresAt: true,
          releaseReason: true,
          playerPhone: true,
          playerPayoutMethod: true,
          playerPayoutHandle: true,
          smsOptIn: true,
        },
        
      },
    },
  });

  if (!board || board.hostId !== host.id) {
    notFound();
  }

  // Inline cleanup: release expired pending squares on page load
  await prisma.square.updateMany({
    where: {
      boardId: board.boardId,
      paymentStatus: { in: ["pending", "reserved_cash"] },
      checkoutExpiresAt: { lt: new Date() },
    },
    data: {
      paymentStatus: "open",
      playerName: null,
      playerEmail: null,
      stripePaymentId: null,
      checkoutExpiresAt: null,
      releaseReason: "expired",
    },
  });

  const paidCount = board.squares.filter(
    (s) => s.paymentStatus === "paid"
  ).length;
  const pendingCount = board.squares.filter(
    (s) => s.paymentStatus === "pending"
  ).length;
  const boardUrl = `${process.env.NEXT_PUBLIC_URL}/board/${board.slug}`;
  const isOpen = board.status === "open";
  const hasNumbers = board.rowNumbers && board.colNumbers;

  const payout = board.payoutStructure as Record<string, number> | null;

  const totalPot = (board.squarePrice / 100) * board.totalSquares;

  // Calculate winners from typed arrays
  const winners = calculateWinnersFromArrays(
    board.periodLabels,
    board.scoresTeamA,
    board.scoresTeamB,
    board.rowNumbers,
    board.colNumbers
  );







  const winnerPositions = new Set(winners.map((w) => w.position));
  const notifiedMap = (board.winnerNotifiedByPeriod ?? {}) as Record<string, string>;

  return (
    <div>
      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <Link
        href="/host/boards"
        className="text-sm text-gray-400 hover:text-white mb-4 inline-block"
      >
        ← Back to Boards
      </Link>
      <h1 className="text-xl font-bold">{board.gameName}</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            ${board.squarePrice / 100} per square · ${totalPot} total pot
          </p>
          {(board.teamCol || board.teamRow) && (
            <p className="text-xs text-gray-600 mt-0.5">
              {board.teamCol} vs {board.teamRow}
            </p>
          )}
        </div>
        <span
          className={`text-xs px-2.5 py-1 rounded-full font-medium ${
            isOpen
              ? "bg-green-950 text-green-400 border border-green-900"
              : "bg-gray-800 text-gray-400 border border-gray-700"
          }`}
        >
          {board.status}
        </span>
      </div>

      {/* Copy Link — always accessible */}
      <div className="rounded-lg border border-gray-800 bg-gray-900 p-4 mb-6">
        <p className="text-xs text-gray-500 mb-2">Share this link with your group</p>
        <ShareCard url={boardUrl} />
      </div>

      {/* Fill Tracker */}
      <div className="flex items-center gap-4 mb-4">
        <div className="flex-1 h-2 bg-gray-800 rounded-full overflow-hidden">
          <div
            className="h-full bg-green-500 rounded-full transition-all duration-500"
            style={{ width: `${(paidCount / board.totalSquares) * 100}%` }}
          />
        </div>
        <span className="text-sm font-medium tabular-nums">
          {paidCount}
          <span className="text-gray-500"> / {board.totalSquares}</span>
        </span>
      </div>

      {/* Pending indicator */}
      {pendingCount > 0 && (
        <p className="text-xs text-yellow-400/70 mb-4">
          {pendingCount} square{pendingCount > 1 ? "s" : ""} pending payment
        </p>
      )}

      {/* Close Board button — only when open */}
      {isOpen && (
        <div className="flex items-center justify-between rounded-lg border border-gray-800 bg-gray-900 p-4 mb-6">
          <div>
            <p className="text-sm font-medium">Ready to close?</p>
            <p className="text-xs text-gray-500 mt-0.5">
              Numbers will randomize immediately. No changes after this.
            </p>
          </div>
          <CloseBoardButton boardId={board.boardId} />
        </div>
      )}

      {/* Cash Mode */}
      {isOpen && (
        <CashModeToggle
          boardId={board.boardId}
          initialEnabled={board.cashModeEnabled}
          initialPin={board.cashPin}
          liabilityAccepted={board.cashLiabilityAccepted}
        />
      )}

      {/* Cash Reserve Panel */}
      {isOpen && board.cashModeEnabled && (
        <CashReservePanel
          boardId={board.boardId}
          squares={board.squares.map((s) => ({
            squareId: s.squareId,
            position: s.position,
            playerName: s.playerName,
            paymentStatus: s.paymentStatus,
            paymentMethod: s.paymentMethod,
          }))}
        />
      )}

      {/* Randomized confirmation */}
      {hasNumbers && (
        <div className="rounded-lg border border-green-900/50 bg-green-950/30 p-4 mb-6">
          <p className="text-sm text-green-300 font-medium">
            Numbers are set. Board is live for game day.
          </p>
        </div>
      )}

      {/* Score entry — only when board is closed with numbers */}
      {hasNumbers && board.teamCol && board.teamRow && (
        <div className="mb-6">
          <ScoreEntry
            boardId={board.boardId}
            teamCol={board.teamCol}
            teamRow={board.teamRow}
            periodLabels={board.periodLabels}
            existingScoresA={board.scoresTeamA ?? []}
            existingScoresB={board.scoresTeamB ?? []}
            winnerNotifiedByPeriod={notifiedMap}
          />
        </div>
      )}

      {/* Winner summary cards */}
      {winners.length > 0 && (
        <div className="grid grid-cols-2 gap-2 mb-6">
          {winners.map((w) => {
            const sq = board.squares[w.position];
            const quarterPct =
              payout?.[w.label as keyof typeof payout] ?? 0;
            const prize = Math.round(totalPot * (quarterPct / 100));

            return (
              <div
                key={w.label}
                className="rounded-lg border border-yellow-900/50 bg-yellow-950/30 p-3"
              >
                <div className="text-[10px] text-yellow-500 uppercase tracking-wider font-medium">
                  {w.label} Winner
                </div>
                <div className="text-sm font-bold text-yellow-300 mt-0.5">
                  {sq?.playerName ?? "—"}
                </div>
                <div className="text-xs text-gray-500 mt-0.5">
                  {board.teamCol} {w.colScore} – {board.teamRow} {w.rowScore}
                  <span className="text-yellow-500/70 ml-1">→ ${prize}</span>
                </div>
                <div className="text-[10px] text-yellow-300/70 mt-1.5 flex items-center gap-1">
                  <span>💰</span>
                  {sq?.playerPayoutMethod && sq.playerPayoutMethod !== "cash"
                    ? `${sq.playerPayoutMethod === "venmo" ? "Venmo" : sq.playerPayoutMethod === "zelle" ? "Zelle" : "CashApp"}: ${sq.playerPayoutHandle || "—"}`
                    : sq?.playerPayoutMethod === "cash"
                      ? "Cash (pay in person)"
                      : sq?.playerPhone
                        ? `No payout method — contact ${sq.playerPhone}`
                        : "No payout method on file"}
                </div>
                <div className="mt-2">
                  <NotifyWinnerButton
                    boardId={board.boardId}
                    periodLabel={w.label}
                    winnerName={sq?.playerName ?? null}
                    squareNumber={w.position + 1}
                    smsOptIn={sq?.smsOptIn ?? false}
                    alreadyNotified={!!notifiedMap[w.label]}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Payout structure */}
      {payout && (
        <div className="flex gap-3 mb-6">
          {board.periodLabels.map((label) => {
            const pct = payout?.[label] ?? 0;
            return (
            <div
              key={label}
              className="flex-1 rounded-lg border border-gray-800 bg-gray-900 p-2.5 text-center"
            >
              <div className="text-xs text-gray-500">{label}</div>
              <div className="text-sm font-medium mt-0.5">
                {pct}%
                <span className="text-xs text-gray-600 ml-1">
                  ${Math.round(totalPot * (pct / 100))}
                </span>
              </div>
            </div>
            );
          })}
        </div>
      )}

      {/* Grid — with numbers, team names, and winner highlighting */}
      <BoardGrid
        squares={board.squares}
        rowNumbers={board.rowNumbers ?? undefined}
        colNumbers={board.colNumbers ?? undefined}
        teamCol={board.teamCol ?? undefined}
        teamRow={board.teamRow ?? undefined}
        winnerPositions={winnerPositions}
      />

      {/* Player list — flat by square number */}
      <SquareList squares={board.squares} />
    </div>
  );
}
