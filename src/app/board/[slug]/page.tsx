import { prisma } from "@/lib/prisma";
import { notFound } from "next/navigation";
import PlayerBoard from "./player-board";
import FundraiserView from "./fundraiser-view";
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
    select: { gameName: true, squarePrice: true, boardType: true, causeDescription: true },
  });

  if (!board) return { title: "Board Not Found" };

  if (board.boardType === "fundraiser") {
    return {
      title: `${board.gameName} — Daali Boards`,
      description:
        board.causeDescription ??
        `$${board.squarePrice / 100} per square. Claim a square and support the cause.`,
    };
  }

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
      event: { select: { id: true } },
    },
  });
 
  if (!board) notFound();
  
  // Inline cleanup: release expired pending squares on page load
  await prisma.square.updateMany({
    where: {
      boardId: board.boardId,
      paymentStatus: "pending",
      checkoutExpiresAt: { lt: new Date() },
      // Game Day only. A fundraiser hold must be resolved against Stripe
      // before release (invariant 18), which the cron does — a page render is
      // the wrong place to be expiring payment sessions.
      board: { boardType: "game" },
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



  // ---- Fundraiser boards — v2 §6, §7 ----
  //
  // Returns before any Game Day computation. Nothing below this block runs for
  // a fundraiser: no pot arithmetic, no axis numbers, no winner calculation.
  // That separation is the point — every item on v2 §7's "must not appear"
  // list leaked in by a shared code path.
  if (board.boardType === "fundraiser") {
    // `raised` is the sum of pricePaidCents over confirmed squares, never a
    // count multiplied by a price — invariant 43. Summed in the database so a
    // partially-early-bird board is exact.
    const raised = await prisma.square.aggregate({
      where: { boardId: board.boardId, paymentStatus: "paid" },
      _sum: { pricePaidCents: true },
    });

    // Distinct contributors. Emails are counted server-side and never sent to
    // the client — only the count crosses.
    const supporters = await prisma.square.findMany({
      where: {
        boardId: board.boardId,
        paymentStatus: "paid",
        playerEmail: { not: null },
      },
      distinct: ["playerEmail"],
      select: { squareId: true },
    });

    const openCount = board.squares.filter(
      (sq) => sq.paymentStatus === "open"
    ).length;

    // Confirmation on return from Stripe — v2 §6. The squares in this
    // purchase are found by the session id rather than trusted from the URL.
    let confirmation: {
      positions: number[];
      admissionPasses: number;
      hasEvent: boolean;
    } | null = null;

    if (sp.success === "true" && sp.session_id) {
      const purchased = await prisma.square.findMany({
        where: { boardId: board.boardId, checkoutSessionId: sp.session_id },
        select: { squareId: true, position: true, paymentStatus: true },
        orderBy: { position: "asc" },
      });

      if (purchased.length > 0) {
        // One confirmed square mints one admission pass — addendum v2.0 §1.
        // Counted from the passes that actually exist rather than inferred
        // from square count, so the receipt can never name something the
        // supporter does not hold. A donated purchase mints none and the
        // count is naturally zero.
        const passes = board.event
          ? await prisma.admissionPass.count({
              where: {
                squareId: { in: purchased.map((sq) => sq.squareId) },
                status: { in: ["active", "used"] },
              },
            })
          : 0;

        confirmation = {
          positions: purchased.map((sq) => sq.position + 1),
          admissionPasses: passes,
          hasEvent: board.event != null,
        };
      }
    }

    // Whether the early bird price is still in effect. Decided here rather
    // than in the view, which stays pure.
    const earlyBirdActive =
      board.earlyBirdPriceCents != null &&
      board.earlyBirdEndsAt != null &&
      board.earlyBirdEndsAt > new Date();

    return (
      <FundraiserView
        title={board.gameName}
        causeDescription={board.causeDescription}
        hostName={board.host.name}
        squares={board.squares.map((sq) => ({
          squareId: sq.squareId,
          position: sq.position,
          paymentStatus: sq.paymentStatus,
        }))}
        squarePrice={board.squarePrice}
        earlyBirdPriceCents={board.earlyBirdPriceCents}
        earlyBirdEndsAt={board.earlyBirdEndsAt}
        earlyBirdActive={earlyBirdActive}
        timezone={board.timezone}
        raisedCents={raised._sum.pricePaidCents ?? 0}
        goalCents={board.fundraisingGoalCents}
        supporterCount={supporters.length}
        openCount={openCount}
        slug={board.slug}
        hasEvent={board.event != null}
        cashModeEnabled={board.cashModeEnabled}
        stripeConnected={board.host.stripeChargesEnabled ?? false}
        hasPrize={board.prizePoolPercent > 0}
        confirmation={confirmation}
        handles={{
          venmo: board.hostVenmo,
          zelle: board.hostZelle,
          cashapp: board.hostCashapp,
          paypal: board.hostPaypal,
        }}
      />
    );
  }

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
