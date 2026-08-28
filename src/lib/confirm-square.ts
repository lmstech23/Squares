import { randomBytes } from "crypto";
import type { Prisma } from "@prisma/client";

// Confirmation — fundraiser-admission-addendum.md v2.0 §5.
//
// ONE shared implementation, called by every path that flips a square to
// `paid`: the Stripe webhook, the host's confirm-cash route, and the cron's
// confirm branch. Three copies would be three chances to drift, and the one
// that drifts is whichever gets tested least — the quiet failure is card
// contributors getting passes and cash contributors not, discovered at a gate
// with a line of people waiting.
//
//   square → paid
//   supporter → active (if not already)
//   mint 1 pass per confirmed square, unless the grant donates admissions
//
// Drawing eligibility is NOT a write. It is a derived property of the square
// reaching `paid` (money doc §5), and on a Phase A no-prize board no ticket
// exists at all.

/** Opaque, unguessable, and never a URL — the QR payload. Addendum §6B. */
function newPassToken(): string {
  return randomBytes(24).toString("base64url");
}

export interface ConfirmResult {
  /** Squares this call actually flipped. Excludes ones already paid. */
  confirmedSquareIds: string[];
  passesMinted: number;
}

/**
 * Flip squares to `paid` and mint their admission passes, in one transaction.
 *
 * `expect` is the state the caller believes the squares are in — `pending` for
 * a card checkout, `reserved_cash` for a direct payment the host is marking
 * received. Only squares actually in that state are confirmed, so a replayed
 * webhook or a double-tapped confirm button flips nothing and mints nothing.
 *
 * The caller decides what an empty result means: the webhook treats it as a
 * state mismatch worth logging, the host route as a 409.
 */
export async function confirmSquares(
  tx: Prisma.TransactionClient,
  squareIds: string[],
  expect: "pending" | "reserved_cash",
  extraWhere: Prisma.SquareWhereInput = {}
): Promise<ConfirmResult> {
  if (squareIds.length === 0) {
    return { confirmedSquareIds: [], passesMinted: 0 };
  }

  // updateManyAndReturn is what makes this idempotent: it reports exactly the
  // rows this statement changed. Selecting first and updating second would
  // leave a window where two concurrent confirmations both believe they won
  // and both mint.
  const confirmed = await tx.square.updateManyAndReturn({
    where: {
      squareId: { in: squareIds },
      paymentStatus: expect,
      ...extraWhere,
    },
    data: {
      paymentStatus: "paid",
      checkoutExpiresAt: null,
      holdExpiresAt: null,
      releaseReason: null,
    },
    select: { squareId: true, boardId: true, batchId: true },
  });

  if (confirmed.length === 0) {
    return { confirmedSquareIds: [], passesMinted: 0 };
  }

  const confirmedSquareIds = confirmed.map((sq) => sq.squareId);

  // Admission only exists on a board with an event.
  const board = await tx.board.findUnique({
    where: { boardId: confirmed[0].boardId },
    select: { event: { select: { id: true } } },
  });

  if (!board?.event) {
    return { confirmedSquareIds, passesMinted: 0 };
  }

  let passesMinted = 0;

  // Group by batch: the grant, and therefore the donate flag, is per purchase.
  const byBatch = new Map<string, string[]>();
  for (const sq of confirmed) {
    if (!sq.batchId) continue;
    byBatch.set(sq.batchId, [...(byBatch.get(sq.batchId) ?? []), sq.squareId]);
  }

  for (const [batchId, ids] of byBatch) {
    const grant = await tx.admissionGrant.findUnique({
      where: { squareBatchId: batchId },
      select: { eventSupporterId: true, donateAdmissions: true },
    });

    // No grant means the board gained its event after this claim was made.
    // Nothing to mint against, and inventing a supporter here would attribute
    // passes to a purchase that never agreed to them.
    if (!grant) continue;

    // The purchaser said they are not attending. The square still funds the
    // cause; it just admits nobody. Addendum §1.
    if (grant.donateAdmissions) continue;

    passesMinted += await mintPasses(tx, grant.eventSupporterId, ids);
  }

  return { confirmedSquareIds, passesMinted };
}

/**
 * Mint one pass per square for a supporter, and activate them if needed.
 *
 * Concurrency-safe at the database level, not by status check — two squares in
 * one reserved batch can be confirmed concurrently by a host double-tapping,
 * and application-level status checking does not prevent the double-mint. This
 * is the class of bug that passes every test on a developer machine and fires
 * once, at a tailgate.
 *
 * Two guarantees, both required:
 *
 *  1. `SELECT ... FOR UPDATE` on the supporter row. Sequence numbers are drawn
 *     from `passSequenceCursor` under that lock, so concurrent minters
 *     serialize rather than reading the same cursor value.
 *  2. The unique `(eventSupporterId, sequenceNumber)` constraint behind it. If
 *     the lock is ever circumvented, a double-mint collides and rolls back
 *     with its square, retryable — rather than silently issuing twice.
 */
export async function mintPasses(
  tx: Prisma.TransactionClient,
  supporterId: string,
  squareIds: string[]
): Promise<number> {
  // Row lock. Everything below runs while this transaction holds it.
  const locked = await tx.$queryRaw<
    { pass_sequence_cursor: number; status: string }[]
  >`SELECT pass_sequence_cursor, status
      FROM event_supporters
     WHERE id = ${supporterId}::uuid
       FOR UPDATE`;

  if (locked.length === 0) return 0;

  const cursor = locked[0].pass_sequence_cursor;

  // Compare-and-swap. Only the transaction that flips pending -> active does
  // the activation work; the status is a one-way latch and never returns.
  await tx.eventSupporter.updateMany({
    where: { id: supporterId, status: "pending" },
    data: { status: "active", activatedAt: new Date() },
  });

  await tx.admissionPass.createMany({
    data: squareIds.map((squareId, i) => ({
      eventSupporterId: supporterId,
      squareId,
      // Monotonic and never reused. A voided pass keeps its number so a
      // screenshot shared last week can never become valid again.
      sequenceNumber: cursor + i + 1,
      token: newPassToken(),
    })),
  });

  // Advance the cursor by exactly what was minted. Never decremented, never
  // reset — addendum §3.
  await tx.eventSupporter.update({
    where: { id: supporterId },
    data: { passSequenceCursor: cursor + squareIds.length },
  });

  return squareIds.length;
}

