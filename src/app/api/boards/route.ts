import { PLATFORM_OWNER_ID } from "@/lib/constants";
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
  squarePrice: number;
  teamRow: string;
  teamCol: string;
  periodType?: "halves" | "quarters";
  hostCutPercent?: number;
  payoutStructure: Record<string, number>;
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
    const periodType = body.periodType ?? "halves";
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
    const squarePriceCents = Math.round(body.squarePrice * 100);

    const boardData = {
      hostId: host.id,
      gameName: body.gameName.trim(),
      squarePrice: squarePriceCents,
      totalSquares: 100,
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
          redirectTo: \`/host/checkout?boardId=\${existingPending.boardId}\`,
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
          data: Array.from({ length: 100 }, (_, i) => ({
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
          data: Array.from({ length: 100 }, (_, i) => ({
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
        redirectTo: \`/host/checkout?boardId=\${board.boardId}\`,
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
