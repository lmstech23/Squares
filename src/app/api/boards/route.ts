import { randomInt } from "crypto";
import { PLATFORM_OWNER_ID } from "@/lib/constants";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { prisma } from "@/lib/prisma";
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

    if (!body.gameName?.trim()) {
      return NextResponse.json(
        { error: "Game name is required." },
        { status: 400 }
      );
    }

    if (!body.teamRow?.trim() || !body.teamCol?.trim()) {
      return NextResponse.json(
        { error: "Both team names are required." },
        { status: 400 }
      );
    }

    if (!body.squarePrice || body.squarePrice < 100) {
      return NextResponse.json(
        { error: "Price per square must be at least $1." },
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
    const gridType: GridType = body.gridType ?? "standard";
    if (gridType !== "standard" && gridType !== "double") {
      return NextResponse.json(
        { error: "Invalid grid type. Must be standard or double." },
        { status: 400 }
      );
    }
    const totalSquares = gridType === "double" ? 25 : 100;

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
      teamRow: body.teamRow.trim(),
      teamCol: body.teamCol.trim(),
      periodType,
      periodLabels,
      payoutStructure,
      hostCutPercent,
      maxSquaresPerPlayer: 10,
      currency: "USD",
      hostPayoutResponsible: true,
      hostVenmo,
      hostZelle,
      hostCashapp,
      hostPaypal,
      payoutVisibility: payoutVisibility as any,
      requirePlayerPayout,
      // PHASE 1 new fields
      sportType: body.sportType,
      gridType,
      ...(isCashHost ? {
        cashModeEnabled: true,
        cashPin: cashPin,
        cashLiabilityAccepted: true,
      } : {}),
    };

    // --- Guard: one pending board per host at a time ---
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
