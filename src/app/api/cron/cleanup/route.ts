import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

/**
 * Cron: Release expired pending squares.
 *
 * Safety net for cases where Stripe's checkout.session.expired
 * webhook is delayed or lost. Idempotent — only touches squares
 * still marked "pending" past their TTL. Never touches "paid"
 * or "expired".
 *
 * Call via Vercel Cron or external scheduler every 2–5 minutes.
 * Secured by CRON_SECRET env var.
 */
export async function GET(request: Request) {
  // Simple auth — Vercel cron or manual trigger
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const now = new Date();

    // Find and release all expired pending squares
    const result = await prisma.square.updateMany({
      where: {
        paymentStatus: "pending",
        checkoutExpiresAt: {
          lt: now,
        },
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

    return NextResponse.json({
      released: result.count,
      at: now.toISOString(),
    });
  } catch (error) {
    console.error("Cron cleanup error:", error);
    return NextResponse.json(
      { error: "Cleanup failed" },
      { status: 500 }
    );
  }
}
