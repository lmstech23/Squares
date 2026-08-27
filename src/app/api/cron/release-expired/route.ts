import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const now = new Date();

  // 1. Release abandoned Stripe checkouts
  const releasedStripe = await prisma.square.updateMany({
    where: {
      paymentStatus: "pending",
      checkoutExpiresAt: { lt: now },
    },
    data: {
      paymentStatus: "open",
      playerName: null,
      playerEmail: null,
      stripePaymentId: null,
      checkoutExpiresAt: null,
      releaseReason: "expired",
    },
  });

  // 2. Expire unpaid boards past their TTL
  const expiredBoards = await prisma.board.updateMany({
    where: {
      status: "pending_payment",
      pendingExpiresAt: { lt: now },
    },
    data: {
      status: "expired",
    },
  });

  return NextResponse.json({
    ok: true,
    releasedStripe: releasedStripe.count,
    expiredBoards: expiredBoards.count,
  });
}
