// src/app/api/host/boards/[id]/notify-winner/route.ts
// ============================================================
// HOST: Send winner SMS for a period — one-time per period.
//
// POST /api/host/boards/[id]/notify-winner
// Body: { periodLabel: string }
//
// Design:
//   Atomic JSONB lock is written BEFORE Twilio is called.
//   Double-send is worse than a missed send.
//   Use /resend-winner-sms to recover a missed send.
//
// The lock uses a raw Postgres query because Prisma does not
// support 'JSON key does not exist' conditional updates ergonomically.
// Raw SQL: ? operator checks key absence, || merges new key in.
// ============================================================

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getHost } from "@/lib/auth";
import { calculateWinnersFromArrays } from "@/lib/winners";
import { sendEmail } from "@/lib/email";

interface NotifyWinnerBody {
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
    const body: NotifyWinnerBody = await request.json();
    const { periodLabel } = body;

    if (!periodLabel) {
      return NextResponse.json(
        { error: "periodLabel is required." },
        { status: 400 }
      );
    }

    // 1. Load board — verify ownership and get everything we need
    const board = await prisma.board.findUnique({
      where: { boardId },
      select: {
        hostId: true,
        gameName: true,
        periodLabels: true,
        scoresTeamA: true,
        scoresTeamB: true,
        rowNumbers: true,
        colNumbers: true,
        requirePlayerPayout: true,
        winnerNotifiedByPeriod: true,
      },
    });

    if (!board || board.hostId !== host.id) {
      return NextResponse.json({ error: "Board not found." }, { status: 404 });
    }

    // 2. Validate periodLabel exists on this board
    if (!board.periodLabels.includes(periodLabel)) {
      return NextResponse.json(
        { error: `Period "${periodLabel}" does not exist on this board.` },
        { status: 400 }
      );
    }

    // 3. Calculate winning position for this period
    const winners = calculateWinnersFromArrays(
      board.periodLabels,
      board.scoresTeamA,
      board.scoresTeamB,
      board.rowNumbers,
      board.colNumbers
    );

    const winner = winners.find((w) => w.label === periodLabel);
    if (!winner) {
      return NextResponse.json(
        { error: `Scores not yet entered for period "${periodLabel}".` },
        { status: 400 }
      );
    }

    // 4. Find the winning square
    const square = await prisma.square.findUnique({
      where: {
        boardId_position: {
          boardId,
          position: winner.position,
        },
      },
      select: {
        squareId: true,
        paymentStatus: true,
        playerEmail: true,
        playerName: true,
        position: true,
      },
    });

    if (!square) {
      return NextResponse.json(
        { error: "Winning square not found." },
        { status: 400 }
      );
    }

    // 5. HARD GUARD: square must be paid
    if (square.paymentStatus !== "paid") {
      return NextResponse.json(
        {
          error:
            "Winner square is not confirmed as paid. SMS not sent.",
        },
        { status: 400 }
      );
    }

    // 6. HARD GUARD: player must have an email
    if (!square.playerEmail) {
      return NextResponse.json(
        { error: "No email on file for this player." },
        { status: 400 }
      );
    }

    // 7. ATOMIC LOCK — write { periodLabel: squareId } only if key is absent.
    //    Uses raw JSONB: ? checks key existence, || merges. Returns affected rows.
    //    If count = 0, another request already locked this period.
    const squareNumber = square.position + 1;
    const result = await prisma.$executeRaw`
      UPDATE boards
      SET winner_notified_by_period = winner_notified_by_period || ${JSON.stringify({ [periodLabel]: square.squareId })}::jsonb
      WHERE board_id = ${boardId}::uuid
        AND NOT (winner_notified_by_period ? ${periodLabel})
    `;

    if (result === 0) {
      return NextResponse.json(
        { error: "Winner already notified for this period." },
        { status: 400 }
      );
    }
// 8. Build email
    const emailBody = board.requirePlayerPayout
      ? `<p>🎉 You won <strong>${periodLabel}</strong> on <strong>${board.gameName}</strong> with Square #${squareNumber}! Your host has your payout details and will send winnings soon.</p>`
      : `<p>🎉 You won <strong>${periodLabel}</strong> on <strong>${board.gameName}</strong> with Square #${squareNumber}! Contact your host for payout.</p>`;

    // 9. Send email — wrapped in try/catch so a failure doesn't undo the lock.
    //    Lock is intentionally written first (see design note at top).
    let emailSent = true;
    let emailError: string | undefined;

    try {
      await sendEmail(
        square.playerEmail,
        `You won ${periodLabel} on ${board.gameName}!`,
        emailBody
      );
    } catch (err) {
      emailSent = false;
      emailError = "EMAIL_SEND_FAILED";
      console.warn("notify-winner: email send failed (lock written, email not sent):", err);
    }

    return NextResponse.json({
      success: true,
      locked: true,
      emailSent,
      ...(emailError ? { error: emailError } : {}),
    });
  } catch (error) {
    console.error("notify-winner error:", error);
    return NextResponse.json(
      { error: "Something went wrong. Please try again." },
      { status: 500 }
    );
  }
}
