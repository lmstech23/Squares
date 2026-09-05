// Invariant 16 — what a host may no longer change once real money has arrived.
//
// fundraiser-money-state-machine.md, invariant 16:
//
//   "After the first confirmed contribution, these are locked: square count,
//    the contribution price schedule (both prices and the changeover time),
//    prize on/off, prize percent, tier count, drawing rule, drawing date, and
//    — on boards with an event — event date and the maximum attendee allowance
//    per supporter."
//
// THIS IS THE FIRST ENFORCEMENT OF INVARIANT 16 IN THIS CODEBASE. Until the
// fundraiser event edit surface existed, the invariant was satisfied vacuously:
// no route could change any of those fields, so nothing needed to guard them.
// Contribution price, early-bird terms and prize terms still have no edit path.
// WHEN THEY GET ONE, THEY MUST CALL THIS PREDICATE rather than growing their
// own check — a second implementation is a second thing to drift.

import type { Prisma } from "@prisma/client";
// RELATIVE, WITH THE EXTENSION, and not the "@/" alias. The alias is a
// tsconfig path that node --experimental-strip-types does not resolve, and
// board-lock.integration.test.ts runs under that runner - the same runner
// confirm-square.integration.test.ts uses. An untestable predicate is worse
// than a slightly less idiomatic import: invariant 76 is derived by price
// comparison and has to be proven against real rows.
import { prisma as defaultClient } from "./prisma.ts";

/**
 * Has this board received a confirmed contribution?
 *
 * "First contribution" means the first square reaching `paymentStatus = "paid"`.
 * Not `pending`, not `reserved_cash`. The derivation, so nobody has to re-argue
 * it at the next call site:
 *
 *  - Invariant 1: "`raised` counts confirmed contributions only. Never claimed,
 *    reserved, or pending." Every place this codebase computes `raised` filters
 *    on `paid` and nothing else.
 *  - Invariant 3: "A reserved cash square contributes $0 and holds no ticket."
 *    A reservation is a promise, not money.
 *  - `pending` and `reserved_cash` are REVERSIBLE. `resolveExpiredHolds`
 *    returns them to `open`, and `closeBoard` treats both as unresolved rather
 *    than as revenue. A rule that counted reservations would permanently lock a
 *    board on the strength of a hold that expired ten minutes later and left no
 *    trace — locking the host out over an event that never happened.
 *
 * Money arriving is the thing that makes terms binding on someone other than
 * the host, and `paid` is the only state that means money arrived.
 */
export async function hasConfirmedContribution(
  boardId: string,
  client: Prisma.TransactionClient | typeof defaultClient = defaultClient
): Promise<boolean> {
  const count = await client.square.count({
    where: { boardId, paymentStatus: "paid" },
    take: 1,
  });
  return count > 0;
}

/**
 * The fields the fundraiser edit surface may not write once a contribution has
 * confirmed.
 *
 * BROADER THAN INVARIANT 16 AS WRITTEN, deliberately. The invariant says
 * "event date", singular. This locks `startsAt`, `endsAt` AND `timezone`.
 *
 * Why `timezone`: an event stored as 2026-10-24T14:27Z in America/New_York is
 * 10:27am Eastern. Re-label the board America/Chicago and the same instant
 * reads 9:27am — the wall-clock time a supporter was told has moved, without
 * `startsAt` or `endsAt` being touched. An invariant that can be sidestepped by
 * editing a timezone string is not protecting contributors; it is only
 * protecting a column. Locking `startsAt` alone leaves that bypass open.
 *
 * Why `endsAt`: it is half of the event date. A supporter who planned around a
 * stated end time is as affected by moving it as by moving the start.
 *
 * DOCUMENT GAP, FLAGGED NOT RESOLVED: invariant 16's wording says "event date"
 * and should say something closer to "the event's scheduled time, including its
 * timezone". Recorded in PHASE-2-BACKLOG.md for the addendum to catch up. This
 * code is deliberately stricter than the text in the meantime; if the addendum
 * lands narrower, narrow this to match rather than leaving the two disagreeing.
 *
 * NOT locked, and correctly so:
 *  - `Event.name` and `Event.venue` — not named in invariant 16, and a venue
 *    correction is the ordinary case this surface exists for.
 *  - `Board.fundraisingGoalCents` — v2 §7 states a goal is "aspirational, not a
 *    term of the deal" and is explicitly NOT locked by invariant 16.
 */
export const EVENT_FIELDS_LOCKED_AFTER_CONTRIBUTION = [
  "startsAt",
  "endsAt",
  "timezone",
] as const;

export type LockedEventField = (typeof EVENT_FIELDS_LOCKED_AFTER_CONTRIBUTION)[number];

/**
 * Human-readable reason, shown in the UI beside a disabled control.
 *
 * A host who finds a field disabled with no explanation assumes a bug and
 * contacts support. Saying why converts a dead end into a rule she can plan
 * around.
 */
