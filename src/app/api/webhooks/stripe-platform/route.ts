// ============================================================
// src/app/api/webhooks/stripe-platform/route.ts
//
// PLATFORM-ONLY webhook — handles credit purchases.
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

        // Safety check — only process credit purchases here
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
 * Credit purchase completed — add board credits to host.
 *
 * Guards:
 * 1. Idempotency via CreditTransaction.stripeSessionId check
 * 2. Atomic: increment + log in one transaction
 */
async function handleCreditPurchase(session: Stripe.Checkout.Session) {
  const hostId = session.metadata?.hostId;
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

  // Add credit + log in one transaction
  await prisma.$transaction(async (tx) => {
    const updatedHost = await tx.host.update({
      where: { id: hostId },
      data: { boardCredits: { increment: 1 } },
    });

    await tx.creditTransaction.create({
      data: {
        hostId,
        type: "purchase",
        amount: 1,
        balanceAfter: updatedHost.boardCredits,
        stripeSessionId: session.id,
      },
    });
  });

  // ── Activate pending board if one exists ──────────────────
  // If the host had a pending_payment board, flip it to open now.
  const pendingBoard = await prisma.board.findFirst({
    where: { hostId, status: "pending_payment" },
    orderBy: { createdAt: "desc" },
  });

  if (pendingBoard) {
    await prisma.$transaction(async (tx) => {
      // Deduct the credit for this board
      const host = await tx.host.update({
        where: { id: hostId, boardCredits: { gt: 0 } },
        data: { boardCredits: { decrement: 1 } },
      });

      await tx.board.update({
        where: { boardId: pendingBoard.boardId },
        data: {
          status: "open",
          pendingExpiresAt: null,
          activatedAt: new Date(),
        },
      });

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
      `Credit purchased + board activated: host=${hostId}, board=${pendingBoard.boardId}, session=${session.id}`
    );
  } else {
    console.log(`Credit purchased (no pending board): host=${hostId}, session=${session.id}`);
  }
}
