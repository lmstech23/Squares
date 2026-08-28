import { randomInt } from "crypto";
import { PLATFORM_OWNER_ID } from "@/lib/constants";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { parseZoned, endOfDayZoned } from "@/lib/zoned-time";
import { generateSlug } from "@/lib/slug";

// ============================================================
// PHASE 1 ADDITIONS:
//   1. Accept sportType (required) — drives periodType server-side
//   2. Accept gridType (optional, default "standard"); reject "double"
//      until Phase 2 ships winner calc for 5×5 boards
//   3. Server is source of truth for periodType + periodLabels.
//
// FIXED: quarters labels now end in "Final" (was "Q4"),
// matching SYSTEM-FLOW.md and the locked decision.
//
// REMOVED: nothing. All three creation paths (platform owner,
// has credits, no credits → pending), cash-mode auto-PIN,
// pending guard, and payout coordination preserved.
// ============================================================

type SportType = "nba" | "nfl" | "cbb";
type GridType = "standard" | "double";

const VALID_SPORTS: SportType[] = ["nba", "nfl", "cbb"];

// Server-side derivation: sport → period structure
const PERIOD_TYPE_BY_SPORT: Record<SportType, "halves" | "quarters"> = {
  nba: "quarters",
  nfl: "quarters",
  cbb: "halves",
};

const PERIOD_LABELS: Record<string, string[]> = {
  halves: ["H1", "Final"],
  quarters: ["Q1", "Q2", "Q3", "Final"],
};

// ============================================================
// FUNDRAISER (v2 §5, build step A3)
//   boardType branches validation and the shape of boardData. Game Day is
//   untouched — every existing field, path, and guard behaves as before.
//   Phase A: no prize fields. prizePoolPercent stays 0 and is never accepted
//   from the client, because a host must not be able to switch on a drawing
//   that has nothing behind it (v2 §16).
// ============================================================

type BoardType = "game" | "fundraiser";

const VALID_SQUARE_COUNTS = [25, 50, 75, 100];

/** Phase A is single-region — v2 §5. IANA, never a fixed offset. */
const BOARD_TIMEZONE = "America/New_York";

interface CreateBoardBody {
  gameName: string;
  sportType: SportType;
  squarePrice: number;
  teamRow: string;
  teamCol: string;
  gridType?: GridType;
  hostCutPercent?: number;
  payoutStructure: Record<string, number>;
  // Payout coordination
  hostVenmo?: string | null;
  hostZelle?: string | null;
  hostCashapp?: string | null;
  hostPaypal?: string | null;
  payoutVisibility?: "public" | "pin_gated";
  requirePlayerPayout?: boolean;
  // Fundraiser — v2 §5
  boardType?: BoardType;
  causeDescription?: string | null;
  totalSquares?: number;
  fundraisingGoalCents?: number | null;
  campaignEndsAt?: string;
  earlyBirdPriceCents?: number | null;
  earlyBirdEndsAt?: string | null;
  cashHoldDays?: number;
  // Optional event block — v2 §5
  hasEvent?: boolean;
  eventName?: string | null;
  eventStartsAt?: string;
  eventVenue?: string | null;
}

/// Parsed event config, or null when the board has no event attached.
interface EventInput {
  name: string | null;
  startsAt: Date;
  timezone: string;
  venue: string | null;
}

