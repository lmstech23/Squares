import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { stripe } from "@/lib/stripe";
import { baseUrlFromRequest } from "@/lib/base-url";
import {
  createPendingCardContribution,
  MIN_CARD_DONATION_CENTS,
} from "@/lib/contributions";

// ============================================================
// CONTRIBUTOR: donation-only card checkout — donations §6.
//
//   enter amount -> Contribution created pending -> one Checkout Session
//     -> checkout.session.completed -> confirmed, raised increases
//     -> abandoned            -> session expires -> released
//
// NO SQUARES MOVE. No inventory is touched, no hold is taken, and no
// countdown is returned — invariant 64, because nothing is being held and a
// timer would manufacture urgency for a scarcity that doesn't exist.
//
// THIS IS A SEPARATE ROUTE ON PURPOSE. /api/checkout exists to lock squares:
// it loads the board *through* the squares, merges prior holds, re-checks
// per-player caps and rolls inventory back on failure. A donation does none of
// that, so threading a zero-square case through it would mean adding branches
// to every one of those steps — in the one route that must keep working
// unchanged. The mixed case still goes there, because it does lock squares.
// ============================================================

export const runtime = "nodejs";

interface DonateBody {
  amountCents: number;
  donorName: string;
  donorEmail: string;
  donorPhone?: string | null;
  /// "card" -> Stripe Checkout. "cash" -> Zelle/CashApp/Venmo/PayPal, recorded
  /// pending for the host to confirm on receipt. Defaults to card so every
  /// existing caller is unchanged.
  method?: "card" | "cash";
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  try {
    const { slug } = await params;
    const body: DonateBody = await request.json();

    const amountCents = Math.trunc(body.amountCents ?? 0);
    const method = body.method === "cash" ? "cash" : "card";
    const name = body.donorName?.trim() ?? "";
    const email = body.donorEmail?.trim().toLowerCase() ?? "";

    if (!name) {
      return NextResponse.json({ error: "Your name is required." }, { status: 400 });
    }
    // Card requires an email: the CHECK constraint on `contributions` refuses
    // a non-cash row without one, and a receipt has nowhere else to go.
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json({ error: "A valid email is required." }, { status: 400 });
    }
    if (!Number.isFinite(amountCents) || amountCents <= 0) {
      return NextResponse.json(
        { error: "Enter an amount greater than zero." },
        { status: 400 }
      );
    }
    // Server-side, not only in the picker — donations §6. CARD ONLY: the floor
    // exists because Stripe's per-transaction cost consumes most of a small
    // gift. A direct payment has no processor and therefore no floor.
    if (method === "card" && amountCents < MIN_CARD_DONATION_CENTS) {
      return NextResponse.json(
        { error: `The minimum donation is $${MIN_CARD_DONATION_CENTS / 100}.` },
        { status: 400 }
      );
    }

    const board = await prisma.board.findUnique({
      where: { slug },
      include: {
        host: { select: { stripeAccountId: true, stripeChargesEnabled: true } },
        event: { select: { id: true } },
      },
    });

    if (!board) {
      return NextResponse.json({ error: "Board not found." }, { status: 404 });
    }
    // A Game Day board must never accumulate donation money — donations §5.
    if (board.boardType !== "fundraiser") {
      return NextResponse.json(
        { error: "Donations are not available on this board." },
        { status: 400 }
      );
    }
    // Donations stop when the board leaves OPEN — invariant 66.
    if (board.status !== "open") {
      return NextResponse.json(
        { error: "This board is no longer accepting contributions." },
        { status: 409 }
      );
    }
    // Campaigns close on a date, not a board status — invariant 6.
    if (board.campaignEndsAt && board.campaignEndsAt <= new Date()) {
      return NextResponse.json({ error: "This campaign has closed." }, { status: 409 });
    }

