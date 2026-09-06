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
import { confirmSquares } from "@/lib/confirm-square";
import Stripe from "stripe";
import { sendPendingConfirmations } from "@/lib/confirmation-email";
import {
  activateDonorSupporter,
  releaseContributionBySession,
} from "@/lib/contributions";

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
  // THE LEDGER COMES FIRST — donations §6, "Lookup key:
  // Contribution.checkoutSessionId, not batch id".
  //
  // A donation-only session has ZERO squares to flip, so it must be resolved
  // before the square lookup below, whose `squareIds.length === 0` early
  // return would otherwise drop it silently and leave the contribution pending
  // forever — stalling CLOSING under amended invariant 21.
  const contribution = await prisma.contribution.findUnique({
    where: { checkoutSessionId: session.id },
    select: {
      id: true,
      boardId: true,
      squareAmountCents: true,
      donationAmountCents: true,
      totalPaidCents: true,
      contributorName: true,
      contributorEmail: true,
      contributorPhone: true,
      status: true,
    },
  });

  if (contribution && contribution.squareAmountCents === 0) {
    // Donation-only. Nothing to flip, nothing to mint, no PaymentReference —
    // that table hangs off a square and a donation has none. The ledger row
    // IS the record of this money.
    if (session.amount_total != null && session.amount_total !== contribution.totalPaidCents) {
      // Invariant 62: a mismatch does not confirm and does not release.
      console.error(
        `checkout.session.completed: amount mismatch on contribution ${contribution.id} — ` +
          `session ${session.amount_total} vs ledger ${contribution.totalPaidCents}. Not confirmed.`
      );
      throw new Error("CONTRIBUTION_AMOUNT_MISMATCH");
    }

    await prisma.$transaction(async (tx) => {
      // Idempotent by conditional update on status = 'pending' (invariant 63).
      // A replayed webhook matches zero rows, acknowledges, changes nothing.
      const { count } = await tx.contribution.updateMany({
        where: { id: contribution.id, status: "pending" },
        data: { status: "confirmed", confirmedAt: new Date() },
      });
      if (count === 0) return;

      // Supporter activation must also fire here — donations §9, amending
      // admission §5. Without it a donation-only contributor stays `pending`
      // forever and is silently ineligible for helper signups. Zero grants,
      // zero passes: existence never implies entitlement (invariant 69).
      const board = await tx.board.findUnique({
        where: { boardId: contribution.boardId },
        select: { event: { select: { id: true } } },
      });
      if (board?.event && contribution.contributorEmail) {
        await activateDonorSupporter(tx, board.event.id, {
          name: contribution.contributorName,
          email: contribution.contributorEmail,
          phone: contribution.contributorPhone,
        });
      }
    });
    return;
  }

  // WHICH SQUARES DID THIS SESSION BUY?
  //
  // Two sources, in this order:
  //
  //  1. `Square.checkoutSessionId` — the database. Set by the checkout route
  //     immediately after the session is created, and the only source that
  //     does not scale with the number of squares.
  //  2. `metadata.squareIds` / `metadata.squareId` — the fallback.
  //
  // The database comes first because Stripe caps a metadata VALUE at 500
  // characters. A square id is a 36-character uuid plus a separator, so a
  // comma-joined list holds about thirteen before `sessions.create` starts
  // failing outright. That was a hard ceiling on how many squares a
  // contributor could buy at once, expressed as a Stripe error rather than as
  // anything a product decision ever chose.
  //
  // THE FALLBACK IS NOT LEGACY CONVENIENCE — IT IS GAME DAY'S ONLY PATH.
  // `checkoutSessionId` is written under `isFundraiser ? {...} : {}`, so a Game
  // Day square never has one and would be invisible to the lookup above. It
  // also covers any fundraiser session created before this change and still in
  // flight. Removing it silently breaks Game Day checkout.
  const bySession = await prisma.square.findMany({
    where: { checkoutSessionId: session.id },
    select: { squareId: true },
  });

  const squareIds =
    bySession.length > 0
      ? bySession.map((sq) => sq.squareId)
      : (session.metadata?.squareIds || session.metadata?.squareId || "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);

  if (squareIds.length === 0) return;

  // Idempotency: if PaymentReference already exists for this session, skip
  const existing = await prisma.paymentReference.findUnique({
    where: { stripeSessionId: session.id },
  });
  if (existing) return;

  try {
    await prisma.$transaction(async (tx) => {
      // Update all squares in this session
      // Shared with the cash confirm route and the hold-resolution cron.
      // Minting lives inside this call, so no path can confirm without it.
      const { confirmedSquareIds } = await confirmSquares(
        tx,
        squareIds,
        "pending",
        { stripePaymentId: session.id }
      );

      if (confirmedSquareIds.length === 0) {
        throw new Error("STATE_MISMATCH");
      }

      // The ledger row confirms in the SAME transaction as the squares —
      // invariant 59: a mixed checkout's square portion and donation portion
      // confirm together or not at all. Conditional on `pending`, so a
      // replayed webhook changes nothing (invariant 63).
      if (contribution) {
        if (
          session.amount_total != null &&
          session.amount_total !== contribution.totalPaidCents
        ) {
          throw new Error("CONTRIBUTION_AMOUNT_MISMATCH");
        }
        await tx.contribution.updateMany({
          where: { id: contribution.id, status: "pending" },
          data: { status: "confirmed", confirmedAt: new Date() },
        });
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

  // --- Confirmation email ---
  //
  // ONE email covering the whole batch, not one per square — addendum §5.
  // This previously looped over squares and sent an email each, so buying two
  // squares produced two emails. Four QR codes across four messages is
  // unusable at a gate.
  //
  // Card confirms atomically, so it sends immediately. Failure is non-fatal:
  // payment state is already committed, and an unstamped square is retried by
  // the cron sweep rather than silently losing its receipt.
  const confirmed = await prisma.square.findFirst({
    where: { squareId: { in: squareIds } },
    select: { batchId: true, boardId: true },
  });

  if (confirmed) {
    await sendPendingConfirmations(
      confirmed.batchId
        ? { batchId: confirmed.batchId }
        : { boardId: confirmed.boardId }
    );
  }
}

async function handleCheckoutExpired(session: Stripe.Checkout.Session) {
  // New traffic — donations §6: `checkout.session.expired` now arrives for
  // donation-only sessions with no squares attached. Conditional on `pending`,
  // so a session that completed and one that expired cannot both win.
  await releaseContributionBySession(session.id);

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
      // Cleared so the next claimant cannot inherit this row. A released
      // square has no ledger row covering it, and a stale pointer makes
      // confirm-cash treat the NEXT contributor's money as already recorded.
      // Audit survives on the contribution itself.
      contributionId: null,
      releaseReason: "expired",
    },
  });
}
