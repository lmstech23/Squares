import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { prisma } from "@/lib/prisma";
import { generateSlug } from "@/lib/slug";

interface CreateBoardBody {
  gameName: string;
  squarePrice: number; // dollars (converted to cents)
  teamRow: string;
  teamCol: string;
  payoutStructure: {
    q1: number;
    q2: number;
    q3: number;
    final: number;
  };
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

    // 4. Validate payout structure sums to 100% (±0.01 tolerance)
    const { q1, q2, q3, final: finalPct } = body.payoutStructure ?? {};

    if (q1 == null || q2 == null || q3 == null || finalPct == null) {
      return NextResponse.json(
        { error: "Payout structure must include q1, q2, q3, and final." },
        { status: 400 }
      );
    }

    if ([q1, q2, q3, finalPct].some((v) => v < 0)) {
      return NextResponse.json(
        { error: "Payout percentages cannot be negative." },
        { status: 400 }
      );
    }

    const total = q1 + q2 + q3 + finalPct;
    if (Math.abs(total - 100) > 0.01) {
      return NextResponse.json(
        { error: "Payout percentages must total 100%." },
        { status: 400 }
      );
    }

    // 5. Generate unique slug (retry on collision)
    let slug = generateSlug();
    let attempts = 0;
    while (attempts < 5) {
      const existing = await prisma.board.findUnique({ where: { slug } });
      if (!existing) break;
      slug = generateSlug();
      attempts++;
    }

    // 6. Create Board + 100 Squares in one transaction
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
          payoutStructure: body.payoutStructure,
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
