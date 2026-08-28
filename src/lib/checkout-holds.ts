import { prisma } from "@/lib/prisma";
import { stripe } from "@/lib/stripe";
import { releaseAdmissionForBatch } from "@/lib/admission";
import { confirmSquares } from "@/lib/confirm-square";

// Resolve-then-release — fundraiser-money-state-machine.md §3, invariants 18–20.
//
// THE CRON DOES NOT RELEASE SQUARES. When a Daali hold expires it queues the
// batch for resolution and runs this sequence:
//
//   hold expires → query the Stripe session
//     complete / paid  → confirm the full batch, release nothing
//     open / unpaid    → expire the Stripe session, THEN release the batch
//
// The ordering is the guarantee, not a nicety. Stripe's minimum session
// lifetime is 30 minutes and the Daali hold is 10, so between minute 10 and
// minute 30 a session is still capable of taking a payment. Releasing on
// timestamp alone hands the square to someone else while the first
// contributor's card can still succeed — and then two people own it and one of
// them paid. Expiring the session first makes a released batch incapable of
// producing a late payment, which is why there is no late-success recovery
// path anywhere in this codebase (invariant 20).
//
// Game Day is untouched: it keeps releasing on timestamp, which is correct for
// it because its hold and its Stripe session expire together.

/** How many batches one cron pass will resolve. Keeps the run bounded. */
const MAX_BATCHES_PER_RUN = 25;

export interface ResolveResult {
  batchesExamined: number;
  batchesConfirmed: number;
  batchesReleased: number;
  squaresReleased: number;
  grantsDeleted: number;
  supportersDeleted: number;
  errors: number;
}

/**
 * Resolve every fundraiser card hold whose `holdExpiresAt` has passed.
 *
 * Safe to run concurrently with itself in the sense that it cannot double-pay
 * or double-release: every write is a conditional `updateMany` that matches
 * only squares still in the state it expects.
 */
export async function resolveExpiredHolds(now = new Date()): Promise<ResolveResult> {
  const result: ResolveResult = {
    batchesExamined: 0,
    batchesConfirmed: 0,
    batchesReleased: 0,
    squaresReleased: 0,
    grantsDeleted: 0,
    supportersDeleted: 0,
    errors: 0,
  };

  const expired = await prisma.square.findMany({
    where: {
      paymentStatus: "pending",
      holdExpiresAt: { lt: now },
      batchId: { not: null },
      board: { boardType: "fundraiser" },
    },
    select: {
      squareId: true,
      batchId: true,
      checkoutSessionId: true,
      board: {
        select: {
          boardId: true,
          host: { select: { stripeAccountId: true } },
          event: { select: { id: true } },
        },
      },
    },
  });

  // Group by batch. A batch confirms or releases together — partial
  // confirmation is impossible on card (money doc §3).
  const batches = new Map<string, typeof expired>();
  for (const sq of expired) {
    const list = batches.get(sq.batchId!) ?? [];
    list.push(sq);
    batches.set(sq.batchId!, list);
  }

  for (const [batchId] of Array.from(batches).slice(0, MAX_BATCHES_PER_RUN)) {
    result.batchesExamined++;
    const one = await resolveHoldBatch(batchId, now);
    result.batchesConfirmed += one.confirmed ? 1 : 0;
    result.batchesReleased += one.released > 0 ? 1 : 0;
    result.squaresReleased += one.released;
    result.grantsDeleted += one.grantsDeleted;
    result.supportersDeleted += one.supportersDeleted;
    result.errors += one.error ? 1 : 0;
  }

  return result;
}

export interface BatchResolution {
  confirmed: boolean;
  released: number;
  grantsDeleted: number;
  supportersDeleted: number;
  error: boolean;
  /** Set when the batch was not touched because its hold has not expired. */
  notYetExpired?: boolean;
}

/**
 * Resolve one batch through the sequence in invariant 18.
 *
 * Shared by the cron and by the host's manual release, so there is exactly one
 * implementation of "payment always wins before release" (invariant 20). A
 * second copy would be a second chance to get the ordering wrong.
 *
 * Refuses to act before `holdExpiresAt` — invariant 19: a pending batch may be
 * released manually only after the hold has passed, and only through this
 * sequence. Before that the checkout is genuinely live.
 */
export async function resolveHoldBatch(
  batchId: string,
  now = new Date()
): Promise<BatchResolution> {
  const nil: BatchResolution = {
    confirmed: false,
    released: 0,
    grantsDeleted: 0,
    supportersDeleted: 0,
    error: false,
  };

  const squares = await prisma.square.findMany({
    where: { batchId, paymentStatus: "pending" },
    select: {
      squareId: true,
      holdExpiresAt: true,
      checkoutSessionId: true,
      board: {
        select: {
          boardId: true,
          host: { select: { stripeAccountId: true } },
          event: { select: { id: true } },
        },
      },
    },
  });

  if (squares.length === 0) return nil;

  const first = squares[0];

  // Invariant 19. The control is absent rather than disabled in the UI, but
  // the server refuses regardless — the UI is not the guarantee.
  if (squares.some((sq) => !sq.holdExpiresAt || sq.holdExpiresAt > now)) {
    return { ...nil, notYetExpired: true };
  }

  const sessionId = squares.find((s) => s.checkoutSessionId)?.checkoutSessionId;
  const stripeAccount = first.board.host.stripeAccountId;

  try {
    // No session recorded means checkout never got that far. There is
    // nothing that could still pay, so the batch is safe to release.
    let paid = false;

    if (sessionId && stripeAccount) {
      const session = await stripe.checkout.sessions.retrieve(sessionId, {
        stripeAccount,
      });
      paid = session.status === "complete" || session.payment_status === "paid";

      if (!paid) {
        // Expire BEFORE releasing. If this throws we leave the squares held
        // and try again next pass — a stuck hold is recoverable, a
        // double-sold square is not.
        if (session.status === "open") {
          await stripe.checkout.sessions.expire(sessionId, { stripeAccount });
        }
      }
    }

    if (paid) {
      // Confirm the full batch through the shared path, so minting happens
      // here exactly as it does in the webhook. Idempotent: if the webhook
      // already flipped these, nothing is confirmed and nothing is minted.
      await prisma.$transaction((tx) =>
        confirmSquares(
          tx,
          squares.map((sq) => sq.squareId),
          "pending"
        )
      );
      return { ...nil, confirmed: true };
    }

    // Release the whole batch, conditionally on it still being pending.
    const released = await prisma.square.updateMany({
      where: { batchId, paymentStatus: "pending" },
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
        releaseReason: "expired",
      },
    });

    // Abandoned-claim cleanup — addendum §4.
    let cleaned = { grantsDeleted: 0, supportersDeleted: 0 };
    if (first.board.event) {
      cleaned = await releaseAdmissionForBatch(batchId);
    }

    return { ...nil, released: released.count, ...cleaned };
  } catch (error) {
    // One bad batch must not stop the rest. Its squares stay held and the
    // next pass tries again.
    console.error(`Hold resolution failed for batch ${batchId}:`, error);
    return { ...nil, error: true };
  }
}

