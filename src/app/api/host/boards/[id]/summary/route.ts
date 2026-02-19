import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getHost } from "@/lib/auth";

// ============================================================
// HOST: Board revenue summary with card/cash breakdown
//
// GET /api/host/boards/[id]/summary
//
// Returns:
// - Total revenue (paid squares only)
// - Card revenue (Stripe-confirmed)
// - Cash revenue (host-confirmed)
// - Cash pending (reserved_cash, not yet confirmed)
// - Square counts by status
//
// "At the end of the game, host needs to know:
//  how much physical money should be in hand."
// ============================================================

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const host = await getHost();
    if (!host) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const boardId = params.id;

    const board = await prisma.board.findUnique({
      where: { boardId },
      select: {
        hostId: true,
        squarePrice: true,
        totalSquares: true,
        currency: true,
      },
    });

    if (!board || board.hostId !== host.id) {
      return NextResponse.json({ error: "Board not found." }, { status: 404 });
    }

    // Get all squares with their status and method in one query
    const squares = await prisma.square.findMany({
      where: { boardId },
      select: {
        paymentStatus: true,
        paymentMethod: true,
      },
    });

    // Count by status
    const counts = {
      open: 0,
      pending: 0,        // Stripe checkout in progress
      reserved_cash: 0,  // cash claimed but not confirmed
      paid_card: 0,      // Stripe confirmed
      paid_cash: 0,      // cash confirmed
      failed: 0,
      expired: 0,
    };

    for (const sq of squares) {
      if (sq.paymentStatus === "open") counts.open++;
      else if (sq.paymentStatus === "pending") counts.pending++;
      else if (sq.paymentStatus === "reserved_cash") counts.reserved_cash++;
      else if (sq.paymentStatus === "paid" && sq.paymentMethod === "stripe") counts.paid_card++;
      else if (sq.paymentStatus === "paid" && sq.paymentMethod === "cash") counts.paid_cash++;
      else if (sq.paymentStatus === "failed") counts.failed++;
      else if (sq.paymentStatus === "expired") counts.expired++;
    }

    const totalPaid = counts.paid_card + counts.paid_cash;
    const cardRevenue = counts.paid_card * board.squarePrice;
    const cashRevenue = counts.paid_cash * board.squarePrice;
    const cashPendingRevenue = counts.reserved_cash * board.squarePrice;

    return NextResponse.json({
      currency: board.currency,
      squarePrice: board.squarePrice,
      totalSquares: board.totalSquares,

      // Revenue breakdown
      revenue: {
        total: cardRevenue + cashRevenue,
        card: cardRevenue,
        cash: cashRevenue,
        cashPending: cashPendingRevenue, // not yet confirmed
      },

      // Square counts
      squares: {
        total: squares.length,
        open: counts.open,
        pending: counts.pending,
        reservedCash: counts.reserved_cash,
        paidCard: counts.paid_card,
        paidCash: counts.paid_cash,
        totalPaid: totalPaid,
        fillPercent: Math.round((totalPaid / board.totalSquares) * 100),
      },
    });
  } catch (error) {
    console.error("Board summary error:", error);
    return NextResponse.json(
      { error: "Something went wrong." },
      { status: 500 }
    );
  }
}
