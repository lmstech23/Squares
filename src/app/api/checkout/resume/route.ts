// ============================================================
// src/app/api/checkout/resume/route.ts
//
// Lets a player resume a Stripe Checkout for a square they
// previously claimed but didn't finish paying for.
//
// No accounts required. Identity is verified by matching the
// email stored on the Square against what the player submits.
//
// Security properties:
//   - TTL expiry check runs BEFORE email check — timing
//     differences cannot leak ownership information.
//   - Email mismatch and "owned by someone else" return the
//     same 403 message — no email enumeration possible.
//   - Session is retrieved from Stripe using the host's
//     connected account — same context as original creation.
//   - On expiry, releases ALL squares sharing the same
//     stripePaymentId (handles multi-square sessions).
// ============================================================

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { stripe } from "@/lib/stripe";
import { releaseAdmissionForBatch } from "@/lib/admission";

interface ResumeBody {
  squareId: string;
  email: string;
  /// What to do with a still-live checkout. Absent means "resume", which is
  /// the only thing this route ever did and is what Game Day still sends.
  ///
  ///   resume  -> hand back the SAME Stripe session URL (unchanged)
  ///   cash    -> expire the session, flip the batch to reserved_cash
  ///   release -> expire the session, put the squares back
  ///
  /// `cash` and `release` are fundraiser-only: a Game Day square has no batch,
  /// no direct-payment path and no handles to show.
  action?: "resume" | "cash" | "release";
}

