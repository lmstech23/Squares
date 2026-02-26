// ============================================================
// src/app/api/webhooks/stripe-platform/route.ts
//
// PLATFORM-ONLY webhook \u2014 handles credit purchases.
//
// Why separate?
// Player square payments go through Stripe Connect (host's account).
// Credit purchases go through the PLATFORM Stripe account (your account).
// Different Stripe accounts = different webhook endpoints = different
// signing secrets. Commingling them causes signature verification failures.
//
// This endpoint uses STRIPE_PLATFORM_WEBHOOK_SECRET.
// The existing /api/webhooks/stripe uses STRIPE_WEBHOOK_SECRET (Connect).
// ============================================================

import { NextResponse } from "next/server";
import { stripe } from "@/lib/stripe";
import { prisma } from "@/lib/prisma";
import Stripe from "stripe";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const body = await request.text();
  const signature = request.headers.get("stripe-signature");

  if (!signature) {
    return NextResponse.json(
      { error: "Missing stripe-signature header" },
      { status: 400 }
    );
  }

  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(
      body,
      signature,
      process.env.STRIPE_PLATFORM_WEBHOOK_SECRET!
    );
  } catch (err) {
    console.error("Platform webhook signature verification failed:", err);
    return NextResponse.json(
      { error: "Invalid signature" },
      { status: 400 }
    );
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;

        // Safety check \u2014 only process credit purchases here
        if (session.metadata?.type !== "credit_purchase") {
          console.warn(
            `Platform webhook received non-credit checkout: ${session.id}`
          );
          break;
        }

        await handleCreditPurchase(session);
        break;
      }

      default:
        // Platform webhook only cares about credit purchases
        break;
    }
  } catch (err) {
    console.error(`Error handling ${event.type}:`, err);
    return NextResponse.json(
      { error: "Webhook handler failed" },
      { status: 500 }
    );
  }

  return NextResponse.json({ received: true });
}

// ============================================================
// HANDLER
// ============================================================

/**
 * Credit purchase completed \u2014 add board credits to host.
 *
 * Guards:
 * 1. Idempotency via CreditTransaction.stripeSessionId check
 * 2. Atomic: increment + log in one transaction
 * 3. Board activation creates 100 squares (Path 3 defers this)
 *
 * Math:
 *   Single pack: +1 credit, -1 for board = 0 remaining
 *   Triple pack: +3 credits, -1 for board = 2 remaining
 */
async function handleCreditPurchase(session: Stripe.Checkout.Session) {
  const hostId = session.metadata?.hostId;
  const creditsToGrant = parseInt(session.metadata?.credits || "1", 10);

  if (!hostId) {
    console.error("Credit purchase webhook missing hostId in metadata");
    return;
  }

  // Idempotency: already processed?
  const existing = await prisma.creditTransaction.findFirst({
    where: { stripeSessionId: session.id },
  });

  if (existing) {
    console.log(`Credit purchase already processed: ${session.id}`);
    return;
  }

  // Add credits + log in one transaction
  await prisma.$transaction(async (tx) => {
    const updatedHost = await tx.host.update({
      where: { id: hostId },
      data: { boardCredits: { increment: creditsToGrant } },
    });

    await tx.creditTransaction.create({
      data: {
        hostId,
        type: "purchase",
        amount: creditsToGrant,
        balanceAfter: updatedHost.boardCredits,
        stripeSessionId: session.id,
      },
    });
  });

  // \u2500\u2500 Activate pending board if one exists \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  // If the host had a pending_payment board, flip it to open,
  // create 100 squares (Path 3 deferred square creation), and
  // deduct 1 credit.
  const pendingBoard = await prisma.board.findFirst({
    where: { hostId, status: "pending_payment" },
    orderBy: { createdAt: "desc" },
  });

  if (pendingBoard) {
    await prisma.$transaction(async (tx) => {
      // Deduct 1 credit for this board
      const host = await tx.host.update({
        where: { id: hostId, boardCredits: { gt: 0 } },
        data: { boardCredits: { decrement: 1 } },
      });

      // Activate the board
      await tx.board.update({
        where: { boardId: pendingBoard.boardId },
        data: {
          status: "open",
          pendingExpiresAt: null,
          activatedAt: new Date(),
          hiddenFromHost: false,
        },
      });

      // Create 100 squares \u2014 Path 3 deferred this until payment
      await tx.square.createMany({
        data: Array.from({ length: 100 }, (_, i) => ({
          boardId: pendingBoard.boardId,
          position: i,
          paymentStatus: "open" as const,
        })),
      });

      // Log the credit consumption
      await tx.creditTransaction.create({
        data: {
          hostId,
          type: "board_created",
          amount: -1,
          balanceAfter: host.boardCredits,
          boardId: pendingBoard.boardId,
        },
      });
    });

    console.log(
      `Credit purchased (${creditsToGrant}) + board activated: host=${hostId}, board=${pendingBoard.boardId}, session=${session.id}`
    );
  } else {
    console.log(
      `Credit purchased (${creditsToGrant}, no pending board): host=${hostId}, session=${session.id}`
    );
  }
}
