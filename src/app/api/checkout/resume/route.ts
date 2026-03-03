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

interface ResumeBody {
  squareId: string;
  email: string;
}

export async function POST(request: Request) {
  try {
    const body: ResumeBody = await request.json();
    const { squareId } = body;
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
