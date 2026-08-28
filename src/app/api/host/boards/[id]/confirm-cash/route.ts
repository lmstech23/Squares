// src/app/api/host/boards/[id]/confirm-cash/route.ts
// ============================================================
// HOST: Confirm cash received — "Mark Cash Received"
//
// POST /api/host/boards/[id]/confirm-cash
// Body: { squareId: string }
//
// Transitions: reserved_cash → paid
// Creates PaymentReference for revenue tracking.
// Clears the auto-expire TTL (cash is confirmed, no expiry needed).
//
// SMS: fires after updateMany succeeds. Twilio failure is non-fatal —
// the confirmation is already committed and cannot be rolled back.
// ============================================================

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { confirmSquares } from "@/lib/confirm-square";
import { getHost } from "@/lib/auth";
import { sendEmail } from "@/lib/email";

interface ConfirmCashBody {
  squareId: string;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const host = await getHost();
    if (!host) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id: boardId } = await params;
    const body: ConfirmCashBody = await request.json();
    const { squareId } = body;

    if (!squareId) {
      return NextResponse.json(
        { error: "Square ID is required." },
        { status: 400 }
      );
    }

    const board = await prisma.board.findUnique({
      where: { boardId },
      select: { hostId: true, squarePrice: true, gameName: true },
    });

    if (!board || board.hostId !== host.id) {
      return NextResponse.json({ error: "Board not found." }, { status: 404 });
    }

    // Atomic: only confirm if still reserved_cash. Shared with the Stripe
    // webhook and the cron, so a direct payment mints passes exactly as a card
    // payment does — the failure this prevents is card contributors getting
    // passes and cash contributors not.
    const { confirmedSquareIds } = await prisma.$transaction((tx) =>
      confirmSquares(tx, [squareId], "reserved_cash", {
        boardId,
        paymentMethod: "cash",
      })
    );

    const count = confirmedSquareIds.length;

    if (count === 0) {
      return NextResponse.json(
        {
          error:
            "Square is not in a cash-reserved state. It may have expired or already been confirmed.",
        },
        { status: 409 }
      );
    }

    // Create PaymentReference for revenue tracking
    await prisma.paymentReference.create({
      data: {
        squareId,
        stripeSessionId: null,
        amount: board.squarePrice,
        method: "cash",
      },
    });

     // --- Email: cash confirmed ---
    // Fires after confirmation is committed. Send failure is non-fatal.
    try {
      const square = await prisma.square.findUnique({
        where: { squareId },
        select: {
          position: true,
          playerName: true,
          playerEmail: true,
        },
      });
      if (square?.playerEmail) {
        const squareNumber = square.position + 1;
        await sendEmail(
          square.playerEmail,
          `Your square is confirmed — ${board.gameName}`,
          `<p>Your cash payment is confirmed! You have Square #${squareNumber} on <strong>${board.gameName}</strong>. Good luck!</p>`
        );
      }
    } catch (err) {
      console.warn(`Cash confirmed email failed for square ${squareId}:`, err);
    }
    
    return NextResponse.json({ success: true, squareId });
  } catch (error) {
    console.error("Confirm cash error:", error);
    return NextResponse.json(
      { error: "Something went wrong. Please try again." },
      { status: 500 }
    );
  }
}
