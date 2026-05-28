import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// ============================================================
// CRON: Release expired Stripe checkouts
//
// Releases pending card squares where checkout_expires_at has passed.
// Cash reservations no longer auto-expire — hosts release them at their discretion.
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

    if (stripeReleased > 0) {
      console.log(
        `Cron: released ${stripeReleased} expired Stripe checkout(s)`
      );
    }
    
    return NextResponse.json({
      stripeReleased,
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
