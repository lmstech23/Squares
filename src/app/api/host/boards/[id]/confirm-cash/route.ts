// src/app/api/host/boards/[id]/confirm-cash/route.ts
// ============================================================
// HOST: Confirm cash received — "Mark Cash Received"
//
// POST /api/host/boards/[id]/confirm-cash
// Body: { squareId: string }
//
// Transitions: reserved_cash → paid
// Creates PaymentReference for revenue tracking.
// Clears the auto-expire TTL (cash is confirmed, no expiry needed).
//
// SMS: fires after updateMany succeeds. Twilio failure is non-fatal —
// the confirmation is already committed and cannot be rolled back.
// ============================================================

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { confirmSquares } from "@/lib/confirm-square";
import { getHost } from "@/lib/auth";

interface ConfirmCashBody {
  squareId: string;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const host = await getHost();
    if (!host) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id: boardId } = await params;
    const body: ConfirmCashBody = await request.json();
    const { squareId } = body;

    if (!squareId) {
      return NextResponse.json(
        { error: "Square ID is required." },
        { status: 400 }
      );
    }

    const board = await prisma.board.findUnique({
      where: { boardId },
      select: { hostId: true, squarePrice: true, gameName: true, boardType: true },
    });

    if (!board || board.hostId !== host.id) {
      return NextResponse.json({ error: "Board not found." }, { status: 404 });
    }

    // ---- LEDGER PRE-FLIGHT, BEFORE ANYTHING IS FLIPPED --------------------
    //
    // THE BUG THIS FIXES. The ledger write used to sit AFTER confirmSquares,
    // outside its transaction, and skipped entirely when the square already
    // carried a contributionId:
    //
    //     if (sq && !sq.contributionId) { ...create... }
    //
    // A non-null pointer does NOT mean "already recorded". It means a row was
    // once associated with this square. A card attempt that was abandoned and
    // switched to direct payment leaves the square pointing at a `released`
    // stripe row; an A1-backfilled reserved_cash batch leaves it pointing at a
    // `pending` one. In both cases the host confirmed real money, the square
    // went `paid`, and NOTHING entered the ledger - so `raised`, which now
    // reads the ledger, under-reported money the host actually collected.
    //
    // Everything that can refuse is therefore decided HERE, before the square
    // moves. A refusal after the flip is the exact end state being fixed.
    const sq = await prisma.square.findUnique({
      where: { squareId },
      select: {
        boardId: true,
        pricePaidCents: true,
        playerName: true,
        playerEmail: true,
        playerPhone: true,
        contributionId: true,
        contribution: {
          select: {
            id: true,
            boardId: true,
            status: true,
            paymentMethod: true,
            voidedAt: true,
            squareAmountCents: true,
            _count: { select: { squares: true } },
          },
        },
      },
    });

    if (!sq || sq.boardId !== boardId) {
      return NextResponse.json({ error: "Square not found." }, { status: 404 });
    }

    const isFundraiser = board.boardType === "fundraiser";
    const cents = sq.pricePaidCents ?? board.squarePrice;
    const linked = sq.contribution;

    // Does this confirmation still need to write a ledger row?
    let writeLedger = isFundraiser;

    if (isFundraiser && linked) {
      // HARD STOPS — 409, nothing written, square stays reserved_cash.
      // NO SILENT RECONCILIATION: each of these means an assumption has
      // already failed, and confirming on top of it would bury the evidence
      // under money that now looks recorded.
      if (linked.boardId !== boardId) {
        return NextResponse.json(
          { error: "This square is linked to a contribution on another board. Contact support." },
          { status: 409 }
        );
      }

      if (linked.status === "confirmed") {
        // ALREADY RECORDED — but only if the row genuinely records THIS
        // square cash. Anything else is corruption, not idempotency.
        if (linked.voidedAt) {
          return NextResponse.json(
            { error: "This contribution was voided. Confirming it again would resurrect voided money." },
            { status: 409 }
          );
        }
        if (linked.paymentMethod !== "cash") {
          return NextResponse.json(
            { error: "This square is linked to a confirmed card contribution. Contact support." },
            { status: 409 }
          );
        }
        if (linked._count.squares !== 1) {
          return NextResponse.json(
            { error: "This square shares a confirmed contribution with others. Contact support." },
            { status: 409 }
          );
        }
        if (linked.squareAmountCents !== cents) {
          return NextResponse.json(
            { error: "The linked contribution does not match the amount on this square. Contact support." },
            { status: 409 }
          );
        }
        // Exact match: the money is on the books. Flip the square, write
        // nothing.
        writeLedger = false;
      }

      // `pending` and `released` both fall through to DETACH AND CREATE.
      //
      // NOT "transition the pending row to confirmed". That row may be
      // BATCH-LEVEL: one card checkout for three squares is one Contribution
      // with squareAmountCents = 3 x price. Cash confirmation is per square
      // (money doc §4 makes cash batches deliberately non-atomic), so flipping
      // it on the first square would count all three squares of money for one
      // payment and break invariant 53 - squareAmountCents would no longer
      // equal the sum of pricePaidCents over its confirmed squares.
      //
      // NOT "convert the released row to cash" either. It is `stripe` with a
      // real checkoutSessionId and a releasedAt: the TRUE record of an
      // abandoned card attempt. Rewriting it would destroy that provenance,
      // strand a Stripe session id on a cash row (the column is UNIQUE), and
      // leave releasedAt and confirmedAt both set.
      //
      // The old row is left ALONE. checkout.session.expired ->
      // releaseContributionBySession already releases a pending one,
      // conditional on `pending`; racing that here buys nothing.
    }

    // Atomic: only confirm if still reserved_cash. Shared with the Stripe
    // webhook and the cron, so a direct payment mints passes exactly as a card
    // payment does — the failure this prevents is card contributors getting
    // passes and cash contributors not.
    //
    // THE LEDGER ROW IS WRITTEN INSIDE THIS TRANSACTION. It used to be a
    // separate call afterwards, so a crash between them left a paid square
    // with no ledger row - the same divergence by a different route.
    //
    // ONE CONTRIBUTION PER CONFIRMED SQUARE on this path, not one per batch.
    // Per-square keeps invariant 53 literally true.
    const { confirmedSquareIds } = await prisma.$transaction(async (tx) => {
      const res = await confirmSquares(tx, [squareId], "reserved_cash", {
        boardId,
        paymentMethod: "cash",
      });
      if (res.confirmedSquareIds.length === 0 || !writeLedger) return res;

      const contribution = await tx.contribution.create({
        data: {
          boardId,
          status: "confirmed",
          paymentMethod: "cash",
          squareAmountCents: cents,
          donationAmountCents: 0,
          totalPaidCents: cents,
          contributorName: sq.playerName ?? "Unknown",
          contributorEmail: sq.playerEmail,
          contributorPhone: sq.playerPhone,
          confirmedAt: new Date(),
          recordedByHostId: host.id,
          confirmedByHostId: host.id,
        },
      });
      // Repointing IS the detach. The old row keeps its own history and its
      // other squares; this square now belongs to the row that records the
      // cash actually received for it.
      await tx.square.update({
        where: { squareId },
        data: { contributionId: contribution.id },
      });
      return res;
    });

    const count = confirmedSquareIds.length;

    if (count === 0) {
      return NextResponse.json(
        {
          error:
            "Square is not in a cash-reserved state. It may have expired or already been confirmed.",
        },
        { status: 409 }
      );
    }

    // Create PaymentReference for revenue tracking.
    // FOLLOW-UP, not fixed here: `amount` is board.squarePrice rather than the
    // pricePaidCents on the square, so an early-bird cash square records the
    // wrong figure. Nothing reads this column for totals, so it is cosmetic
    // today. PHASE-2-BACKLOG.md.
    await prisma.paymentReference.create({
      data: {
        squareId,
        stripeSessionId: null,
        amount: board.squarePrice,
        method: "cash",
      },
    });

    // --- Confirmation email: deliberately NOT sent here ---
    //
    // Direct payments resolve one square at a time (money doc §4), so a host
    // marking three squares received produces three confirmation events. A
    // send from this handler would be three emails for one purchase, which is
    // the bug this replaces.
    //
    // The five-minute cron sweeps unmailed confirmations instead, coalescing
    // rapid clicks into one email per contributor. A contributor who paid by
    // Zelle days ago is not waiting on a receipt to the minute, and the delay
    // buys correctness for the common case. Addendum §5.

    return NextResponse.json({ success: true, squareId });
  } catch (error) {
    console.error("Confirm cash error:", error);
    return NextResponse.json(
      { error: "Something went wrong. Please try again." },
      { status: 500 }
    );
  }
}
