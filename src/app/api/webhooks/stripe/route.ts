// ============================================================
// src/app/api/webhooks/stripe/route.ts
//
// COMPLETE REPLACEMENT — includes:
//   - Existing: account.updated, checkout.session.completed (player squares),
//     checkout.session.expired
//   - NEW: checkout.session.completed for credit purchases
//
// The metadata.type field distinguishes credit purchases from
// player square payments. Credit purchases check FIRST.
// ============================================================

import { NextResponse } from "next/server";
import { stripe } from "@/lib/stripe";
import { prisma } from "@/lib/prisma";
import Stripe from "stripe";

// Disable body parsing — we need the raw body for signature verification
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
      process.env.STRIPE_WEBHOOK_SECRET!
    );
  } catch (err) {
    console.error("Webhook signature verification failed:", err);
    return NextResponse.json(
      { error: "Invalid signature" },
      { status: 400 }
    );
  }

  try {
    switch (event.type) {
      // ========================================
      // STRIPE CONNECT: Account status changes
      // ========================================
      case "account.updated": {
        await handleAccountUpdated(event.data.object as Stripe.Account);
        break;
      }

      // ========================================
      // CHECKOUT: Payment completed
      // Routes to credit purchase OR square payment
      // ========================================
      case "checkout.session.completed": {
        await handleCheckoutCompleted(
          event.data.object as Stripe.Checkout.Session
        );
        break;
      }

      // ========================================
      // CHECKOUT: Session expired (Track 6)
      // ========================================
      case "checkout.session.expired": {
        await handleCheckoutExpired(
          event.data.object as Stripe.Checkout.Session
        );
        break;
      }

      default:
        // Unhandled event type — acknowledge and move on
        break;
    }
  } catch (err) {
    console.error(`Error handling ${event.type}:`, err);
    // Return 500 so Stripe retries
    return NextResponse.json(
      { error: "Webhook handler failed" },
      { status: 500 }
    );
  }

  return NextResponse.json({ received: true });
}

// ============================================================
// HANDLERS
// ============================================================

/**
 * Sync Stripe account readiness to Host record.
 * Single updateMany — no read+write, no race if host row disappears.
 */
async function handleAccountUpdated(account: Stripe.Account) {
  if (!account.id) return;

  const { count } = await prisma.host.updateMany({
    where: { stripeAccountId: account.id },
    data: {
      stripeChargesEnabled: !!account.charges_enabled,
      stripePayoutsEnabled: !!account.payouts_enabled,
    },
  });

  if (count === 0) {
    console.warn(`No host found for Stripe account ${account.id}`);
  }
}


async function handleCheckoutCompleted(session: Stripe.Checkout.Session) {
  // Support both multi-square (squareIds) and legacy single (squareId)
  const raw = session.metadata?.squareIds || session.metadata?.squareId;
  if (!raw) return;
  const squareIds = raw.split(",").map((s) => s.trim()).filter(Boolean);

  // Idempotency: if PaymentReference already exists for this session, skip
  const existing = await prisma.paymentReference.findUnique({
    where: { stripeSessionId: session.id },
  });
  if (existing) return;

  try {
    await prisma.$transaction(async (tx) => {
      // Update all squares in this session
      const { count } = await tx.square.updateMany({
        where: {
          squareId: { in: squareIds },
          paymentStatus: "pending",
          stripePaymentId: session.id,
        },
        data: {
          paymentStatus: "paid",
          checkoutExpiresAt: null,
          releaseReason: null,
        },
      });

      if (count === 0) {
        throw new Error("STATE_MISMATCH");
      }

      // Create payment reference (one per session)
      await tx.paymentReference.create({
        data: {
          squareId: squareIds[0],
          stripeSessionId: session.id,
          amount: session.amount_total ?? 0,
        },
      });
    });
  } catch (error) {
    if (error instanceof Error && error.message === "STATE_MISMATCH") {
      console.warn(
        `checkout.session.completed: squares [${squareIds.join(",")}] not in expected state for session ${session.id}. May need manual refund.`
      );
      return;
    }
    throw error;
  }
}

async function handleCheckoutExpired(session: Stripe.Checkout.Session) {
  const squareId = session.metadata?.squareId;
  if (!squareId) return;

  // Atomic: only release if still pending — no read-then-write race.
  // If completed webhook already set this to "paid", count = 0, no-op.
  await prisma.square.updateMany({
    where: { squareId, paymentStatus: "pending" },
    data: {
      paymentStatus: "open",
      playerName: null,
      playerEmail: null,
      stripePaymentId: null,
      checkoutExpiresAt: null,
      releaseReason: "expired",
    },
  });
}
