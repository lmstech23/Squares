import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// ============================================================
// PLAYER: Self-serve cash reservation with PIN
//
// POST /api/board/[slug]/cash-reserve
// Body: { squareIds: string[], playerName: string, pin: string, ... }
//
// Reserves all selected squares. Skips any no longer available.
// Host must still tap "Mark Cash Received" to confirm each one.
// Auto-expires after board.cashReservationTtlMins if host doesn't confirm.
// ============================================================

interface CashReserveBody {
  squareIds: string[];
  playerName: string;
  pin: string;
  playerPhone: string;
  playerEmail?: string | null;
  playerPayoutMethod?: string | null;
  playerPayoutHandle?: string | null;
  smsOptIn?: boolean;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  try {
    const body: CashReserveBody = await request.json();
    const { squareIds, playerName, pin } = body;

    if (!squareIds?.length || !playerName?.trim() || !pin?.trim()) {
      return NextResponse.json(
        { error: "Square IDs, name, and PIN are required." },
        { status: 400 }
      );
    }

    if (!body.playerPhone?.trim()) {
      return NextResponse.json(
        { error: "Phone number is required." },
        { status: 400 }
      );
    }

    const name = playerName.trim();
    const { slug } = await params;

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

    const expiresAt = new Date(
      Date.now() + board.cashReservationTtlMins * 60 * 1000
    );

    const reserved: string[] = [];
    const unavailable: string[] = [];

    // Reserve each square — skip any that are no longer open
    for (const squareId of squareIds) {
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
          playerEmail: body.playerEmail?.trim().toLowerCase() || null,
          playerPhone: body.playerPhone?.trim() || null,
          playerPayoutMethod: (body.playerPayoutMethod as any) || null,
          playerPayoutHandle: body.playerPayoutHandle?.trim() || null,
          smsOptIn: body.smsOptIn ?? false,
          stripePaymentId: null,
          checkoutExpiresAt: expiresAt,
          releaseReason: null,
        },
      });

      if (count === 0) {
        unavailable.push(squareId);
      } else {
        reserved.push(squareId);
      }
    }

    if (reserved.length === 0) {
      return NextResponse.json(
        { error: "None of the selected squares are available." },
        { status: 409 }
      );
    }

    return NextResponse.json({
      success: true,
      reserved,
      unavailable,
      playerName: name,
      expiresAt: expiresAt.toISOString(),
      message:
        unavailable.length > 0
          ? `${reserved.length} square(s) reserved. ${unavailable.length} were already taken.`
          : "Squares reserved! Send the amount owed to the host to secure your square. Unpaid squares will be released.",
    });
  } catch (error) {
    console.error("Cash reserve error:", error);
    return NextResponse.json(
      { error: "Something went wrong. Please try again." },
      { status: 500 }
    );
  }
}
