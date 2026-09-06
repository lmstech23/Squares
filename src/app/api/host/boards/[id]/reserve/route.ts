import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getHost } from "@/lib/auth";

// ============================================================
// HOST: Reserve a square for a cash-paying player
//
// POST /api/host/boards/[id]/reserve
// Body: { squareId: string, playerName: string }
//
// Sets square to reserved_cash (NOT paid).
// Host must separately confirm cash received via /confirm-cash.
// No auto-expiry — host releases reservations at their discretion.
// ============================================================

interface ReserveBody {
  squareId: string;
  playerName: string;
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
    const body: ReserveBody = await request.json();
    const { squareId, playerName } = body;

    if (!squareId || !playerName?.trim()) {
      return NextResponse.json(
        { error: "Square ID and player name are required." },
        { status: 400 }
      );
    }

    const name = playerName.trim();

    const board = await prisma.board.findUnique({
      where: { boardId },
      select: {
        hostId: true,
        status: true,
        squarePrice: true,
        boardType: true,
       },
    });

    if (!board || board.hostId !== host.id) {
      return NextResponse.json({ error: "Board not found." }, { status: 404 });
    }

    // GAME DAY ONLY. This writes `playerEmail: null` and captures no phone -
    // a name on a clipboard - which is exactly the anonymous contribution a
    // fundraiser no longer has. Fundraiser contributors are given the public
    // link and complete their own purchase or donation, so this is not a
    // fundraiser workflow to extend; it is one that should never have applied.
    //
    // Nothing depended on it there: the only caller is CashReservePanel, and
    // that panel renders solely inside the Game Day branch of the host board
    // page. The route itself had no board-type check, so a fundraiser square
    // could be reserved with no identity by anyone who posted to it.
    if (board.boardType === "fundraiser") {
      return NextResponse.json(
        {
          error:
            "Fundraiser contributors reserve from the board link, which collects their email and phone.",
        },
        { status: 400 }
      );
    }

    if (board.status !== "open") {
      return NextResponse.json(
        { error: "This board is no longer accepting squares." },
        { status: 409 }
      );
    }

    // Atomic lock: only reserve if square is currently open
    const { count } = await prisma.square.updateMany({
      where: {
        squareId,
        boardId,
        paymentStatus: "open",
      },
      data: {
        paymentStatus: "reserved_cash",
        paymentMethod: "cash",
        playerName: name,
        playerEmail: null,
        stripePaymentId: null,
        checkoutExpiresAt: null,
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
     });
  } catch (error) {
    console.error("Host reserve error:", error);
    return NextResponse.json(
      { error: "Something went wrong. Please try again." },
      { status: 500 }
    );
  }
}