    // ---------------------------------------------------------------- CASH --
    //
    // The contributor declares a direct payment - Zelle, Cash App, Venmo or
    // PayPal - and the host confirms it from the donations panel when it
    // lands. Same shape the ticket sheet has offered all along; this is the
    // donation half of it.
    //
    // READING OF INVARIANT 65, stated because it is load-bearing. That
    // invariant forbids a cash donation having "no reserved state... no
    // cash-donation hold, expiry, or release", and donations SS7 describes the
    // host-recorded path as "one host action". A contributor-declared cash
    // donation has NO hold, NO expiry and NO release path - nothing is held
    // because a donation holds no inventory - so none of the three
    // prohibitions is engaged. `pending` here is invariant 61's ordinary
    // payment-lifecycle value meaning "the host has not received it yet",
    // which is exactly where a Zelle transfer sits between sending and
    // arriving. SS7 simply does not contemplate the contributor-initiated
    // case; it is unspecified rather than forbidden.
    if (method === "cash") {
      if (!board.cashModeEnabled) {
        return NextResponse.json(
          { error: "Direct payments are not enabled for this board." },
          { status: 403 }
        );
      }
      const hasHandle =
        board.hostZelle || board.hostCashapp || board.hostVenmo || board.hostPaypal;
      if (!hasHandle) {
        return NextResponse.json(
          { error: "This host has not set up a direct payment method." },
          { status: 503 }
        );
      }

      const pending = await prisma.contribution.create({
        data: {
          boardId: board.boardId,
          status: "pending",
          paymentMethod: "cash",
          squareAmountCents: 0,
          donationAmountCents: amountCents,
          totalPaidCents: amountCents,
          contributorName: name,
          contributorEmail: email,
          contributorPhone: body.donorPhone?.trim() || null,
          // No holdExpiresAt. Nothing is held, so there is nothing to expire
          // and no sweep will ever touch this row - invariants 64 and 65.
          holdExpiresAt: null,
        },
      });

      return NextResponse.json({
        pending: true,
        contributionId: pending.id,
        amountCents,
        handles: {
          zelle: board.hostZelle,
          cashapp: board.hostCashapp,
          venmo: board.hostVenmo,
          paypal: board.hostPaypal,
        },
      });
    }

    // ---------------------------------------------------------------- CARD --
    if (!board.host.stripeAccountId || !board.host.stripeChargesEnabled) {
      return NextResponse.json(
        { error: "Host payment setup is incomplete." },
        { status: 503 }
      );
    }

    // Ledger row first, session second. If session creation fails the
    // contribution is released and nothing was ever charged.
    const contribution = await prisma.$transaction((tx) =>
      createPendingCardContribution(tx, {
        boardId: board.boardId,
        squareAmountCents: 0,
        donationAmountCents: amountCents,
        contributorName: name,
        contributorEmail: email,
        contributorPhone: body.donorPhone?.trim() || null,
        holdExpiresAt: null,
      })
    );

    const baseUrl = baseUrlFromRequest(request);
    const boardUrl = `${baseUrl}/board/${board.slug}`;

    let session;
    try {
      session = await stripe.checkout.sessions.create(
        {
          mode: "payment",
          line_items: [
            {
              price_data: {
                currency: board.currency.toLowerCase(),
                product_data: {
                  name: "Donation",
                  description: board.gameName,
                },
                unit_amount: amountCents,
              },
              quantity: 1,
            },
          ],
          customer_email: email,
          metadata: {
            boardId: board.boardId,
            contributionId: contribution.id,
            kind: "donation",
          },
          success_url: `${boardUrl}?donated=true&session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${boardUrl}?cancelled=true`,
        },
        { stripeAccount: board.host.stripeAccountId }
      );
    } catch (stripeError) {
      console.error("Donation Checkout creation failed:", stripeError);
      await prisma.contribution.updateMany({
        where: { id: contribution.id, status: "pending" },
        data: { status: "released", releasedAt: new Date() },
      });
      return NextResponse.json(
        { error: "Payment setup failed. Please try again." },
        { status: 502 }
      );
    }

    await prisma.contribution.update({
      where: { id: contribution.id },
      data: { checkoutSessionId: session.id },
    });

    // No holdExpiresAt in the response. Invariant 64 — there is no countdown
    // because there is no hold.
    return NextResponse.json({
      checkoutUrl: session.url,
      contributionId: contribution.id,
      amountCents,
    });
  } catch (error) {
    console.error("Donate error:", error);
    return NextResponse.json(
      { error: "Something went wrong. Please try again." },
      { status: 500 }
    );
  }
}
