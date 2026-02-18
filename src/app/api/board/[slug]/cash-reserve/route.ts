import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// ============================================================
// PLAYER: Self-serve cash reservation with PIN
//
// POST /api/board/[slug]/cash-reserve
// Body: { squareId: string, playerName: string, pin: string }
//
// Player scans QR, picks square, enters PIN + name → reserved_cash.
// Host must still tap "Mark Cash Received" to confirm.
// Auto-expires after board.cashReservationTtlMins if host doesn't confirm.
// ============================================================

interface CashReserveBody {
  squareId: string;
  playerName: string;
  pin: string;
}

export async function POST(
  request: Request,
  { params }: { params: { slug: string } }
) {
  try {
    const body: CashReserveBody = await request.json();
    const { squareId, playerName, pin } = body;

    if (!squareId || !playerName?.trim() || !pin?.trim()) {
      return NextResponse.json(
        { error: "Square ID, name, and PIN are required." },
        { status: 400 }
      );
    }

    const name = playerName.trim();
    const slug = params.slug;

    const board = await prisma.board.findUnique({
      where: { slug },
      select: {
        boardId: true,
        status: true,
        cashModeEnabled: true,
        cashPin: true,
        squarePrice: true,
        cashReservationTtlMins: true,
      },
    });

    if (!board) {
      return NextResponse.json({ error: "Board not found." }, { status: 404 });
    }

    if (board.status !== "open") {
      return NextResponse.json(
        { error: "This board is no longer accepting squares." },
        { status: 409 }
      );
    }

    if (!board.cashModeEnabled || !board.cashPin) {
      return NextResponse.json(
        { error: "Cash reservations are not enabled for this board." },
        { status: 403 }
      );
    }

    if (pin.trim() !== board.cashPin) {
      return NextResponse.json(
        { error: "Incorrect PIN." },
        { status: 403 }
      );
    }

    // Verify square belongs to this board
    const square = await prisma.square.findFirst({
      where: { squareId, boardId: board.boardId },
      select: { squareId: true },
    });

    if (!square) {
      return NextResponse.json(
        { error: "Square not found on this board." },
        { status: 404 }
      );
    }

    // Set TTL for auto-expiry
    const expiresAt = new Date(
      Date.now() + board.cashReservationTtlMins * 60 * 1000
    );

    // Atomic lock: reserved_cash (NOT paid — host must confirm)
    const { count } = await prisma.square.updateMany({
      where: {
        squareId,
        boardId: board.boardId,
        paymentStatus: "open",
      },
      data: {
        paymentStatus: "reserved_cash",
        paymentMethod: "cash",
        playerName: name,
        playerEmail: null,
        stripePaymentId: null,
        checkoutExpiresAt: expiresAt,
        releaseReason: null,
      },
    });

    if (count === 0) {
      return NextResponse.json(
        { error: "Square is no longer available." },
        { status: 409 }
      );
    }

    return NextResponse.json({
      success: true,
      squareId,
      playerName: name,
      expiresAt: expiresAt.toISOString(),
      message: "Square reserved! Please hand your cash to the host to confirm.",
    });
  } catch (error) {
    console.error("Cash reserve error:", error);
    return NextResponse.json(
      { error: "Something went wrong. Please try again." },
      { status: 500 }
    );
  }
}
