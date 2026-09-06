import { prisma } from "@/lib/prisma";
import { notFound } from "next/navigation";
import PlayerBoard from "./player-board";
import FundraiserView from "./fundraiser-view";
import { calculateWinners } from "@/lib/winners";
import { publicPriceDisplay } from "@/lib/fundraiser-pricing";
import { donationReturnState } from "@/lib/donation-return";
import { boardTotals } from "@/lib/contributions";
import { issueSupporterAccessLink, mayClaim } from "@/lib/signups";
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
    select: {
      gameName: true, squarePrice: true, boardType: true, causeDescription: true,
      earlyBirdPriceCents: true, earlyBirdEndsAt: true,
    },
  });

  if (!board) return { title: "Board Not Found" };

  if (board.boardType === "fundraiser") {
    // THE LINK PREVIEW IS A CONTRIBUTOR-FACING PRICE LINE. These boards spread
    // by group text, and the card that renders there quoted `squarePrice`
    // unconditionally - so during an early-bird window the preview advertised
    // $50 while the board itself said $40. Same helper as the header.
    const price = publicPriceDisplay(board);
    return {
      title: `${board.gameName} — Daali Boards`,
      description:
        board.causeDescription ??
        `$${price.amountCents / 100} per square. Claim a square and support the cause.`,
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
      event: { select: { id: true, signupSheet: { select: { id: true } } } },
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
    // RAISED IS THE LEDGER, NOT THE SQUARES.
    //
    // This summed Square.pricePaidCents over paid squares, which silently
    // excludes every donation - a $500 gift moved the host ledger and left the
    // public progress bar unchanged. CLAUDE.md states the rule plainly:
    // "raisedCents is the sum of totalPaidCents over confirmed contributions
    // and includes donations."
    //
    // boardTotals is the SAME function the host donations page uses, so the
    // two surfaces cannot disagree. It filters `confirmed AND voidedAt IS
    // NULL` - both halves, per the schema comment: testing status alone
    // "silently resurrects voided money into totals".
    //
    // Prize math is untouched and still reads the square basis, never this
    // (invariant 57, and invariant 49 as amended).
    const totals = await boardTotals(board.boardId);

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
      passesUrl: string | null;
      /// They ticked "I'd like to help" at checkout. Drives the redirect and,
      /// when the redirect cannot be built, the fallback copy.
      wantsToHelp: boolean;
      /// Present only once the purchase is CONFIRMED and a fresh token could be
      /// minted. Null while pending, and null when a live token already exists
      /// whose raw value is unrecoverable by design (only its hash is stored).
      signupUrl: string | null;
    } | null = null;

    if (sp.success === "true" && sp.session_id) {
      const purchased = await prisma.square.findMany({
        where: { boardId: board.boardId, checkoutSessionId: sp.session_id },
        select: {
          squareId: true,
          position: true,
          paymentStatus: true,
          batchId: true,
        },
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

        const batchId = purchased.find((sq) => sq.batchId)?.batchId ?? null;

        // Volunteer redirect — sign-up addendum §5.
        //
        // ELIGIBILITY IS DERIVED, NEVER STORED: the token is minted only once
        // the supporter is `active`, which happens inside the confirmation
        // transaction. A pending purchase yields no token, which is what makes
        // the 20-second fallback below correct rather than a workaround.
        let wantsToHelp = false;
        let signupUrl: string | null = null;

        if (board.event && batchId) {
          const grant = await prisma.admissionGrant.findUnique({
            where: { squareBatchId: batchId },
            select: {
              wantsToHelp: true,
              supporter: { select: { id: true, status: true } },
            },
          });
          wantsToHelp = grant?.wantsToHelp ?? false;

          if (
            wantsToHelp &&
            grant?.supporter &&
            mayClaim(grant.supporter.status) &&
            board.event.signupSheet
          ) {
            // ALWAYS a usable link. The old call returned null once any token
            // existed, so whichever of the page and the email got there second
            // had nothing to render — which is exactly how a contributor ended
            // up reading "open your link from the board page" with no link
            // anywhere. See issueSupporterAccessLink for the trade-off.
            const issued = await issueSupporterAccessLink(grant.supporter.id);
            signupUrl = `/signup/${issued.token}`;
          }
        }

        confirmation = {
          positions: purchased.map((sq) => sq.position + 1),
          admissionPasses: passes,
          hasEvent: board.event != null,
          // Only offered when there is something behind it — A9 is what makes
          // the ticket line safe to show again.
          passesUrl: passes > 0 && batchId ? `/passes/${batchId}` : null,
          wantsToHelp,
          signupUrl,
        };
      }
    }

    // DONATION-ONLY CARD RETURN — donations §6.
    //
    // The donate route has always sent `?donated=true&session_id=...` and
    // NOTHING READ IT. A donor who paid by card came back to the plain board
    // with no acknowledgement of any kind - the only one of the four submit
    // states with no screen at all.
    //
    // RESOLVED THE SAME WAY THE TICKET RETURN IS: the session id from the URL
    // is a lookup key, never a claim. It selects the ledger row and the row's
    // own status decides what renders, so a fabricated or replayed session_id
    // cannot produce a confirmation. Contribution.checkoutSessionId is the
    // same key the webhook uses, so this is one lookup, not a parallel one.
    let donation: { settled: boolean } | null = null;
    if (sp.donated === "true" && sp.session_id) {
      const row = await prisma.contribution.findUnique({
        where: { checkoutSessionId: sp.session_id },
        select: {
          boardId: true,
          status: true,
          squareAmountCents: true,
          voidedAt: true,
        },
      });
      // The guards live in donationReturnState so they can be tested against
      // real rows in every state. Null means render NOTHING.
      //
      // NO VOLUNTEER PROMPT HERE. A donate-only contributor is not asked to
      // volunteer on any surface - product ruling. Their ELIGIBILITY is
      // unchanged: activation still makes them `active` and mayClaim still
      // returns true, so a link handed to them another way still works.
      // Invariant 47 is untouched.
      donation = donationReturnState(row, board.boardId);
    }

    // The ONE price a contributor sees, and its deadline while early bird is
    // live. Decided here rather than in the view, which stays pure.
    // publicPriceDisplay() calls the same predicate claim-price.ts charges on -
    // a promotion keyed on its own arithmetic can advertise a discount the
    // checkout no longer applies.
    const price = publicPriceDisplay({
      squarePrice: board.squarePrice,
      earlyBirdPriceCents: board.earlyBirdPriceCents,
      earlyBirdEndsAt: board.earlyBirdEndsAt,
    });

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
        price={price}
        donation={donation}
        timezone={board.timezone}
        raisedCents={board.finalRaisedCents ?? totals.raisedCents}
        goalCents={board.fundraisingGoalCents}
        supporterCount={supporters.length}
        openCount={openCount}
        slug={board.slug}
        hasEvent={board.event != null}
        signupSheetExists={board.event?.signupSheet != null}
        cashModeEnabled={board.cashModeEnabled}
        stripeConnected={board.host.stripeChargesEnabled ?? false}
        hasPrize={board.prizePoolPercent > 0}
        status={board.status}
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
