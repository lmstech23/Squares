// src/app/api/host/boards/[id]/resend-winner-sms/route.ts
// ============================================================
// HOST: Resend winner SMS for a period that was already locked
//       but where the original Twilio send failed.
//
// POST /api/host/boards/[id]/resend-winner-sms
// Body: { periodLabel: string }
//
// Requires notify-winner to have run first (the record must exist).
// Reads the locked squareId directly — does NOT recalculate from scores. Score
// changes after notification do not affect which player gets the resend.
//
// AND THE DESTINATION IS PINNED TOO — invariant 117. This used to re-read
// `playerPhone` from the locked square at send time, which made a "resend" a
// NEW send to whatever number the square currently held: edit the phone between
// the first notification and a resend, and the message went somewhere else. The
// number is now taken from the notification record written by notify-winner and
// is never re-read from the square.
//
// No rate limiting in V1. See spec section 6 for rationale.
// ============================================================

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireBoardAccess } from "@/lib/board-access";
import { sendSms } from "@/lib/twilio";
import { parseNotification } from "@/lib/winner-notification";

interface ResendBody {
  periodLabel: string;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
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

    const access = await requireBoardAccess(boardId, "winner.resend");
    if (!access.ok) {
      return NextResponse.json({ error: access.error }, { status: access.status });
    }
    if (!board) {
      return NextResponse.json({ error: "Board not found." }, { status: 404 });
    }

    // 2. The notification record — parsed in one place, never picked apart here.
    const parsed = parseNotification(board.winnerNotifiedByPeriod, periodLabel);

    if (!parsed.ok && parsed.reason === "missing") {
      return NextResponse.json(
        {
          error:
            "Winner not yet notified for this period — use the notify endpoint first.",
        },
        { status: 400 }
      );
    }

    // FAILS CLOSED, AND DOES NOT FALL BACK TO THE SQUARE. A record that is not a
    // notification record is a state this code cannot reason about; reading
    // `playerPhone` instead would restore the unpinned behaviour at exactly the
    // moment something is already wrong. Production holds nothing malformed
    // (22 boards, 22 empty maps) — this guards a hand-edited row or a future
    // writer that bypasses the module.
    if (!parsed.ok && parsed.reason === "malformed") {
      console.error(
        `resend-winner-sms: malformed notification for board ${boardId} period ${periodLabel}`
      );
      return NextResponse.json(
        {
          error:
            "This period's notification record is unreadable. Contact support " +
            "rather than resending.",
        },
        { status: 409 }
      );
    }

    // A REAL RECORD WHOSE WINNER HAD NO PHONE. notify-winner sends an EMAIL and
    // requires only an email address, so a winner with no phone on file is
    // notified and locked normally. There is nothing to resend to, and the
    // square's current phone is not an answer — it was not the notified one.
    if (!parsed.ok) {
      return NextResponse.json(
        {
          error:
            "No phone number was on file for this winner when they were notified, " +
            "so there is nothing to resend to.",
        },
        { status: 400 }
      );
    }

    const lockedSquareId = parsed.notification.squareId;

    // 3. Fetch the locked square directly (no score recalculation)
    const square = await prisma.square.findUnique({
      where: { squareId: lockedSquareId },
      select: {
        squareId: true,
        paymentStatus: true,
        // `playerPhone` IS NOT SELECTED, deliberately. The destination comes
        // from the notification record; a field that is not read cannot become
        // one by accident later.
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

    // 5. HARD GUARD: opt-in, read LIVE and deliberately so.
    //
    // The phone is pinned; consent is not. Someone who has opted out since the
    // first notification must not be texted, and that is a fact about now
    // rather than about the moment they won. The two are different questions
    // and are answered from different places on purpose.
    if (!square.smsOptIn) {
      return NextResponse.json(
        { error: "Player did not opt in to SMS." },
        { status: 400 }
      );
    }

    // 6. Build message — same logic as notify-winner
    const squareNumber = square.position + 1;
    const message = board.requirePlayerPayout
      ? `Daali Boards: You won ${periodLabel} on ${board.gameName} with Square #${squareNumber}. Your host has your payout details and will send winnings soon. Reply STOP to opt out.`
      : `Daali Boards: You won ${periodLabel} on ${board.gameName} with Square #${squareNumber}. Contact your host for payout. Reply STOP to opt out.`;

    // 7. Send SMS — TO THE STORED NUMBER, invariant 117.
    let smsSent = true;

    try {
      await sendSms(parsed.phone, message);
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
