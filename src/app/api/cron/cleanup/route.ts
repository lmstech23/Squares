import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// ============================================================
// CRON: Release expired squares (Stripe + Cash)
//
// Handles TWO expiration scenarios:
// 1. Stripe checkouts: pending squares where checkout_expires_at has passed
// 2. Cash reservations: reserved_cash squares where checkout_expires_at has passed
//
// Both use the same checkout_expires_at field. The TTL is set at
// reservation time based on the board's cashReservationTtlMins.
//
// Runs every 5 minutes via Vercel Cron.
//
// vercel.json:
// { "crons": [{ "path": "/api/cron/release-expired", "schedule": "*/5 * * * *" }] }
// ============================================================

export const runtime = "nodejs";

function isAuthorized(request: Request): boolean {
  const authHeader = request.headers.get("authorization");
  if (!authHeader) return false;
  const token = authHeader.replace("Bearer ", "");
  return token === process.env.CRON_SECRET;
}

export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const now = new Date();

    // 1. Release expired Stripe checkouts (pending → open)
    const { count: stripeReleased } = await prisma.square.updateMany({
      where: {
        paymentStatus: "pending",
        checkoutExpiresAt: { lt: now },
      },
      data: {
        paymentStatus: "open",
        paymentMethod: "stripe",
        playerName: null,
        playerEmail: null,
        stripePaymentId: null,
        checkoutExpiresAt: null,
        releaseReason: "expired",
      },
    });

    // 2. Release expired cash reservations (reserved_cash → open)
    //    "Earl said he'd bring the cash... 20 minutes ago."
    const { count: cashReleased } = await prisma.square.updateMany({
      where: {
        paymentStatus: "reserved_cash",
        checkoutExpiresAt: { lt: now },
      },
      data: {
        paymentStatus: "open",
        paymentMethod: "stripe", // reset to default
        playerName: null,
        playerEmail: null,
        stripePaymentId: null,
        checkoutExpiresAt: null,
        releaseReason: "expired",
      },
    });

    if (stripeReleased > 0 || cashReleased > 0) {
      console.log(
        `Cron: released ${stripeReleased} expired Stripe checkout(s), ${cashReleased} expired cash reservation(s)`
      );
    }

    return NextResponse.json({
      stripeReleased,
      cashReleased,
      timestamp: now.toISOString(),
    });
  } catch (error) {
    console.error("Cron release-expired failed:", error);
    return NextResponse.json(
      { error: "Cron job failed" },
      { status: 500 }
    );
  }
}