export async function POST(request: Request) {
  try {
    const body: ResumeBody = await request.json();
    const { squareId } = body;
    const action = body.action ?? "resume";
    const email = body.email?.trim().toLowerCase();

    if (!squareId || !email) {
      return NextResponse.json(
        { error: "Square ID and email are required." },
        { status: 400 }
      );
    }

    // 1. Load square + board + host
    const square = await prisma.square.findUnique({
      where: { squareId },
      include: {
        board: {
          include: {
            host: {
              select: { stripeAccountId: true },
            },
          },
        },
      },
    });

    if (!square) {
      return NextResponse.json(
        { error: "Square not found." },
        { status: 404 }
      );
    }

    // 2. Square must still be pending
    if (square.paymentStatus !== "pending") {
      return NextResponse.json(
        { error: "This square is no longer pending." },
        { status: 409 }
      );
    }

    // 3. TTL expired — release the square (and any siblings from the same
    //    session) and tell the player it's now free.
    //    IMPORTANT: this runs BEFORE the email check so timing cannot leak
    //    ownership information to an attacker enumerating emails.
    const now = new Date();
    if (square.checkoutExpiresAt && square.checkoutExpiresAt < now) {
      // Release all squares locked under the same Stripe session
      await prisma.square.updateMany({
        where: {
          stripePaymentId: square.stripePaymentId,
          paymentStatus: "pending",
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

      return NextResponse.json(
        { error: "This square just freed up — tap it again to claim it." },
        { status: 410 }
      );
    }

    // 4. Email must match — generic message regardless of reason for mismatch
    if (square.playerEmail?.toLowerCase() !== email) {
      return NextResponse.json(
        { error: "This square is reserved by someone else." },
        { status: 403 }
      );
    }

    // 5. Must have a Stripe session ID stored
    if (!square.stripePaymentId) {
      console.error(
        `Resume: square ${squareId} is pending but has no stripePaymentId`
      );
      return NextResponse.json(
        { error: "No payment session found for this square. Please try again." },
        { status: 500 }
      );
    }

    // 6. Retrieve the Stripe session using the host's connected account
    const stripeAccountId = square.board.host.stripeAccountId;

    let session;
    try {
      session = await stripe.checkout.sessions.retrieve(
        square.stripePaymentId,
        {},
        stripeAccountId ? { stripeAccount: stripeAccountId } : undefined
      );
    } catch (err) {
      console.error("Resume: Stripe session retrieve failed:", err);
      return NextResponse.json(
        { error: "Could not retrieve payment session. Please try again." },
        { status: 502 }
      );
    }

    // 7. Handle all possible session states

    // Payment already completed — webhook just hasn't fired yet.
    // Confirm it now using the same logic as the redirect fallback.
    if (session.payment_status === "paid" || session.status === "complete") {
      const existing = await prisma.paymentReference.findUnique({
        where: { stripeSessionId: session.id },
      });

      if (!existing) {
        try {
          await prisma.$transaction(async (tx) => {
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

            if (count > 0) {
              await tx.paymentReference.create({
                data: {
                  squareId,
                  stripeSessionId: session.id,
                  amount: session.amount_total ?? 0,
                },
              });
            }
          });
        } catch (err) {
          console.error("Resume: late payment confirmation failed:", err);
        }
      }

      // Tell the frontend the payment is done — polling will turn it green.
      // Return the board slug so the frontend can redirect to the success URL.
      return NextResponse.json({
        alreadyPaid: true,
        boardSlug: square.board.slug,
      });
    }

    // Session expired on Stripe's side — webhook hasn't fired yet.
    // Release all squares under this session and return 410.
    if (session.status === "expired") {
      await prisma.square.updateMany({
        where: {
          stripePaymentId: square.stripePaymentId,
          paymentStatus: "pending",
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

      return NextResponse.json(
        { error: "This square just freed up — tap it again to claim it." },
        { status: 410 }
      );
    }

    // ---------------------------------------------------------------------
    // METHOD SWITCH / RELEASE — the contributor backed out of Stripe.
    //
    // Reached only with a session that is neither paid nor expired, i.e. one
    // that could still take a payment. THE SESSION IS EXPIRED FIRST, always,
    // for the same reason resolveHoldBatch does it: between the Daali hold
    // (10 min) and Stripe's minimum session lifetime (30 min) the card can
    // still succeed. Mutating the squares first would let a late success land
    // on a square already marked reserved_cash or handed to someone else —
    // invariants 18 and 20, which this codebase has no recovery path for.
    //
    // Ordering, deliberately: expire -> then mutate. If expiring throws we
    // change nothing and the contributor keeps their hold, which is the
    // recoverable failure.
    if (action === "cash" || action === "release") {
      const isFundraiser = square.board.boardType === "fundraiser";
      if (!isFundraiser) {
        return NextResponse.json(
          { error: "Not available on this board." },
          { status: 400 }
        );
      }

      if (session.status === "open") {
        await stripe.checkout.sessions.expire(session.id, {
          stripeAccount: square.board.host.stripeAccountId!,
        });
      }

      // The whole batch moves together — a checkout is one purchase. Scoped to
      // `pending` so a square the webhook just confirmed is never touched.
      const batchWhere = square.batchId
        ? { batchId: square.batchId, paymentStatus: "pending" as const }
        : { squareId, paymentStatus: "pending" as const };

      if (action === "release") {
        // Mirrors the release in resolveHoldBatch — the reference for what
        // "back to open" means on a fundraiser board.
        const { count } = await prisma.square.updateMany({
          where: batchWhere,
          data: {
            paymentStatus: "open",
            playerName: null,
            playerEmail: null,
            playerPhone: null,
            stripePaymentId: null,
            checkoutSessionId: null,
            checkoutExpiresAt: null,
            holdExpiresAt: null,
            batchId: null,
            pricePaidCents: null,
            claimedAt: null,
            contributionId: null,
            releaseReason: "expired",
          },
        });
        // Abandoned-claim cleanup, same helper the cron uses.
        if (square.batchId && count > 0) {
          await releaseAdmissionForBatch(square.batchId);
        }
        if (square.contributionId) {
          await prisma.contribution.updateMany({
            where: { id: square.contributionId, status: "pending" },
            data: { status: "released", releasedAt: new Date() },
          });
        }
        return NextResponse.json({ released: count });
      }

      // action === "cash". The SAME tickets, a different way to pay for them.
      // Price is NOT recomputed — invariant 42 fixes it at claim, and a
      // contributor who claimed at the early-bird price still owes that.
      const { count } = await prisma.square.updateMany({
        where: batchWhere,
        data: {
          paymentStatus: "reserved_cash",
          paymentMethod: "cash",
          stripePaymentId: null,
          checkoutSessionId: null,
          checkoutExpiresAt: null,
          // No hold on a cash reservation — the host releases those at her
          // discretion, and a countdown here would be a timer with nothing
          // behind it.
          holdExpiresAt: null,
          releaseReason: null,
        },
      });

      if (count === 0) {
        return NextResponse.json(
          { error: "These tickets are no longer held. Please claim again." },
          { status: 409 }
        );
      }

      return NextResponse.json({
        switchedToCash: true,
        count,
        handles: {
          zelle: square.board.hostZelle,
          cashapp: square.board.hostCashapp,
          venmo: square.board.hostVenmo,
          paypal: square.board.hostPaypal,
        },
      });
    }

    // Session is still open — return the URL for the player to resume
    if (!session.url) {
      return NextResponse.json(
        { error: "Payment session has no URL. Please try again." },
        { status: 502 }
      );
    }

    return NextResponse.json({ checkoutUrl: session.url });
  } catch (error) {
    console.error("Resume checkout error:", error);
    return NextResponse.json(
      { error: "Something went wrong. Please try again." },
      { status: 500 }
    );
  }
}
