import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { resolveExpiredHolds } from "@/lib/checkout-holds";

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const now = new Date();

  // 1. Release abandoned Stripe checkouts — GAME DAY ONLY.
  //
  // Fundraiser boards are excluded here and handled by resolveExpiredHolds
  // below. Releasing a fundraiser hold on timestamp alone violates invariant
  // 18: the Daali hold is 10 minutes and Stripe's minimum session lifetime is
  // 30, so between those two the session can still take a payment. The square
  // must not be handed to anyone else until that session is explicitly expired.
  const releasedStripe = await prisma.square.updateMany({
    where: {
      paymentStatus: "pending",
      checkoutExpiresAt: { lt: now },
      board: { boardType: "game" },
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

  // 3. Fundraiser holds — resolve, do not release. Invariants 18-20.
  const holds = await resolveExpiredHolds(now);

  return NextResponse.json({
    ok: true,
    releasedStripe: releasedStripe.count,
    expiredBoards: expiredBoards.count,
    fundraiserHolds: holds,
  });
}
