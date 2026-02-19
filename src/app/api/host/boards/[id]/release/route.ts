import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getHost } from "@/lib/auth";

// ============================================================
// HOST: Release a cash square back to open
//
// POST /api/host/boards/[id]/release
// Body: { squareId: string }
//
// Works on BOTH reserved_cash and paid cash squares.
// Stripe-paid squares require a Stripe refund — not handled here.
//
// Also supports the "Convert to Card" flow:
// Host releases cash reservation → player pays with card instead.
// ============================================================

interface ReleaseBody {
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
    const body: ReleaseBody = await request.json();
    const { squareId } = body;

    if (!squareId) {
      return NextResponse.json(
        { error: "Square ID is required." },
        { status: 400 }
      );
    }

    const board = await prisma.board.findUnique({
      where: { boardId },
      select: { hostId: true },
    });

    if (!board || board.hostId !== host.id) {
      return NextResponse.json({ error: "Board not found." }, { status: 404 });
    }

    // Try releasing reserved_cash first (most common — "Earl never showed up")
    const { count: reservedReleased } = await prisma.square.updateMany({
      where: {
        squareId,
        boardId,
        paymentStatus: "reserved_cash",
        paymentMethod: "cash",
      },
      data: {
        paymentStatus: "open",
        paymentMethod: "stripe",
        playerName: null,
        playerEmail: null,
        stripePaymentId: null,
        checkoutExpiresAt: null,
        releaseReason: "manual",
      },
    });

    if (reservedReleased > 0) {
      // No PaymentReference exists for reserved_cash (created on confirm)
      return NextResponse.json({ success: true, squareId, was: "reserved_cash" });
    }

    // Try releasing paid cash ("host gave change back" or "convert to card")
    const { count: paidReleased } = await prisma.square.updateMany({
      where: {
        squareId,
        boardId,
        paymentStatus: "paid",
        paymentMethod: "cash",
      },
      data: {
        paymentStatus: "open",
        paymentMethod: "stripe",
        playerName: null,
        playerEmail: null,
        stripePaymentId: null,
        checkoutExpiresAt: null,
        releaseReason: "manual",
      },
    });

    if (paidReleased > 0) {
      // Clean up PaymentReference for this cash payment
      await prisma.paymentReference.deleteMany({
        where: { squareId, method: "cash" },
      });
      return NextResponse.json({ success: true, squareId, was: "paid_cash" });
    }

    // Neither matched — square is either Stripe-paid, open, or doesn't exist
    return NextResponse.json(
      {
        error:
          "Square cannot be released. It may already be open, or it was paid via card (requires Stripe refund).",
      },
      { status: 409 }
    );
  } catch (error) {
    console.error("Host release error:", error);
    return NextResponse.json(
      { error: "Something went wrong. Please try again." },
      { status: 500 }
    );
  }
}
