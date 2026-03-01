// src/app/api/host/boards/[id]/resend-winner-sms/route.ts
// ============================================================
// HOST: Resend winner SMS for a period that was already locked
//       but where the original Twilio send failed.
//
// POST /api/host/boards/[id]/resend-winner-sms
// Body: { periodLabel: string }
//
// Requires notify-winner to have run first (lock must exist).
// Fetches the locked squareId directly — does NOT recalculate
// from scores. Score changes after notification do not affect
// which player gets the resend.
//
// No rate limiting in V1. See spec section 6 for rationale.
// ============================================================

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getHost } from "@/lib/auth";
import { sendSms } from "@/lib/twilio";

interface ResendBody {
  periodLabel: string;
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
    const body: ResendBody = await request.json();
    const { periodLabel } = body;

    if (!periodLabel) {
      return NextResponse.json(
        { error: "periodLabel is required." },
        { status: 400 }
      );
    }

    // 1. Load board — verify ownership and read the lock
    const board = await prisma.board.findUnique({
      where: { boardId },
      select: {
        hostId: true,
        gameName: true,
        requirePlayerPayout: true,
        winnerNotifiedByPeriod: true,
      },
    });

    if (!board || board.hostId !== host.id) {
      return NextResponse.json({ error: "Board not found." }, { status: 404 });
    }

    // 2. Check lock exists — resend requires notify to have run first
    const notifiedMap = board.winnerNotifiedByPeriod as Record<string, string>;
    const lockedSquareId = notifiedMap[periodLabel];

    if (!lockedSquareId) {
      return NextResponse.json(
        {
          error:
            "Winner not yet notified for this period — use the notify endpoint first.",
        },
        { status: 400 }
      );
    }

    // 3. Fetch the locked square directly (no score recalculation)
    const square = await prisma.square.findUnique({
      where: { squareId: lockedSquareId },
      select: {
        squareId: true,
        paymentStatus: true,
        playerPhone: true,
        smsOptIn: true,
        playerName: true,
        position: true,
      },
    });

    if (!square) {
      return NextResponse.json(
        { error: "Locked square not found." },
        { status: 400 }
      );
    }

    // 4. HARD GUARD: square must still be paid
    if (square.paymentStatus !== "paid") {
      return NextResponse.json(
        { error: "Square is no longer confirmed as paid." },
        { status: 400 }
      );
    }

    // 5. HARD GUARD: opt-in and phone required
    if (!square.smsOptIn || !square.playerPhone) {
      return NextResponse.json(
        { error: "Player did not opt in to SMS or has no phone on file." },
        { status: 400 }
      );
    }

    // 6. Build message — same logic as notify-winner
    const squareNumber = square.position + 1;
    const message = board.requirePlayerPayout
      ? `Daali Boards: You won ${periodLabel} on ${board.gameName} with Square #${squareNumber}. Your host has your payout details and will send winnings soon. Reply STOP to opt out.`
      : `Daali Boards: You won ${periodLabel} on ${board.gameName} with Square #${squareNumber}. Contact your host for payout. Reply STOP to opt out.`;

    // 7. Send SMS
    let smsSent = true;

    try {
      await sendSms(square.playerPhone, message);
    } catch (err) {
      smsSent = false;
      console.warn("resend-winner-sms: Twilio send failed:", err);
    }

    return NextResponse.json({ success: true, smsSent });
  } catch (error) {
    console.error("resend-winner-sms error:", error);
    return NextResponse.json(
      { error: "Something went wrong. Please try again." },
      { status: 500 }
    );
  }
}