export const LOCK_REASON =
  "Locked because this campaign has confirmed contributions. " +
  "Event timing is part of what contributors agreed to when they gave.";

/**
 * The three independent locks that govern a fundraiser's pricing and size.
 *
 * INVENTORY and PRICE are separate rules and must not be merged.
 *
 * INVENTORY — money doc invariant 16 already locks *square count* at the first
 * confirmed contribution. What changed is that the host no longer sets it
 * directly; it is derived. The trigger is ANY confirmed square, early bird or
 * regular, because TICKET NUMBERS ARE SQUARE POSITIONS: an early-bird buyer
 * holding ticket #87 must not have the board shrink underneath her.
 *
 * PRICE — launch-readiness v2.1 §1.4, invariant 76:
 *
 *   "The early bird fields (earlyBirdPriceCents, earlyBirdEndsAt) lock at the
 *    first confirmed square whose priceSource = early_bird. The regular price
 *    (squarePrice) locks at the first confirmed square whose priceSource =
 *    regular. Neither lock affects the other."
 *
 * DERIVING priceSource WITHOUT THE COLUMN. There is no `priceSource` enum in
 * this schema and none is being added. The source is derived by comparing a
 * confirmed square's `pricePaidCents` against the board's two prices, which is
 * sound ONLY because `boards_early_bird_coherent` guarantees they are distinct:
 *
 *   CHECK (early_bird_price_cents IS NULL
 *          OR (early_bird_ends_at IS NOT NULL
 *              AND early_bird_price_cents < square_price))
 *
 * The addendum warns that derivation by comparison "silently produces the wrong
 * answer if the CHECK is ever relaxed". IT IS NOT RELIED ON HERE. That CHECK is
 * live in PRODUCTION but is absent from `prisma/migrations/0_init` and from
 * daali-dev, so any database rebuilt from migrations does not have it — found
 * while testing this change and reported separately.
 *
 * So this function does not assume the prices are distinct. If they are equal,
 * a confirmed square at that amount could have been bought under either, and
 * BOTH lock. The comparison is only trusted where it is unambiguous.
 *
 * A confirmed square matching NEITHER price is treated as locking BOTH. It
 * should be impossible — the locks below are what stop a price moving out from
 * under a confirmed square — so its existence means an assumption has already
 * failed, and the safe response to that is to stop allowing price edits rather
 * than to guess which price it was.
 */
export interface PricingLocks {
  /** A confirmed square exists at all. Board size is fixed. */
  inventoryLocked: boolean;
  /** A confirmed square was bought at the early bird price. */
  earlyBirdLocked: boolean;
  /** A confirmed square was bought at the regular price. */
  regularLocked: boolean;
}

export async function pricingLocks(
  boardId: string,
  client: Prisma.TransactionClient | typeof defaultClient = defaultClient
): Promise<PricingLocks> {
  const board = await client.board.findUnique({
    where: { boardId },
    select: { squarePrice: true, earlyBirdPriceCents: true },
  });
  if (!board) {
    return { inventoryLocked: true, earlyBirdLocked: true, regularLocked: true };
  }

  const confirmed = await client.square.findMany({
    where: { boardId, paymentStatus: "paid" },
    select: { pricePaidCents: true },
  });

  if (confirmed.length === 0) {
    return { inventoryLocked: false, earlyBirdLocked: false, regularLocked: false };
  }

  // Equal prices make the comparison meaningless — lock both rather than guess.
  const ambiguous =
    board.earlyBirdPriceCents != null && board.earlyBirdPriceCents === board.squarePrice;
  if (ambiguous) {
    return { inventoryLocked: true, earlyBirdLocked: true, regularLocked: true };
  }

  let earlyBirdLocked = false;
  let regularLocked = false;
  for (const sq of confirmed) {
    // A Game Day square, or a fundraiser square from before pricePaidCents
    // existed, carries null. Fall back to the board price it must have been.
    const paid = sq.pricePaidCents ?? board.squarePrice;
    if (board.earlyBirdPriceCents != null && paid === board.earlyBirdPriceCents) {
      earlyBirdLocked = true;
    } else if (paid === board.squarePrice) {
      regularLocked = true;
    } else {
      earlyBirdLocked = true;
      regularLocked = true;
    }
  }

  return { inventoryLocked: true, earlyBirdLocked, regularLocked };
}

/** Shown beside a disabled price field. */
export const EARLY_BIRD_LOCK_REASON =
  "Locked because tickets have been bought at the early bird price.";
export const REGULAR_LOCK_REASON =
  "Locked because tickets have been bought at this price.";
export const INVENTORY_LOCK_REASON =
  "The number of tickets is fixed once the first contribution is confirmed — " +
  "ticket numbers are already issued.";
