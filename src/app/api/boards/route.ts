import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { prisma } from "@/lib/prisma";
import { generateSlug } from "@/lib/slug";

// Period labels derived from periodType
const PERIOD_LABELS: Record<string, string[]> = {
  halves: ["H1", "Final"],
  quarters: ["Q1", "Q2", "Q3", "Q4"],
};

interface CreateBoardBody {
  gameName: string;
  squarePrice: number; // dollars (converted to cents)
  teamRow: string;
  teamCol: string;
  periodType?: "halves" | "quarters"; // defaults to halves for pilot
  hostCutPercent?: number; // 0-50, default 0. Host keeps this %, players split the rest.
  payoutStructure: Record<string, number>; // keyed by period label, e.g. { "H1": 50, "Final": 50 }
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

    // 4. Determine period type and labels
    const periodType = body.periodType ?? "halves"; // default for March Madness pilot
    const periodLabels = PERIOD_LABELS[periodType];

    if (!periodLabels) {
      return NextResponse.json(
        { error: "Invalid period type. Must be 'halves' or 'quarters'." },
        { status: 400 }
      );
    }

    // 5. Validate host cut percentage
    const hostCutPercent = body.hostCutPercent ?? 0;
    if (!Number.isInteger(hostCutPercent) || hostCutPercent < 0 || hostCutPercent > 50) {
      return NextResponse.json(
        { error: "Host cut must be an integer between 0 and 50." },
        { status: 400 }
      );
    }

    // 6. Validate payout structure — keys must match periodLabels, values sum to 100%
    const payoutStructure = body.payoutStructure;

    if (!payoutStructure || typeof payoutStructure !== "object") {
      return NextResponse.json(
        { error: "Payout structure is required." },
        { status: 400 }
      );
    }

    // Check that every period label has a payout entry
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

    // 6. Generate unique slug (retry on collision)
    let slug = generateSlug();
    let attempts = 0;
    while (attempts < 5) {
      const existing = await prisma.board.findUnique({ where: { slug } });
      if (!existing) break;
      slug = generateSlug();
      attempts++;
    }

    // 7. Create Board + 100 Squares in one transaction
    const squarePriceCents = Math.round(body.squarePrice * 100);

    const board = await prisma.$transaction(async (tx) => {
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
          payoutStructure,
          hostCutPercent,
          maxSquaresPerPlayer: 10,
          currency: "USD",
          hostPayoutResponsible: true,
        },
      });

      // Create 100 squares (positions 0-99)
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
