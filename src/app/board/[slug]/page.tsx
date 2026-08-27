import { prisma } from "@/lib/prisma";
import { notFound } from "next/navigation";
import PlayerBoard from "./player-board";
import { calculateWinners } from "@/lib/winners";
import type { Metadata } from "next";
export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ [key: string]: string | undefined }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;

  const board = await prisma.board.findUnique({
    where: { slug },
    select: { gameName: true, squarePrice: true },
  });

  if (!board) return { title: "Board Not Found" };

  return {
    title: `${board.gameName} — Daali Boards`,
    description: `$${board.squarePrice / 100} per square. Pick your square and pay to lock it in.`,
  };
}

export default async function PublicBoardPage({ params, searchParams }: Props) {
  const { slug } = await params;
  const sp = await searchParams;

  const board = await prisma.board.findUnique({
    where: { slug },
    include: {
      squares: {
        orderBy: { position: "asc" },
        select: {
          squareId: true,
          position: true,
          playerName: true,
          paymentStatus: true,
        },
      },
      host: {
        select: { name: true, stripeAccountId: true, stripeChargesEnabled: true },
      },
    },
  });
 
  if (!board) notFound();
  
  // Inline cleanup: release expired pending squares on page load
  await prisma.square.updateMany({
    where: {
      boardId: board.boardId,
      paymentStatus: "pending",
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

  const payout = board.payoutStructure as Record<string, number> | null;

  const totalPot = (board.squarePrice / 100) * board.totalSquares;
  const playerPool = totalPot * (1 - (board.hostCutPercent ?? 0) / 100);

  // Calculate winners from typed arrays
  const winners = calculateWinners(board);






  const winnerPositions = winners.map((w) => w.position);

  // Squares are already client-safe (email not selected)
  const clientSquares = board.squares;

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <div className="max-w-lg mx-auto px-4 py-6">
        {/* Success banner */}
        {sp.success === "true" && (
          <div className="rounded-lg border border-green-900 bg-green-950/60 p-4 mb-6">
            <p className="text-sm text-green-300 font-medium">
              Payment confirmed — your square is locked in!
            </p>
          </div>
        )}

        {/* Cancelled banner */}
        {sp.cancelled === "true" && (
          <div className="rounded-lg border border-yellow-900 bg-yellow-950/60 p-4 mb-6">
            <p className="text-sm text-yellow-300 font-medium">
              Payment not completed. The square will be released automatically
              in a few minutes.
            </p>
          </div>
        )}

        {/* Header */}
        <div className="mb-5">
          <h1 className="text-xl font-bold">{board.gameName}</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            ${board.squarePrice / 100} per square
            {board.host.name && (
              <span> · hosted by {board.host.name}</span>
            )}
          </p>
        </div>

        {/* Fill Tracker */}
        <div className="flex items-center gap-4 mb-2">
          <div className="flex-1 h-2 bg-gray-800 rounded-full overflow-hidden">
            <div
              className="h-full bg-green-500 rounded-full transition-all duration-500"
              style={{
                width: `${(paidCount / board.totalSquares) * 100}%`,
              }}
            />
          </div>
          <span className="text-sm font-medium tabular-nums">
            {paidCount}
            <span className="text-gray-500"> / {board.totalSquares}</span>
          </span>
        </div>

        {/* Payout structure — show as dollars for players */}
        {payout && (
          <div className="flex gap-2 mb-5">
          {board.periodLabels.map((label) => {
            const pct = payout?.[label] ?? 0;
            return (
                <div key={label}
                className="flex-1 rounded-lg border border-gray-800 bg-gray-900 p-2 text-center"
              >
                <div className="text-[10px] text-gray-500 uppercase tracking-wider">
                  {label}
                </div>
                <div className="text-xs font-medium mt-0.5">
                  ${Math.round(playerPool * (pct / 100))}
                </div>
              </div>
            )})}
          </div>
        )}

        {/* Winner summary cards — shown during/after game */}
        {winners.length > 0 && (
          <div className="grid grid-cols-2 gap-2 mb-5">
            {winners.map((w) => {
              const sq = clientSquares[w.position];
              const quarterPct =
                payout?.[w.label as keyof typeof payout] ?? 0;
              const prize = Math.round(playerPool * (quarterPct / 100));

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
                </div>
              );
            })}
          </div>
        )}
          {/* Board — interactive for open, read-only for closed */}
        <PlayerBoard
          boardId={board.boardId}
          slug={board.slug}
          squares={clientSquares}
          squarePrice={board.squarePrice}
          maxPerPlayer={board.maxSquaresPerPlayer}
          status={board.status}
          rowNumbers={board.rowNumbers ?? undefined}
          colNumbers={board.colNumbers ?? undefined}
          rowPairs={(board.rowPairs as number[][] | null) ?? undefined}
          colPairs={(board.colPairs as number[][] | null) ?? undefined}
          gridType={board.gridType}
          teamCol={board.status === "open" ? "Team A" : (board.teamCol ?? undefined)}
          teamRow={board.status === "open" ? "Team B" : (board.teamRow ?? undefined)}
          winnerPositions={winnerPositions}
          cashModeEnabled={board.cashModeEnabled}
          stripeConnected={board.host.stripeChargesEnabled ?? false}
          hostVenmo={board.hostVenmo}
          hostZelle={board.hostZelle}
          hostCashapp={board.hostCashapp}
          hostPaypal={board.hostPaypal}
          payoutVisibility={board.payoutVisibility}
          requirePlayerPayout={board.requirePlayerPayout}
        />
      </div>
    </div>
  );
}
