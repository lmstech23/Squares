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

    // 1. Release expired Stripe checkouts (pending → open) — GAME DAY ONLY.
    //
    // This route predates fundraiser boards (initial commit, Feb 2026) and was
    // written when every board was Game Day, where a batch, a grant and a
    // supporter do not exist. It was never revisited when A5/A6 added
    // fundraiser holds, and until this filter it released fundraiser squares
    // too — matching `release-expired`'s scoping is the whole fix.
    //
    // Two things went wrong without it, both observed in production on
    // 2026-08-28 (board umt9dpqq, batch 78a53f80…):
    //
    //   1. It leaves a fundraiser square `open` while still carrying batchId,
    //      holdExpiresAt, pricePaidCents and checkoutSessionId, and it never
    //      calls releaseAdmissionForBatch — so the AdmissionGrant is stranded
    //      pointing at squares nobody holds. Worse, once the square is `open`
    //      it no longer matches resolveExpiredHolds' `paymentStatus: "pending"`
    //      selector, so the correct path can never reach it again.
    //
    //   2. checkoutExpiresAt is claim + 10 min while the Stripe session lives
    //      30 (checkout/route.ts). Releasing on that timestamp hands the square
    //      to someone else while the first contributor's card can still
    //      succeed — invariants 18 and 20, the double-sell this codebase has no
    //      recovery path for.
    //
    // Fundraiser holds are resolved ONLY by resolveExpiredHolds, which queries
    // the Stripe session and EXPIRES it before releasing. The 10-vs-30 minute
    // asymmetry is by design and is safe there precisely because of that
    // ordering; it was never safe here.
    const { count: stripeReleased } = await prisma.square.updateMany({
      where: {
        paymentStatus: "pending",
        checkoutExpiresAt: { lt: now },
        board: { boardType: "game" },
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
