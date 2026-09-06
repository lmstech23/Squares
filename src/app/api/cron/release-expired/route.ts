import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { resolveExpiredHolds } from "@/lib/checkout-holds";
import { sendPendingConfirmations } from "@/lib/confirmation-email";
import { closeDueBoards } from "@/lib/close-board";

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
      // Cleared so the next claimant cannot inherit this row - see the note
      // in confirm-cash. Audit survives on the contribution itself.
      contributionId: null,
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

  // 4. Confirmation emails for anything confirmed but not yet mailed.
  //
  // This is what lets the cash path avoid sending inline: a host confirming
  // three squares one at a time produces three confirmation events, and
  // sweeping here coalesces them into one email per contributor per cycle.
  // Also the retry path for a card send that failed — an unstamped square is
  // picked up next cycle rather than losing its receipt.
  const emails = await sendPendingConfirmations({});

  // 5. Close campaigns whose end date has passed. A scheduled close needs no
  // host action — money doc §7 — so a host who never opens the dashboard
  // still gets a finalized board.
  const closed = await closeDueBoards(now);

  return NextResponse.json({
    ok: true,
    confirmationEmails: emails,
    campaignsClosed: closed,
    releasedStripe: releasedStripe.count,
    expiredBoards: expiredBoards.count,
    fundraiserHolds: holds,
  });
}
