import { PLATFORM_OWNER_ID } from "@/lib/constants";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { prisma } from "@/lib/prisma";
import { generateSlug } from "@/lib/slug";

// ============================================================
// Phase 1 changes:
//   1. Accept sportType (required) — drives periodType server-side
//   2. Accept gridType (optional, default "standard"); reject "double"
//      until Phase 2 ships winner calc for 5×5 boards
//   3. Server is source of truth for periodType + periodLabels.
//      Any periodType the client sends is ignored.
//   4. Fixed period labels: quarters now ["Q1","Q2","Q3","Final"]
//      (was ["Q1","Q2","Q3","Q4"]; aligned with SYSTEM-FLOW.md)
// ============================================================

type SportType = "nba" | "nfl" | "cbb";
type GridType = "standard" | "double";
type PeriodType = "halves" | "quarters";

const VALID_SPORTS: SportType[] = ["nba", "nfl", "cbb"];

// Server-side derivation: sport → period structure
const PERIOD_TYPE_BY_SPORT: Record<SportType, PeriodType> = {
  nba: "quarters",
  nfl: "quarters",
  cbb: "halves",
};

const PERIOD_LABELS_BY_TYPE: Record<PeriodType, string[]> = {
  halves: ["H1", "Final"],
  quarters: ["Q1", "Q2", "Q3", "Final"],
};

interface CreateBoardBody {
  gameName: string;
  sportType: SportType;
  squarePrice: number; // dollars (converted to cents)
  teamRow: string;
  teamCol: string;
  gridType?: GridType; // optional; "standard" if omitted. "double" rejected in Phase 1.
  hostCutPercent?: number; // 0–50, default 0
  payoutStructure: Record<string, number>; // keyed by period label, percentages totaling 100
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

    // 2. Stripe readiness gate
    if (!host.stripeChargesEnabled) {
      return NextResponse.json(
        { error: "Stripe account not ready. Complete onboarding first." },
        { status: 403 }
      );
    }

    // 2b. Credit gate — platform owner bypasses
    if (host.id !== PLATFORM_OWNER_ID && host.boardCredits < 1) {
      return NextResponse.json(
        {
          error: "No board credits remaining.",
          needsCredits: true,
          pricePerBoard: 900,
        },
        { status: 402 }
      );
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

    if (!body.squarePrice || body.squarePrice < 1) {
      return NextResponse.json(
        { error: "Price per square must be at least $1." },
        { status: 400 }
      );
    }

    // 3a. Validate sportType (required, enum)
    if (!body.sportType || !VALID_SPORTS.includes(body.sportType)) {
      return NextResponse.json(
        { error: "Sport is required. Must be nba, nfl, or cbb." },
        { status: 400 }
      );
    }

    // 3b. Validate gridType (optional; only "standard" allowed in Phase 1)
    const gridType: GridType = body.gridType ?? "standard";
    if (gridType !== "standard") {
      return NextResponse.json(
        {
          error:
            "Double-digit boards aren't available yet. Pick Standard for now.",
        },
        { status: 400 }
      );
    }

    // 4. Derive period type and labels server-side from sportType.
    //    Client never sets these directly.
    const periodType = PERIOD_TYPE_BY_SPORT[body.sportType];
    const periodLabels = PERIOD_LABELS_BY_TYPE[periodType];

    // 5. Validate host cut percentage
    const hostCutPercent = body.hostCutPercent ?? 0;
    if (
      typeof hostCutPercent !== "number" ||
      hostCutPercent < 0 ||
      hostCutPercent > 50
    ) {
      return NextResponse.json(
        { error: "Host cut must be between 0% and 50%." },
        { status: 400 }
      );
    }

    // 6. Validate payout structure — keys must match periodLabels exactly,
    //    values must be numbers summing to 100.
    if (
      !body.payoutStructure ||
      typeof body.payoutStructure !== "object"
    ) {
      return NextResponse.json(
        { error: "Payout structure is required." },
        { status: 400 }
      );
    }

    const payoutKeys = Object.keys(body.payoutStructure);
    const expectedKeys = new Set(periodLabels);
    if (
      payoutKeys.length !== periodLabels.length ||
      !payoutKeys.every((k) => expectedKeys.has(k))
    ) {
      return NextResponse.json(
        {
          error: `Payout structure keys must match period labels: ${periodLabels.join(", ")}.`,
        },
        { status: 400 }
      );
    }

    const values = Object.values(body.payoutStructure);
    if (!values.every((v) => typeof v === "number" && v >= 0)) {
      return NextResponse.json(
        { error: "Payout values must be non-negative numbers." },
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

    // 7. Generate unique slug (retry on collision)
    let slug = generateSlug();
    let attempts = 0;
    while (attempts < 5) {
      const existing = await prisma.board.findUnique({ where: { slug } });
      if (!existing) break;
      slug = generateSlug();
      attempts++;
    }

    // 8. Create Board + 100 Squares in one transaction
    const squarePriceCents = Math.round(body.squarePrice * 100);

    const board = await prisma.$transaction(async (tx) => {
      // Deduct 1 credit atomically (skip for platform owner)
      let creditsAfter = host.boardCredits;
      if (host.id !== PLATFORM_OWNER_ID) {
        const updatedHost = await tx.host.update({
          where: { id: host.id, boardCredits: { gte: 1 } },
          data: { boardCredits: { decrement: 1 } },
        });
        creditsAfter = updatedHost.boardCredits;

        await tx.creditTransaction.create({
          data: {
            hostId: host.id,
            type: "board_created",
            amount: -1,
            balanceAfter: creditsAfter,
          },
        });
      }

      const newBoard = await tx.board.create({
        data: {
          hostId: host.id,
          gameName: body.gameName.trim(),
          squarePrice: squarePriceCents,
          totalSquares: 100,
          status: "open",
          slug,
          teamRow: body.teamRow.trim(),
          teamCol: body.teamCol.trim(),
          periodType,
          periodLabels,
          payoutStructure: body.payoutStructure,
          hostCutPercent,
          maxSquaresPerPlayer: 10,
          currency: "USD",
          hostPayoutResponsible: true,
          // Phase 1 new fields
          sportType: body.sportType,
          gridType,
          // rowPairs / colPairs stay NULL — only used for gridType="double" in Phase 2
        },
      });

      // Create 100 squares (positions 0–99)
      await tx.square.createMany({
        data: Array.from({ length: 100 }, (_, i) => ({
          boardId: newBoard.boardId,
          position: i,
          paymentStatus: "open" as const,
        })),
      });

      return newBoard;
    });

    return NextResponse.json({
      boardId: board.boardId,
      slug: board.slug,
    });
  } catch (error) {
    console.error("Board creation error:", error);
    return NextResponse.json(
      { error: "Failed to create board." },
      { status: 500 }
    );
  }
}
