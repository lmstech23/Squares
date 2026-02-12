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
      // CHECKOUT: Payment completed (Track 6)
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

/**
 * Payment succeeded — lock the square as paid, create PaymentReference.
 *
 * Guards:
 * 1. Idempotency via PaymentReference.stripeSessionId unique constraint
 * 2. State guard: only transitions pending → paid
 * 3. Session identity: stripePaymentId on Square must match this session
 *    (prevents a stale completed event from claiming a re-released square)
 * 4. Atomic: updateMany + PaymentReference create in one transaction.
 *    Both succeed or neither does — no orphaned paid squares without records.
 */
async function handleCheckoutCompleted(session: Stripe.Checkout.Session) {
  const squareId = session.metadata?.squareId;
  if (!squareId) return;

  // Idempotency: if PaymentReference already exists for this session, skip
  const existing = await prisma.paymentReference.findUnique({
    where: { stripeSessionId: session.id },
  });
  if (existing) return;

  try {
    await prisma.$transaction(async (tx) => {
      // State guard + session identity check
      const { count } = await tx.square.updateMany({
        where: {
          squareId,
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

      await tx.paymentReference.create({
        data: {
          squareId,
          stripeSessionId: session.id,
          amount: session.amount_total ?? 0,
        },
      });
    });
  } catch (error) {
    if (error instanceof Error && error.message === "STATE_MISMATCH") {
      // Square was released (expired/cron) or session mismatch.
      // Money moved in Stripe. Log for manual investigation / refund.
      console.warn(
        `checkout.session.completed: square ${squareId} not in expected state for session ${session.id}. May need manual refund.`
      );
      return;
    }
    // Other errors (DB failure) — re-throw so outer handler returns 500 and Stripe retries
    throw error;
  }
}

/**
 * Checkout session expired — release the square.
 * Wired up in Track 6 (pay-to-lock).
 */
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
