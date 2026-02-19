import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getHost } from "@/lib/auth";

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
// This is the second tap in the two-step cash flow:
// 1. Reserve (reserved_cash) — "Earl says he'll pay"
// 2. Confirm (paid) — "Earl handed me the cash"
// ============================================================

interface ConfirmCashBody {
  squareId: string;
}

export async function POST(
  request: Request,
  { params }: { params: { id: string } }
) {
  try {
    const host = await getHost();
    if (!host) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const boardId = params.id;
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
      select: { hostId: true, squarePrice: true },
    });

    if (!board || board.hostId !== host.id) {
      return NextResponse.json({ error: "Board not found." }, { status: 404 });
    }

    // Atomic: only confirm if still reserved_cash
    // If cron already expired it, count = 0.
    // If already confirmed, count = 0.
    const { count } = await prisma.square.updateMany({
      where: {
        squareId,
        boardId,
        paymentStatus: "reserved_cash",
        paymentMethod: "cash",
      },
      data: {
        paymentStatus: "paid",
        checkoutExpiresAt: null, // clear TTL — confirmed, no expiry
        releaseReason: null,
      },
    });

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

    return NextResponse.json({ success: true, squareId });
  } catch (error) {
    console.error("Confirm cash error:", error);
    return NextResponse.json(
      { error: "Something went wrong. Please try again." },
      { status: 500 }
    );
  }
}
