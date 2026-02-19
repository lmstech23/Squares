import { NextResponse } from "next/server";
import { stripe } from "@/lib/stripe";
import { prisma } from "@/lib/prisma";
import Stripe from "stripe";

// Disable body parsing — we need the raw body for signature verification
export const runtime = "nodejs";

/**
 * Stripe Webhook Handler — v2 Thin Events
 *
 * Stripe API version 2026-01-28.clover sends "thin" events:
 * - event.type is prefixed: "v1.checkout.session.completed"
 * - event.data is empty — no snapshot payload
 * - event.related_object.id has the object ID
 * - We must fetch the full object from Stripe API ourselves
 *
 * Business logic (idempotency, state guards, transactions) is unchanged.
 */
export async function POST(request: Request) {
  const body = await request.text();
  const signature = request.headers.get("stripe-signature");

  if (!signature) {
    return NextResponse.json(
      { error: "Missing stripe-signature header" },
      { status: 400 }
    );
  }

  // constructEvent still works the same for thin events
  let event: any;

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
    const eventType: string = event.type;
    const relatedObject = event.related_object ?? event.data?.object;

    console.log(`Webhook received: ${eventType}`, {
      id: event.id,
      relatedObjectId: relatedObject?.id,
    });

    switch (eventType) {
      // ========================================
      // v2 thin event types (prefixed with v1.)
      // ========================================
      case "v1.checkout.session.completed":
      case "checkout.session.completed": {
        const session = await fetchCheckoutSession(event);
        if (session) await handleCheckoutCompleted(session);
        break;
      }

      case "v1.checkout.session.expired":
      case "checkout.session.expired": {
        const session = await fetchCheckoutSession(event);
        if (session) await handleCheckoutExpired(session);
        break;
      }

      case "v1.account.updated":
      case "account.updated": {
        const account = await fetchAccount(event);
        if (account) await handleAccountUpdated(account);
        break;
      }

      default:
        console.log(`Unhandled event type: ${eventType}`);
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
// FETCH HELPERS — hydrate thin events into full objects
// ============================================================

/**
 * Fetch the full Checkout Session from Stripe.
 * For connected account sessions, we need to pass stripeAccount.
 *
 * Strategy: try with account context from event first,
 * fall back to looking up from square metadata if needed.
 */
async function fetchCheckoutSession(
  event: any
): Promise<Stripe.Checkout.Session | null> {
  // v2 thin event: full object is NOT in data.object
  // v1 classic event: full object IS in data.object
  if (event.data?.object?.id && event.data?.object?.metadata) {
    // Classic v1 format — already has the full object
    return event.data.object as Stripe.Checkout.Session;
  }

  const objectId =
    event.related_object?.id ?? event.data?.object?.id;
  if (!objectId) {
    console.error("No object ID found in event:", event.id);
    return null;
  }

  // Connected account ID from event context
  const connectedAccountId =
    event.account ?? event.context?.account_id ?? null;

  try {
    const session = await stripe.checkout.sessions.retrieve(
      objectId,
      { expand: ["metadata"] },
      connectedAccountId ? { stripeAccount: connectedAccountId } : undefined
    );
    return session;
  } catch (err) {
    // If retrieve fails without account context, try finding the account
    // from our database using the session ID on a square
    if (!connectedAccountId) {
      try {
        const square = await prisma.square.findFirst({
          where: { stripePaymentId: objectId },
          include: {
            board: {
              include: {
                host: { select: { stripeAccountId: true } },
              },
            },
          },
        });

        if (square?.board.host.stripeAccountId) {
          const session = await stripe.checkout.sessions.retrieve(
            objectId,
            {},
            { stripeAccount: square.board.host.stripeAccountId }
          );
          return session;
        }
      } catch (fallbackErr) {
        console.error("Fallback session fetch also failed:", fallbackErr);
      }
    }

    console.error(`Failed to fetch checkout session ${objectId}:`, err);
    return null;
  }
}

/**
 * Fetch the full Account object from Stripe.
 */
async function fetchAccount(event: any): Promise<Stripe.Account | null> {
  // Classic v1 format
  if (event.data?.object?.id && event.data?.object?.charges_enabled !== undefined) {
    return event.data.object as Stripe.Account;
  }

  const objectId =
    event.related_object?.id ?? event.data?.object?.id;
  if (!objectId) {
    console.error("No account ID found in event:", event.id);
    return null;
  }

  try {
    const account = await stripe.accounts.retrieve(objectId);
    return account;
  } catch (err) {
    console.error(`Failed to fetch account ${objectId}:`, err);
    return null;
  }
}

// ============================================================
// HANDLERS (business logic unchanged)
// ============================================================

/**
 * Sync Stripe account readiness to Host record.
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
 * Payment succeeded — lock squares as paid, create PaymentReferences.
 * Supports both single-square (legacy) and multi-square checkout.
 *
 * Guards:
 * 1. Idempotency via PaymentReference.stripeSessionId unique constraint
 * 2. State guard: only transitions pending → paid
 * 3. Session identity: stripePaymentId on Square must match this session
 * 4. Atomic: updateMany + PaymentReference create in one transaction
 */
async function handleCheckoutCompleted(session: Stripe.Checkout.Session) {
  // Multi-square: squareIds is comma-separated
  // Legacy: single squareId
  const squareIds = session.metadata?.squareIds
    ? session.metadata.squareIds.split(",")
    : session.metadata?.squareId
      ? [session.metadata.squareId]
      : [];

  if (squareIds.length === 0) {
    console.warn(
      `checkout.session.completed: no squareIds in metadata for session ${session.id}`
    );
    return;
  }

  const perSquareAmount = Math.round(
    (session.amount_total ?? 0) / squareIds.length
  );

  for (const squareId of squareIds) {
    // Unique key per square within a multi-square session
    const sessionKey =
      squareIds.length > 1 ? `${session.id}:${squareId}` : session.id;

    // Idempotency: skip if PaymentReference already exists
    const existing = await prisma.paymentReference.findUnique({
      where: { stripeSessionId: sessionKey },
    });
    if (existing) continue;

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
            stripeSessionId: sessionKey,
            amount: perSquareAmount,
          },
        });
      });

      console.log(
        `checkout.session.completed: square ${squareId} marked paid (session ${session.id})`
      );
    } catch (error) {
      if (error instanceof Error && error.message === "STATE_MISMATCH") {
        console.warn(
          `checkout.session.completed: square ${squareId} not in expected state for session ${session.id}. May need manual refund.`
        );
        continue;
      }
      throw error;
    }
  }
}

/**
 * Checkout session expired — release all squares.
 * Supports both single-square and multi-square checkout.
 */
async function handleCheckoutExpired(session: Stripe.Checkout.Session) {
  const squareIds = session.metadata?.squareIds
    ? session.metadata.squareIds.split(",")
    : session.metadata?.squareId
      ? [session.metadata.squareId]
      : [];

  if (squareIds.length === 0) return;

  for (const squareId of squareIds) {
    await prisma.square.updateMany({
      where: {
        squareId,
        paymentStatus: "pending",
        stripePaymentId: session.id,
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
  }

  console.log(
    `checkout.session.expired: released ${squareIds.length} square(s) for session ${session.id}`
  );
}
