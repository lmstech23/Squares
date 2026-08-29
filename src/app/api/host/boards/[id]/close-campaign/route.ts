import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getHost } from "@/lib/auth";
import { closeBoard } from "@/lib/close-board";

// ============================================================
// HOST: Close a fundraiser campaign early — money doc §7
//
// POST /api/host/boards/[id]/close-campaign
//
// Separate from /api/boards/[id]/close, which is the Game Day close and
// randomizes axis digits. A fundraiser has no digits to randomize and this
// must never reach that code.
//
// Early close requires resolving outstanding direct payments INSIDE the flow.
// They are reported, not auto-released — releasing someone's reservation
// because the host clicked Close would throw away money she may be about to
// collect. A scheduled close is different and releases them at the cutoff.
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
      select: { hostId: true, boardType: true },
    });

    if (!board || board.hostId !== host.id) {
      return NextResponse.json({ error: "Board not found." }, { status: 404 });
    }
    if (board.boardType !== "fundraiser") {
      return NextResponse.json(
        { error: "This is not a fundraiser board." },
        { status: 400 }
      );
    }

    const outcome = await closeBoard(boardId, { hostInitiated: true });

    if (!outcome.ok) {
      return NextResponse.json(
        { error: "This campaign cannot be closed right now." },
        { status: 409 }
      );
    }

    if (outcome.status === "closing") {
      const { pending, awaiting } = outcome.blockedBy;
      const parts: string[] = [];
      if (awaiting > 0) {
        parts.push(
          `${awaiting} ${awaiting === 1 ? "square is" : "squares are"} awaiting payment`
        );
      }
      if (pending > 0) {
        parts.push(
          `${pending} ${pending === 1 ? "checkout is" : "checkouts are"} still resolving`
        );
      }

      return NextResponse.json(
        {
          error:
            `Campaign is closed to new contributions, but ${parts.join(" and ")}. ` +
            `Mark each as received or release it, then close again to finalize.`,
          status: "closing",
          blockedBy: outcome.blockedBy,
        },
        { status: 409 }
      );
    }

    return NextResponse.json({
      ok: true,
      status: "closed",
      finalRaisedCents: outcome.finalRaisedCents,
      alreadyFinal: outcome.alreadyFinal,
    });
  } catch (error) {
    console.error("Close campaign error:", error);
    return NextResponse.json(
      { error: "Something went wrong. Please try again." },
      { status: 500 }
    );
  }
}
