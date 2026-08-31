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
import { priceScheduleLabel } from "@/lib/claim-price";
import { hasConfirmedContribution, LOCK_REASON } from "@/lib/board-lock";
import EditFundraiserButton from "./edit-fundraiser-button";
import { calculateWinners } from "@/lib/winners";
import NotifyWinnerButton from "./notify-winner-button";
import EditDetailsButton from "./edit-details-button";
import FundraiserPanel from "./fundraiser-panel";
import ContributorList, { type ContributorRow } from "./contributor-list";
import EventPanel, { type GrantRow, type CheckinStaffLink } from "./event-panel";
import { baseUrlFromHeaders } from "@/lib/base-url";
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
          pricePaidCents: true,
        },
        
      },
      event: { select: { id: true } },
    },
  });

  if (!board || board.hostId !== host.id) {
    notFound();
  }

  // Inline cleanup: release expired Stripe checkouts on page load (cash reservations stay until host acts)
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

  // Direct payment on fundraiser boards — §6C. cashModeEnabled is forced true
  // at creation and the toggle never renders: switching it off would make card
  // the only way to contribute, and direct payment is how most people will pay.
  const isFundraiser = board.boardType === "fundraiser";
  // Built from this deployment's own host, so a preview's share panel and QR
  // point at the preview rather than at production.
  const boardUrl = `${await baseUrlFromHeaders()}/board/${board.slug}`;

  // ---- Fundraiser host dashboard — v2 §9 ----
  //
  // Returns before every Game Day surface. §7's must-not-appear list governs
  // this screen too: no pot in the header, no "numbers will randomize", no
  // score entry, no winner cards. Absent by construction, not by omission.
  if (isFundraiser) {
    const raised = await prisma.square.aggregate({
      where: { boardId: board.boardId, paymentStatus: "paid" },
      _sum: { pricePaidCents: true },
    });

    // Invariant 16. Shared predicate — lib/board-lock.ts — so contribution
    // price, early-bird and prize terms call the same one when they get edit
    // surfaces rather than each growing their own.
    const contributionsLocked = await hasConfirmedContribution(board.boardId);

    // Prefill datetime-local in the EVENT's own timezone, not the server's.
    // Rendering a UTC instant into a wall-clock box without converting is how a
    // host "corrects" a time by five hours without touching anything.
    const eventDetail = board.event
      ? await prisma.event.findUnique({
          where: { id: board.event.id },
          select: { name: true, venue: true, startsAt: true, endsAt: true, timezone: true },
        })
      : null;

    const forInput = (d: Date | null, tz: string): string => {
      if (!d) return "";
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", hour12: false,
      }).formatToParts(d);
      const g = (t: string) => parts.find((x) => x.type === t)?.value ?? "";
      return `${g("year")}-${g("month")}-${g("day")}T${g("hour")}:${g("minute")}`;
    };

    const byStatus = (status: string) =>
      board.squares.filter((sq) => sq.paymentStatus === status);

    // Group live checkouts by batch so age is reported per purchase, which is
    // what the host is deciding about.
    const now = new Date().getTime();
    const pendingSquares = await prisma.square.findMany({
      where: { boardId: board.boardId, paymentStatus: "pending" },
      select: { batchId: true, holdExpiresAt: true, checkoutExpiresAt: true },
    });

    const batchMap = new Map<
      string,
      { count: number; holdExpiresAt: Date | null }
    >();
    for (const sq of pendingSquares) {
      if (!sq.batchId) continue;
      const entry = batchMap.get(sq.batchId) ?? {
        count: 0,
        holdExpiresAt: sq.holdExpiresAt,
      };
      entry.count++;
      batchMap.set(sq.batchId, entry);
    }

    const pendingBatches = Array.from(batchMap, ([batchId, v]) => ({
      batchId,
      count: v.count,
      // Held-for, derived from the 10-minute window ending at holdExpiresAt.
      heldMinutes: v.holdExpiresAt
        ? Math.max(
            0,
            Math.round((now - (v.holdExpiresAt.getTime() - 10 * 60_000)) / 60_000)
          )
        : 0,
      expired: v.holdExpiresAt ? v.holdExpiresAt.getTime() <= now : false,
    }));

    const awaiting = byStatus("reserved_cash");

    // One row per contributor, keyed by email — a person who bought twice is
    // one row, not two. Squares mid-checkout are excluded: they are not a
    // contribution yet and may release in minutes.
    const claimed = await prisma.square.findMany({
      where: {
        boardId: board.boardId,
        paymentStatus: { in: ["paid", "reserved_cash"] },
        playerEmail: { not: null },
      },
      select: {
        playerName: true,
        playerEmail: true,
        paymentStatus: true,
        claimedAt: true,
      },
    });

    const byContributor = new Map<string, ContributorRow>();
    for (const sq of claimed) {
      const email = sq.playerEmail!.toLowerCase();
      const existing = byContributor.get(email);
      const isPaid = sq.paymentStatus === "paid";
      const iso = sq.claimedAt ? sq.claimedAt.toISOString() : null;

      if (!existing) {
        byContributor.set(email, {
          name: sq.playerName ?? "—",
          email,
          tickets: 1,
          claimedAt: iso,
          status: isPaid ? "CONFIRMED" : "AWAITING",
        });
        continue;
      }

      existing.tickets++;
      // Earliest claim across their squares — how long they have been waiting.
      if (iso && (!existing.claimedAt || iso < existing.claimedAt)) {
        existing.claimedAt = iso;
      }
      // Anything outstanding keeps the row off CONFIRMED. A host chasing
      // money must not see a green row with an unpaid square behind it.
      const wanted = isPaid ? "CONFIRMED" : "AWAITING";
      if (existing.status !== wanted) existing.status = "MIXED";
    }

    const contributors = Array.from(byContributor.values());

    // Event panel — only on a board with an event.
    let expected = 0;
    let unpaidForecast = 0;
    const grantRows: GrantRow[] = [];
    let checkinStaffLinks: CheckinStaffLink[] = [];

    if (board.event) {
      // Expected counts active and used passes on active supporters. Donated
      // purchases contribute zero, which is the point of the checkbox.
      expected = await prisma.admissionPass.count({
        where: {
          supporter: { eventId: board.event.id, status: "active" },
          status: { in: ["active", "used"] },
        },
      });

      checkinStaffLinks = (
        await prisma.checkinStaffAccess.findMany({
          where: { eventId: board.event.id },
          select: { id: true, label: true, revokedAt: true },
          orderBy: { createdAt: "desc" },
        })
      ).map((v: { id: string; label: string; revokedAt: Date | null }) => ({
        id: v.id,
        label: v.label,
        revoked: v.revokedAt != null,
      }));

      const grants = await prisma.admissionGrant.findMany({
        where: { eventId: board.event.id },
        select: {
          id: true,
          squareBatchId: true,
          donateAdmissions: true,
          supporter: { select: { id: true, name: true, email: true } },
        },
        orderBy: { createdAt: "desc" },
      });

      for (const g of grants) {
        if (!g.squareBatchId) continue;

        const [paidSquares, awaitingSquares, used] = await Promise.all([
          prisma.square.count({
            where: { batchId: g.squareBatchId, paymentStatus: "paid" },
          }),
          prisma.square.count({
            where: { batchId: g.squareBatchId, paymentStatus: "reserved_cash" },
          }),
          prisma.admissionPass.count({
            where: {
              supporter: { id: g.supporter.id },
              status: "used",
              square: { batchId: g.squareBatchId },
            },
          }),
        ]);

        // A forecast, never a headcount: what would exist if outstanding
        // direct payments confirm. Donated purchases forecast nothing.
        if (!g.donateAdmissions) unpaidForecast += awaitingSquares;

        grantRows.push({
          grantId: g.id,
          name: g.supporter.name,
          email: g.supporter.email,
          tickets: g.donateAdmissions ? 0 : paidSquares,
          donated: g.donateAdmissions,
          usedCount: used,
        });
      }
    }

    return (
      <div>
        <Link
          href="/host/boards"
          className="text-sm text-gray-400 hover:text-white mb-4 inline-block"
        >
          ← Back to Boards
        </Link>
        <h1 className="text-xl font-bold">{board.gameName}</h1>
        {/* The CURRENT contribution price, including an active early-bird
            window. This read `${board.squarePrice / 100} per square`
            unconditionally, so a host with early bird running saw the full
            price while her contributors were being charged the early one —
            the host could not see what people were actually paying.
            priceScheduleLabel is the same predicate claim-price.ts charges on;
            display never re-derives the rule. */}
        <p className="text-sm text-gray-500 mt-0.5">
          {priceScheduleLabel(board)}
        </p>
        {/* Raised is the SUM of locked pricePaidCents over confirmed squares,
            never price × count — invariant 43. With an early-bird window there
            is no single price to multiply by. This reuses the aggregate already
            computed above for FundraiserPanel; no extra query. */}
        <p className="text-sm text-gray-400 mt-0.5">
          {`$${(((board.finalRaisedCents ?? raised._sum.pricePaidCents) ?? 0) / 100).toFixed(2)} raised`}
          {` · ${byStatus("paid").length} of ${board.totalSquares} squares confirmed`}
        </p>
        {board.causeDescription && (
          <p className="text-sm text-gray-400 mt-1.5">{board.causeDescription}</p>
        )}
        <div className="mt-2 mb-6 space-y-3">
          <EditDetailsButton
            boardId={board.boardId}
            gameName={board.gameName}
            teamCol=""
            teamRow=""
          />
          <EditFundraiserButton
            boardId={board.boardId}
            hasEvent={eventDetail != null}
            locked={contributionsLocked}
            lockReason={LOCK_REASON}
            initialName={eventDetail?.name ?? ""}
            initialVenue={eventDetail?.venue ?? ""}
            initialStartsAt={forInput(eventDetail?.startsAt ?? null, eventDetail?.timezone ?? "America/New_York")}
            initialEndsAt={forInput(eventDetail?.endsAt ?? null, eventDetail?.timezone ?? "America/New_York")}
            initialTimezone={eventDetail?.timezone ?? "America/New_York"}
            initialGoal={board.fundraisingGoalCents != null ? String(board.fundraisingGoalCents / 100) : ""}
          />
        </div>

        <div className="rounded-lg border border-gray-800 bg-gray-900 p-4 mb-6">
          <p className="text-xs text-gray-500 mb-2">
            Share this link with your group
          </p>
          <ShareCard url={boardUrl} />
        </div>

        <FundraiserPanel
          boardId={board.boardId}
          status={board.status}
          finalRaisedCents={board.finalRaisedCents}
          raisedCents={board.finalRaisedCents ?? raised._sum.pricePaidCents ?? 0}
          goalCents={board.fundraisingGoalCents}
          confirmedCount={byStatus("paid").length}
          awaitingCount={awaiting.length}
          inCheckoutCount={byStatus("pending").length}
          openCount={byStatus("open").length}
          awaitingSquares={awaiting.map((sq) => ({
            squareId: sq.squareId,
            position: sq.position,
            playerName: sq.playerName,
            pricePaidCents: sq.pricePaidCents,
          }))}
          pendingBatches={pendingBatches}
        />

        {board.event && (
          <div className="mt-6">
            <EventPanel
              boardId={board.boardId}
              expected={expected}
              unpaidForecast={expected + unpaidForecast}
              grants={grantRows}
              links={checkinStaffLinks}
            />
          </div>
        )}

        <div className="mt-6">
          <ContributorList
            rows={contributors}
            boardName={board.gameName}
            hasEvent={board.event != null}
          />
        </div>
      </div>
    );
  }

  const paidCount = board.squares.filter(
    (s) => s.paymentStatus === "paid"
  ).length;
  const pendingCount = board.squares.filter(
    (s) => s.paymentStatus === "pending"
  ).length;
  const isOpen = board.status === "open";
  const hasNumbers = board.rowNumbers && board.colNumbers;

  const payout = board.payoutStructure as Record<string, number> | null;

  const totalPot = (board.squarePrice / 100) * board.totalSquares;
  const playerPool = totalPot * (1 - (board.hostCutPercent ?? 0) / 100);

  // Calculate winners — dispatcher picks standard or double strategy based on gridType
  const winners = calculateWinners(board);







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
          <div className="mt-2">
            <EditDetailsButton
              boardId={board.boardId}
              gameName={board.gameName}
              teamCol={board.teamCol ?? ""}
              teamRow={board.teamRow ?? ""}
            />
          </div>
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

      {/* Cash Mode — never rendered on a fundraiser board (§6C) */}
      {isOpen && !isFundraiser && (
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
          isFundraiser={isFundraiser}
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
                <div className="text-[10px] text-yellow-300/70 mt-1.5 flex items-center gap-1">
                  <span>💰</span>
                  {sq?.playerPayoutMethod && sq.playerPayoutMethod !== "cash"
                    ? `${sq.playerPayoutMethod === "venmo" ? "Venmo" : sq.playerPayoutMethod === "zelle" ? "Zelle" : sq.playerPayoutMethod === "paypal" ? "PayPal" : "CashApp"}: ${sq.playerPayoutHandle || "—"}`
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
                  ${Math.round(playerPool * (pct / 100))}
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
        rowPairs={(board.rowPairs as number[][] | null) ?? undefined}
        colPairs={(board.colPairs as number[][] | null) ?? undefined}
        gridType={board.gridType}
        teamCol={board.status === "open" ? "Team A" : (board.teamCol ?? undefined)}
        teamRow={board.status === "open" ? "Team B" : (board.teamRow ?? undefined)}
        winnerPositions={winnerPositions}
      />

      {/* Player list — flat by square number */}
      <SquareList squares={board.squares} />
    </div>
  );
}
