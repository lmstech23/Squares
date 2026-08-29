import { prisma } from "@/lib/prisma";
import { resolveHoldBatch } from "@/lib/checkout-holds";

// Campaign close — fundraiser-money-state-machine.md §7.
//
//   OPEN → CLOSING → CLOSED
//
// CLOSING exists to eliminate the one moment where "payment always wins" and
// "final amounts are immutable" could contradict each other. A campaign closes
// at 3:00:00, totals finalize at 3:00:01 at $3,250, and a delayed Stripe
// webhook arrives at 3:00:04 for a $150 checkout that genuinely succeeded
// before the cutoff. Reconciling first means there is no such webhook: every
// outstanding payment is resolved against Stripe BEFORE anything is written.
//
// Phase A has no prize, so there is no draw, no finalPrizePoolCents and no
// winners. Closing stops claims and freezes the raised figure. That is all.
//
// Passes are untouched. The campaign ends; the event happens later, and a
// campaign that closed October 9 still has tickets that scan on October 24
// (admission invariant 36).

export type CloseOutcome =
  | { ok: true; status: "closed"; finalRaisedCents: number; alreadyFinal: boolean }
  | { ok: true; status: "closing"; blockedBy: { pending: number; awaiting: number } }
  | { ok: false; reason: "not_fundraiser" | "not_found" | "wrong_status" };

/**
 * Move a board through CLOSING and, if everything reconciles, to CLOSED.
 *
 * Idempotent and safe to call repeatedly. A board that cannot finalize stays
 * in `closing` and reports what is blocking it, so the next cron pass or the
 * host's next attempt picks up where this one stopped.
 *
 * `hostInitiated` distinguishes the two paths in money doc §7 step 2. On a
 * scheduled close, unresolved direct payments auto-release at the cutoff and
 * no host action is needed. On an early close the host must resolve each one
 * inside the flow, so they are reported rather than released — releasing
 * someone's reservation because the host clicked Close early would throw away
 * money she may be about to collect.
 */
export async function closeBoard(
  boardId: string,
  opts: { hostInitiated: boolean; now?: Date }
): Promise<CloseOutcome> {
  const now = opts.now ?? new Date();

  const board = await prisma.board.findUnique({
    where: { boardId },
    select: {
      boardId: true,
      boardType: true,
      status: true,
      finalRaisedCents: true,
    },
  });

  if (!board) return { ok: false, reason: "not_found" };
  if (board.boardType !== "fundraiser") return { ok: false, reason: "not_fundraiser" };

  // Already finalized. Immutable — invariant 13. Report the stored figure
  // rather than recomputing, so a second call can never produce a different
  // number than the one already published.
  if (board.status === "closed" && board.finalRaisedCents != null) {
    return {
      ok: true,
      status: "closed",
      finalRaisedCents: board.finalRaisedCents,
      alreadyFinal: true,
    };
  }

  if (board.status !== "open" && board.status !== "closing") {
    return { ok: false, reason: "wrong_status" };
  }

  // Step 0 — stop taking money. Conditional so two concurrent closes cannot
  // both believe they started it.
  if (board.status === "open") {
    await prisma.board.updateMany({
      where: { boardId, status: "open" },
      data: { status: "closing" },
    });
  }

  // Step 1 — resolve every outstanding card checkout against Stripe. Query
  // session status directly; do not wait for webhooks. Paid confirms the
  // batch, unpaid expires the session BEFORE releasing, same sequence as
  // invariant 18. holdExpiresAt is already capped at campaign close, so no
  // hold can still be legitimately running — this is reconciliation, not
  // waiting.
  const pendingBatches = await prisma.square.findMany({
    where: { boardId, paymentStatus: "pending", batchId: { not: null } },
    select: { batchId: true },
    distinct: ["batchId"],
  });

  for (const { batchId } of pendingBatches) {
    if (batchId) await resolveHoldBatch(batchId, now);
  }

  // Step 2 — outstanding direct payments.
  if (!opts.hostInitiated) {
    // Scheduled close: unresolved reservations auto-release at the cutoff. If
    // money was not confirmed by close it does not count — no ticket, no
    // dollars, the square releases (money doc §4).
    await prisma.square.updateMany({
      where: { boardId, paymentStatus: "reserved_cash" },
      data: {
        paymentStatus: "open",
        playerName: null,
        playerEmail: null,
        playerPhone: null,
        batchId: null,
        pricePaidCents: null,
        claimedAt: null,
        releaseReason: "expired",
      },
    });
  }

  // Step 3 — assert clean. If anything remains, CLOSING does not advance.
  const [pending, awaiting] = await Promise.all([
    prisma.square.count({ where: { boardId, paymentStatus: "pending" } }),
    prisma.square.count({ where: { boardId, paymentStatus: "reserved_cash" } }),
  ]);

  if (pending > 0 || awaiting > 0) {
    return { ok: true, status: "closing", blockedBy: { pending, awaiting } };
  }

  // Steps 4–8 — finalization, in one transaction.
  //
  // No finalPrizePoolCents and no draw: Phase A boards carry no prize, so
  // there is nothing to compute and nothing to enable.
  const finalRaisedCents = await prisma.$transaction(async (tx) => {
    // Recompute from confirmed squares only, as a sum of pricePaidCents —
    // never count times price (invariant 43). A board with early-bird squares
    // has no single price to multiply by.
    const sum = await tx.square.aggregate({
      where: { boardId, paymentStatus: "paid" },
      _sum: { pricePaidCents: true },
    });
    const total = sum._sum.pricePaidCents ?? 0;

    // Conditional on finalRaisedCents still being null. Two concurrent
    // finalizations cannot both write, and the second reads back the first
    // one's figure rather than overwriting it.
    await tx.board.updateMany({
      where: { boardId, finalRaisedCents: null },
      data: { finalRaisedCents: total, status: "closed" },
    });

    // Covers the case where another caller finalized between the aggregate
    // and the update.
    const after = await tx.board.findUnique({
      where: { boardId },
      select: { finalRaisedCents: true },
    });
    return after?.finalRaisedCents ?? total;
  });

  return { ok: true, status: "closed", finalRaisedCents, alreadyFinal: false };
}

/**
 * Close every fundraiser board whose campaign end has passed.
 *
 * Called from the five-minute cron. A scheduled close needs no host action, so
 * a host who never opens the dashboard still gets a finalized board.
 */
export async function closeDueBoards(now = new Date()): Promise<{
  examined: number;
  closed: number;
  stillClosing: number;
}> {
  const due = await prisma.board.findMany({
    where: {
      boardType: "fundraiser",
      status: { in: ["open", "closing"] },
      campaignEndsAt: { lte: now },
    },
    select: { boardId: true },
  });

  let closed = 0;
  let stillClosing = 0;

  for (const b of due) {
    try {
      const outcome = await closeBoard(b.boardId, { hostInitiated: false, now });
      if (outcome.ok && outcome.status === "closed") closed++;
      else if (outcome.ok) stillClosing++;
    } catch (err) {
      // One board must not stop the rest. It stays in `closing` and the next
      // pass retries.
      console.error(`Close failed for board ${b.boardId}:`, err);
      stillClosing++;
    }
  }

  return { examined: due.length, closed, stillClosing };
}