/**
 * Turn a grant's donate flag on or off after the fact — addendum §6.
 *
 * A host action from the event panel, for the supporter who decides to come
 * after all or the one who cannot.
 *
 * Toggling ON voids that grant's active passes. Toggling OFF mints new ones at
 * the NEXT cursor values with new tokens — never the old numbers. `void` is
 * terminal: a screenshot shared into a group chat last week must not become a
 * working credential again because someone changed their mind twice.
 *
 * A `used` pass is never voidable. If three people already walked in, that
 * grant cannot be retroactively donated, and the request is rejected rather
 * than partially applied.
 */
export async function setDonateFlag(
  tx: Prisma.TransactionClient,
  grantId: string,
  donate: boolean
): Promise<
  | { ok: true; voided: number; minted: number }
  | { ok: false; reason: "not_found" | "used_passes"; usedCount?: number }
> {
  const grant = await tx.admissionGrant.findUnique({
    where: { id: grantId },
    select: {
      id: true,
      eventSupporterId: true,
      squareBatchId: true,
      donateAdmissions: true,
    },
  });

  if (!grant || !grant.squareBatchId) return { ok: false, reason: "not_found" };

  // The confirmed squares this grant paid for — one pass each.
  const squares = await tx.square.findMany({
    where: { batchId: grant.squareBatchId, paymentStatus: "paid" },
    select: { squareId: true },
  });

  if (donate) {
    // Only this grant's passes, identified by the squares it paid for. A
    // supporter may hold passes from another purchase that must not be touched.
    const squareIds = squares.map((s) => s.squareId);

    const used = await tx.admissionPass.count({
      where: { squareId: { in: squareIds }, status: "used" },
    });

    if (used > 0) {
      return { ok: false, reason: "used_passes", usedCount: used };
    }

    const voided = await tx.admissionPass.updateMany({
      where: { squareId: { in: squareIds }, status: "active" },
      data: { status: "void" },
    });

    await tx.admissionGrant.update({
      where: { id: grant.id },
      data: { donateAdmissions: true },
    });

    return { ok: true, voided: voided.count, minted: 0 };
  }

  // Toggling back on. Mint for squares that have no live pass — a grant
  // toggled twice must not accumulate duplicates.
  const live = await tx.admissionPass.findMany({
    where: {
      squareId: { in: squares.map((s) => s.squareId) },
      status: { in: ["active", "used"] },
    },
    select: { squareId: true },
  });
  const covered = new Set(live.map((p) => p.squareId));
  const needing = squares.filter((s) => !covered.has(s.squareId));

  const minted = needing.length
    ? await mintPasses(
        tx,
        grant.eventSupporterId,
        needing.map((s) => s.squareId)
      )
    : 0;

  await tx.admissionGrant.update({
    where: { id: grant.id },
    data: { donateAdmissions: false },
  });

  return { ok: true, voided: 0, minted };
}

/**
 * Mint the passes a supporter should already have but does not.
 *
 * A square confirmed before minting existed is `paid`, carries a grant, and
 * has no pass — and confirmation never runs again for it. This closes that
 * gap by comparing what each supporter is owed against what they hold.
 *
 * Owed = confirmed squares on non-donated grants.
 * Held = `active` + `used` passes. Voided passes are excluded deliberately:
 * they were given up on purpose and must not be resurrected.
 *
 * A no-op when A8 ships before the first contribution, which is the reason to
 * ship it first. Safe to run repeatedly.
 */
export async function backfillPasses(
  prisma: Prisma.TransactionClient,
  eventId: string
): Promise<{ supporters: number; minted: number }> {
  const supporters = await prisma.eventSupporter.findMany({
    where: { eventId },
    select: {
      id: true,
      grants: { select: { squareBatchId: true, donateAdmissions: true } },
      passes: { select: { status: true } },
    },
  });

  let touched = 0;
  let minted = 0;

  for (const supporter of supporters) {
    const liveBatches = supporter.grants
      .filter((g) => !g.donateAdmissions && g.squareBatchId)
      .map((g) => g.squareBatchId!);

    if (liveBatches.length === 0) continue;

    const owedSquares = await prisma.square.findMany({
      where: { batchId: { in: liveBatches }, paymentStatus: "paid" },
      select: { squareId: true },
    });

    const held = supporter.passes.filter(
      (p) => p.status === "active" || p.status === "used"
    ).length;

    const shortfall = owedSquares.length - held;
    if (shortfall <= 0) continue;

    // Mint against the squares that have no pass yet, so squareId stays
    // meaningful for audit rather than pointing at an arbitrary square.
    const withPasses = new Set(
      (
        await prisma.admissionPass.findMany({
          where: { eventSupporterId: supporter.id, squareId: { not: null } },
          select: { squareId: true },
        })
      ).map((p) => p.squareId!)
    );

    const unbacked = owedSquares
      .map((sq) => sq.squareId)
      .filter((id) => !withPasses.has(id))
      .slice(0, shortfall);

    if (unbacked.length === 0) continue;

    minted += await mintPasses(prisma, supporter.id, unbacked);
    touched++;
  }

  return { supporters: touched, minted };
}
