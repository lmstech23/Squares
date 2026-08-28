import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getHost } from "@/lib/auth";
import { backfillPasses } from "@/lib/confirm-square";

// ============================================================
// HOST: Mint passes owed to supporters on already-confirmed squares
//
// POST /api/host/boards/[id]/backfill-passes
//
// A square confirmed before minting existed is paid, carries a grant, and has
// no pass — and confirmation never runs again for it. This closes that gap.
//
// A no-op when A8 ships before the first contribution, which is exactly why
// it ships first. Idempotent: it mints the difference between what a supporter
// is owed and what they hold, so running it twice mints nothing the second
// time.
// ============================================================

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

    const board = await prisma.board.findUnique({
      where: { boardId },
      select: { hostId: true, event: { select: { id: true } } },
    });

    if (!board || board.hostId !== host.id) {
      return NextResponse.json({ error: "Board not found." }, { status: 404 });
    }

    if (!board.event) {
      return NextResponse.json(
        { error: "This board has no event, so there are no passes." },
        { status: 400 }
      );
    }

    // One transaction: the row locks minting takes must be held across the
    // whole run, or two concurrent invocations could both see the same
    // shortfall.
    const result = await prisma.$transaction((tx) =>
      backfillPasses(tx, board.event!.id)
    );

    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    console.error("Backfill passes error:", error);
    return NextResponse.json(
      { error: "Something went wrong. Please try again." },
      { status: 500 }
    );
  }
}
