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
        const session = event.data.object as Stripe.Checkout.Session;

        if (session.metadata?.type === "credit_purchase") {
          await handleCreditPurchase(session);
        } else {
          await handleCheckoutCompleted(session);
        }
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
 * NEW: Credit purchase completed — add 1 board credit to host.
 *
 * Guards:
 * 1. Idempotency via CreditTransaction.stripeSessionId check
 * 2. Atomic: increment + log in one transaction
 *
 * This handles payments on the PLATFORM Stripe account.
 * Player square payments go through Stripe Connect (different path).
 */
async function handleCreditPurchase(session: Stripe.Checkout.Session) {
  const hostId = session.metadata?.hostId;
  const creditsToAdd = parseInt(session.metadata?.credits ?? "0", 10);
  const boardId = session.metadata?.boardId; // may be undefined

  if (!hostId || creditsToAdd < 1) {
    console.error("Credit purchase webhook missing hostId or credits in metadata");
    return;
  }

  // Idempotency: check if we already processed this session
  const existing = await prisma.creditTransaction.findFirst({
    where: { stripeSessionId: session.id },
  });

  if (existing) {
    console.log(`Credit purchase already processed: ${session.id}`);
    return;
  }

  await prisma.$transaction(async (tx) => {
    // 1. Add purchased credits
    const afterAdd = await tx.host.update({
      where: { id: hostId },
      data: { boardCredits: { increment: creditsToAdd } },
    });

    // 2. Log the purchase
    await tx.creditTransaction.create({
      data: {
        hostId,
        type: "purchase",
        amount: creditsToAdd,
        balanceAfter: afterAdd.boardCredits,
        stripeSessionId: session.id,
      },
    });

    // 3. If a pending_payment board triggered this checkout, activate it
    if (boardId) {
      const board = await tx.board.findUnique({ where: { boardId } });

      if (board && board.hostId === hostId && board.status === "pending_payment") {
        // Deduct 1 credit for this board
        const afterDeduct = await tx.host.update({
          where: { id: hostId },
          data: { boardCredits: { decrement: 1 } },
        });

        // Log the board creation deduction
        await tx.creditTransaction.create({
          data: {
            hostId,
            type: "board_created",
            amount: -1,
            balanceAfter: afterDeduct.boardCredits,
            boardId,
          },
        });

        // Flip board to open
        await tx.board.update({
          where: { boardId },
          data: {
            status: "open",
            pendingExpiresAt: null,
            activatedAt: new Date(),
          },
        });

        // Create 100 squares (weren't created for pending_payment boards)
        await tx.square.createMany({
          data: Array.from({ length: 100 }, (_, i) => ({
            boardId,
            position: i,
            paymentStatus: "open" as const,
          })),
        });
      }
    }
  });

  console.log(
    `Credit purchased: host=${hostId}, credits=${creditsToAdd}, board=${boardId ?? "none"}, session=${session.id}`
  );
}
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
