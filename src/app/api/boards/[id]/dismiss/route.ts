import { NextResponse } from "next/server";
import { getHost } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

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
  const host = await getHost();
  if (!host) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  const board = await prisma.board.findUnique({
    where: { boardId: id },
    select: { boardId: true, hostId: true, status: true },
  });

  if (!board || board.hostId !== host.id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
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