export async function POST(request: Request) {
  try {
    // 1. Authenticate
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const host = await prisma.host.findUnique({
      where: { supabaseUserId: user.id },
    });

    if (!host) {
      return NextResponse.json({ error: "Host not found" }, { status: 404 });
    }


    // 3. Parse + validate body
    const body: CreateBoardBody = await request.json();

    const boardType: BoardType = body.boardType === "fundraiser" ? "fundraiser" : "game";

    if (!body.gameName?.trim()) {
      return NextResponse.json(
        { error: boardType === "fundraiser"
            ? "Tell people what you're raising money for."
            : "Game name is required." },
        { status: 400 }
      );
    }

    if (!body.squarePrice || body.squarePrice < 100) {
      return NextResponse.json(
        {
          error:
            boardType === "fundraiser"
              ? "Contribution per square must be at least $1."
              : "Price per square must be at least $1.",
        },
        { status: 400 }
      );
    }

    // Shared across both board types.
    let totalSquares: number;
    let eventInput: EventInput | null = null;
    // Game Day only — left undefined on fundraiser boards, where the columns
    // are unused (v2 §3).
    let gridType: GridType = "standard";
    let gameOnlyData: Partial<Prisma.BoardUncheckedCreateInput> = {};
    let fundraiserOnlyData: Partial<Prisma.BoardUncheckedCreateInput> = {};

    if (boardType === "game") {
      // ---------- Game Day — unchanged ----------
      if (!body.teamRow?.trim() || !body.teamCol?.trim()) {
        return NextResponse.json(
          { error: "Both team names are required." },
          { status: 400 }
        );
      }

      // PHASE 1: Validate sportType (required, enum)
      if (!body.sportType || !VALID_SPORTS.includes(body.sportType)) {
        return NextResponse.json(
          { error: "Sport is required. Must be nba, nfl, or cbb." },
          { status: 400 }
        );
      }

      // PHASE 2: gridType determines square count
      gridType = body.gridType ?? "standard";
      if (gridType !== "standard" && gridType !== "double") {
        return NextResponse.json(
          { error: "Invalid grid type. Must be standard or double." },
          { status: 400 }
        );
      }
      totalSquares = gridType === "double" ? 25 : 100;

      // 4. Derive period type and labels server-side from sportType
      const periodType = PERIOD_TYPE_BY_SPORT[body.sportType];
      const periodLabels = PERIOD_LABELS[periodType];

      // 5. Validate host cut percentage
      const hostCutPercent = body.hostCutPercent ?? 0;
      if (!Number.isInteger(hostCutPercent) || hostCutPercent < 0 || hostCutPercent > 50) {
        return NextResponse.json(
          { error: "Host cut must be an integer between 0 and 50." },
          { status: 400 }
        );
      }

      // 6. Validate payout structure
      const payoutStructure = body.payoutStructure;

      if (!payoutStructure || typeof payoutStructure !== "object") {
        return NextResponse.json(
          { error: "Payout structure is required." },
          { status: 400 }
        );
      }

      for (const label of periodLabels) {
        if (payoutStructure[label] == null) {
          return NextResponse.json(
            { error: `Payout structure must include "${label}".` },
            { status: 400 }
          );
        }
      }

      const values = periodLabels.map((l) => payoutStructure[l]);

      if (values.some((v) => typeof v !== "number" || v < 0)) {
        return NextResponse.json(
          { error: "Payout percentages cannot be negative." },
          { status: 400 }
        );
      }

      const total = values.reduce((sum, v) => sum + v, 0);
      if (Math.abs(total - 100) > 0.01) {
        return NextResponse.json(
          { error: "Payout percentages must total 100%." },
          { status: 400 }
        );
      }

      gameOnlyData = {
        teamRow: body.teamRow.trim(),
        teamCol: body.teamCol.trim(),
        periodType,
        periodLabels,
        payoutStructure,
        hostCutPercent,
        sportType: body.sportType,
        gridType,
      };
    } else {
      // ---------- Fundraiser — v2 §5 ----------
      // No sport, teams, periods, payout split, or host cut. If any of those
      // arrive they are ignored, not stored.
      totalSquares = body.totalSquares ?? 100;
      if (!VALID_SQUARE_COUNTS.includes(totalSquares)) {
        return NextResponse.json(
          { error: "Number of squares must be 25, 50, 75, or 100." },
          { status: 400 }
        );
      }

      // Phase A is single-region. Hardcoded rather than selected, and stored
      // as an IANA zone rather than a fixed offset: "EST" as a literal -5
      // would be an hour wrong from March through November, and homecoming is
      // in October. The column stays, so adding a selector later is a form
      // change rather than a migration. v2 §5.
      const timezone = BOARD_TIMEZONE;

      // Campaign close is required on every fundraiser board, prize or not —
      // drawDate no longer doubles as the backstop (v2 §5).
      // Date only. A close date means the end of that day, so it lands at
      // 11:59:59 PM local — pick Oct 9 and someone clicking through at 4pm on
      // the 9th makes it. v2 §5.
      const campaignEndsAt = endOfDayZoned(body.campaignEndsAt, timezone);
      if (!campaignEndsAt) {
        return NextResponse.json(
          { error: "A campaign close date is required." },
          { status: 400 }
        );
      }

      // Early bird — money doc §8B. Optional; the end date is required only
      // when a price is set. No validation relates it to the other two dates.
      let earlyBirdPriceCents: number | null = null;
      let earlyBirdEndsAt: Date | null = null;
      if (body.earlyBirdPriceCents != null) {
        earlyBirdPriceCents = body.earlyBirdPriceCents;
        if (!Number.isInteger(earlyBirdPriceCents) || earlyBirdPriceCents < 100) {
          return NextResponse.json(
            { error: "Early bird price must be at least $1." },
            { status: 400 }
          );
        }
        if (earlyBirdPriceCents >= body.squarePrice) {
          return NextResponse.json(
            { error: "Early bird price must be below the standard price." },
            { status: 400 }
          );
        }
        // Date only, same end-of-day rule as campaign close.
        earlyBirdEndsAt = endOfDayZoned(body.earlyBirdEndsAt, timezone);
        if (!earlyBirdEndsAt) {
          return NextResponse.json(
            { error: "Set a date for the early bird price to end." },
            { status: 400 }
          );
        }
      }

      // Optional host-entered goal. Null means no progress bar — v2 §7.
      let fundraisingGoalCents: number | null = null;
      if (body.fundraisingGoalCents != null) {
        fundraisingGoalCents = body.fundraisingGoalCents;
        if (!Number.isInteger(fundraisingGoalCents) || fundraisingGoalCents < 100) {
          return NextResponse.json(
            { error: "Fundraising goal must be at least $1." },
            { status: 400 }
          );
        }
      }

      const cashHoldDays = body.cashHoldDays ?? 7;
      if (!Number.isInteger(cashHoldDays) || cashHoldDays < 1 || cashHoldDays > 60) {
        return NextResponse.json(
          { error: "Cash hold window must be between 1 and 60 days." },
          { status: 400 }
        );
      }

      // Optional event block — v2 §5. Independent of every other date.
      if (body.hasEvent) {
        // Start time: the earlier occurrence — doors open at the first 1:30am.
        const startsAt = parseZoned(body.eventStartsAt, timezone, "earlier");
        if (!startsAt) {
          return NextResponse.json(
            { error: "An event date and time is required." },
            { status: 400 }
          );
        }
        // No attendance cap. One confirmed square mints one admission pass
        // (addendum v2.0 §1), so there is nothing to collect here.
        eventInput = {
          name: body.eventName?.trim() || null,
          startsAt,
          timezone,
          venue: body.eventVenue?.trim() || null,
        };
      }

      // At least one handle is required — without one there is nowhere to send
      // money, and direct payment is how most contributors will pay (§6C).
      const anyHandle = [
        body.hostVenmo,
        body.hostZelle,
        body.hostCashapp,
        body.hostPaypal,
      ].some((h) => h?.trim());
      if (!anyHandle) {
        return NextResponse.json(
          {
            error:
              "Add at least one way to receive payment — Venmo, Zelle, Cash App, or PayPal.",
          },
          { status: 400 }
        );
      }

      fundraiserOnlyData = {
        causeDescription: body.causeDescription?.trim() || null,
        campaignEndsAt,
        fundraisingGoalCents,
        timezone,
        earlyBirdPriceCents,
        earlyBirdEndsAt,
        cashHoldDays,
        // Phase A: prizes are deferred and never accepted from the client.
        // prizePoolPercent stays at its 0 default — v2 §16.
        hostCutPercent: 0,
        // Direct payment is always on and never a toggle — §6C. No PIN: a PIN
        // exists so a host can hand a code to someone standing in front of
        // her, and on a fundraiser nobody is standing in front of her. The
        // contributor picks the method at checkout instead.
        cashModeEnabled: true,
        cashPin: null,
        cashLiabilityAccepted: true,
      };
    }

    // 7. Generate unique slug
    let slug = generateSlug();
    let attempts = 0;
    while (attempts < 5) {
      const existing = await prisma.board.findUnique({ where: { slug } });
      if (!existing) break;
      slug = generateSlug();
      attempts++;
    }

    // 8. Determine creation path
    const isPlatformOwner = host.id === PLATFORM_OWNER_ID;
    const hasCredits = host.boardCredits >= 1;
    const squarePriceCents = body.squarePrice;

    // --- Auto-enable cash mode for cash-only hosts ---


    const isCashHost = host.paymentPreference === "cash";


    const cashPin = isCashHost ? String(randomInt(1000, 10000)) : null;



     // Payout coordination fields
    const hostVenmo = body.hostVenmo?.trim() || null;
    const hostZelle = body.hostZelle?.trim() || null;
    const hostCashapp = body.hostCashapp?.trim() || null;
    const hostPaypal = body.hostPaypal?.trim() || null;
    const payoutVisibility = body.payoutVisibility === "pin_gated" ? "pin_gated" : "public";
    const requirePlayerPayout = body.requirePlayerPayout ?? false;


    const boardData = {
      hostId: host.id,
      gameName: body.gameName.trim(),
      squarePrice: squarePriceCents,
      totalSquares,
      slug,
      boardType,
      maxSquaresPerPlayer: 10,
      currency: "USD",
      hostPayoutResponsible: true,
      hostVenmo,
      hostZelle,
      hostCashapp,
      hostPaypal,
      payoutVisibility: payoutVisibility as any,
      requirePlayerPayout,
      // Exactly one of these is populated. Game Day carries teams, sport,
      // periods, payout split and host cut; fundraiser carries none of them.
      ...gameOnlyData,
      ...fundraiserOnlyData,
      // Game Day only. Fundraiser boards set these above and must not receive
      // a PIN — §6C.
      ...(isCashHost && boardType === "game"
        ? {
            cashModeEnabled: true,
            cashPin: cashPin,
            cashLiabilityAccepted: true,
          }
        : {}),
    };

    // Event config is written in the same transaction as the board, on every
    // creation path. Terms lock at the first confirmed contribution
    // (invariant 16), which cannot happen before the board exists.
    async function createEvent(tx: Prisma.TransactionClient, boardId: string) {
      if (!eventInput) return;
      await tx.event.create({
        data: {
          boardId,
          name: eventInput.name,
          startsAt: eventInput.startsAt,
          timezone: eventInput.timezone,
          venue: eventInput.venue,
        },
      });
    }

    // --- Path 0: Fundraiser — no credit gate, no pending_payment, no fee ---
    //
    // v2 §14. A fundraiser board activates the moment it is created.
    //
    // Credits are the wrong instrument here, not merely mispriced. Game Day
    // credits work because a board is a discrete event a host runs a few times
    // a season. A fundraiser is a campaign that may raise $200 or $20,000, and
    // a $9 gate in front of someone raising money for a school is not
    // defensible at either end of that range.
    //
    // No fee mechanism at all on this path — not a fee set to zero. The model
    // is genuinely undecided (§14: most fundraiser money never touches Stripe,
    // so a Connect percentage collects almost nothing), and a speculative
    // column would be guessing at it.
    //
    // Game Day is untouched below: credits, pending_payment, and the 48-hour
    // activation window all behave exactly as before.
    if (boardType === "fundraiser") {
      const board = await prisma.$transaction(async (tx) => {
        const newBoard = await tx.board.create({
          data: {
            ...boardData,
            status: "open",
            activatedAt: new Date(),
          },
        });

        await tx.square.createMany({
          data: Array.from({ length: totalSquares }, (_, i) => ({
            boardId: newBoard.boardId,
            position: i,
            paymentStatus: "open" as const,
          })),
        });

        await createEvent(tx, newBoard.boardId);

        return newBoard;
      });

      return NextResponse.json({ boardId: board.boardId, slug: board.slug });
    }

    // --- Guard: one pending board per host at a time ---
    //
    // Game Day only, and it has to be: a fundraiser creates no pending board,
    // so an unpaid Game Day draft sitting in the way would block a fundraiser
    // that never needed a credit in the first place.
    const existingPending = await prisma.board.findFirst({
      where: { hostId: host.id, status: 'pending_payment' },
    });
    if (existingPending) {
      return NextResponse.json(
        {
          error: 'You have a pending board awaiting payment. Complete or cancel it first.',
          pendingBoardId: existingPending.boardId,
          redirectTo: `/host/checkout?boardId=${existingPending.boardId}`,
        },
        { status: 409 }
      );
    }

    // --- Path 1: Platform owner — skip credits entirely ---
    if (isPlatformOwner) {
      const board = await prisma.$transaction(async (tx) => {

      const newBoard = await tx.board.create({
          data: {
            ...boardData,
            status: "open",
            activatedAt: new Date(),
          },
        });

        await tx.square.createMany({
          data: Array.from({ length: totalSquares }, (_, i) => ({
            boardId: newBoard.boardId,
            position: i,
            paymentStatus: "open" as const,
          })),
        });

        await createEvent(tx, newBoard.boardId);

        return newBoard;
      });

      return NextResponse.json({ boardId: board.boardId, slug: board.slug });
    }

    // --- Path 2: Host has credits — deduct and activate ---
    if (hasCredits) {
      const board = await prisma.$transaction(async (tx) => {
        const updatedHost = await tx.host.update({
          where: { id: host.id, boardCredits: { gte: 1 } },
          data: { boardCredits: { decrement: 1 } },
        });

        const newBoard = await tx.board.create({
          data: {
            ...boardData,
            status: "open",
            activatedAt: new Date(),
          },
        });

        await tx.creditTransaction.create({
          data: {
            hostId: host.id,
            type: "board_created",
            amount: -1,
            balanceAfter: updatedHost.boardCredits,
            boardId: newBoard.boardId,
          },
        });

        await tx.square.createMany({
          data: Array.from({ length: totalSquares }, (_, i) => ({
            boardId: newBoard.boardId,
            position: i,
            paymentStatus: "open" as const,
          })),
        });

        await createEvent(tx, newBoard.boardId);

        return newBoard;
      });

      return NextResponse.json({ boardId: board.boardId, slug: board.slug });
    }

    // --- Path 3: No credits — create pending_payment board ---
    const pendingExpiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000);

    const board = await prisma.$transaction(async (tx) => {
      const newBoard = await tx.board.create({
        data: {
          ...boardData,
          status: "pending_payment",
          pendingExpiresAt,
        },
      });

      await createEvent(tx, newBoard.boardId);

      // No squares created — board is not shareable until paid
      return newBoard;
    });

    return NextResponse.json(
      {
        boardId: board.boardId,
        slug: board.slug,
        status: "pending_payment",
        pendingExpiresAt: board.pendingExpiresAt,
        redirectTo: `/host/checkout?boardId=${board.boardId}`,
      },
      { status: 402 }
    );
  } catch (error) {
    console.error("Board creation error:", error);
    return NextResponse.json(
      { error: "Failed to create board." },
      { status: 500 }
    );
  }
}
