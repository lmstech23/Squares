import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireBoardAccess } from "@/lib/board-access";

// ============================================================
// DISMISS BOARD — Addendum K
//
// PATCH /api/boards/[id]/dismiss
//
// Sets hiddenFromHost = true. Non-destructive soft delete.
// Only allowed for expired and pending_payment boards.
// Open and closed boards return 403 — always.
// ============================================================

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const board = await prisma.board.findUnique({
    where: { boardId: id },
    select: { boardId: true, hostId: true, status: true },
  });

  const access = await requireBoardAccess(id, "board.dismiss");
    if (!access.ok) {
      return NextResponse.json({ error: access.error }, { status: access.status });
    }
    if (!board) {
      return NextResponse.json({ error: "Board not found." }, { status: 404 });
    }

  if (board.status !== "expired" && board.status !== "pending_payment") {
    return NextResponse.json(
      { error: "Only expired or pending boards can be dismissed." },
      { status: 403 }
    );
  }

  await prisma.board.update({
    where: { boardId: id },
    data: { hiddenFromHost: true },
  });

  return NextResponse.json({ success: true });
}
