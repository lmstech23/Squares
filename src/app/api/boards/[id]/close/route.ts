import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { prisma } from "@/lib/prisma";

interface Props {
  params: Promise<{ id: string }>;
}

/**
 * Fisher-Yates shuffle — produces an unbiased permutation of [0-9].
 */
function shuffleArray(): number[] {
  const arr = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export async function POST(request: Request, { params }: Props) {
  try {
    const { id } = await params;

    // 1. Authenticate
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const host = await prisma.host.findUnique({
      where: { supabaseUserId: user.id },
    });

    if (!host) {
      return NextResponse.json({ error: "Host not found" }, { status: 404 });
    }

    // 2. Fetch board + ownership check
    const board = await prisma.board.findUnique({
      where: { boardId: id },
    });

    if (!board || board.hostId !== host.id) {
      return NextResponse.json({ error: "Board not found" }, { status: 404 });
    }

    // 3. Guard: only open boards can be closed
    if (board.status !== "open") {
      return NextResponse.json(
        { error: `Board is already ${board.status}. Cannot close.` },
        { status: 409 }
      );
    }

    // 4. Atomic transition: open → closed with numbers assigned
    //    Single write with optimistic lock on status = "open".
    //    Race condition: two concurrent close requests → only one succeeds.
    const rowNumbers = shuffleArray();
    const colNumbers = shuffleArray();

    // 50/50 coin flip: randomly swap which team is on which axis
    const swapTeams = Math.random() < 0.5;
    const finalTeamRow = swapTeams && board.teamRow && board.teamCol ? board.teamCol : board.teamRow;
    const finalTeamCol = swapTeams && board.teamRow && board.teamCol ? board.teamRow : board.teamCol;

    const { count } = await prisma.board.updateMany({
      where: { boardId: id, status: "open" },
      data: {
        status: "closed",
        rowNumbers,
        colNumbers,
        teamRow: finalTeamRow,
        teamCol: finalTeamCol,
      },
    });

    if (count === 0) {
      return NextResponse.json(
        { error: "Board was already closed by another request." },
        { status: 409 }
      );
    }

    return NextResponse.json({
      status: "closed",
      rowNumbers,
      colNumbers,
    });
  } catch (error) {
    console.error("Close board error:", error);
    return NextResponse.json(
      { error: "Failed to close board." },
      { status: 500 }
    );
  }
}
