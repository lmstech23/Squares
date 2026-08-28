import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getHost } from "@/lib/auth";
import { resolveHoldBatch } from "@/lib/checkout-holds";

// ============================================================
// HOST: Manually resolve one expired checkout hold
//
// POST /api/host/boards/[id]/resolve-hold
// Body: { batchId: string }
//
// This is NOT a release endpoint. It runs the same resolution sequence the
// cron runs (invariant 18): query the Stripe session, confirm the batch if it
// paid, otherwise expire the session and only then release.
//
// The host cannot skip that. Invariant 19 allows manual release only after the
// hold has passed and only through this sequence, and the server enforces both
// rather than trusting the UI to hide the control.
// ============================================================

interface Body {
  batchId: string;
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
    const { batchId } = (await request.json()) as Body;

    if (!batchId) {
      return NextResponse.json({ error: "Batch ID is required." }, { status: 400 });
    }

    const board = await prisma.board.findUnique({
      where: { boardId },
      select: { hostId: true },
    });

    if (!board || board.hostId !== host.id) {
      return NextResponse.json({ error: "Board not found." }, { status: 404 });
    }

    // The batch must belong to this board. Without this check a host could
    // resolve a hold on someone else's board by guessing an id.
    const owned = await prisma.square.count({
      where: { batchId, boardId },
    });
    if (owned === 0) {
      return NextResponse.json({ error: "Batch not found." }, { status: 404 });
    }

    const outcome = await resolveHoldBatch(batchId);

    if (outcome.notYetExpired) {
      return NextResponse.json(
        {
          error:
            "This checkout is still live. You can release it once the hold runs out.",
        },
        { status: 409 }
      );
    }

    if (outcome.error) {
      return NextResponse.json(
        { error: "Could not reach Stripe. Try again in a moment." },
        { status: 502 }
      );
    }

    return NextResponse.json({
      ok: true,
      // Payment wins: a batch that turns out to have paid is confirmed, not
      // released, however the host got here.
      confirmed: outcome.confirmed,
      released: outcome.released,
    });
  } catch (error) {
    console.error("Resolve hold error:", error);
    return NextResponse.json(
      { error: "Something went wrong. Please try again." },
      { status: 500 }
    );
  }
}
