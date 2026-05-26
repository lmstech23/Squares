import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { prisma } from "@/lib/prisma";

interface Props {
  params: Promise<{ id: string }>;
}

type ScoresBody = {
  scoresTeamA: number[]; // col team scores per period
  scoresTeamB: number[]; // row team scores per period
};

export async function POST(request: Request, { params }: Props) {
  try {
    const { id } = await params;

    // 1. Auth
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

    // 2. Board + ownership
    const board = await prisma.board.findUnique({
      where: { boardId: id },
    });

    if (!board || board.hostId !== host.id) {
      return NextResponse.json({ error: "Board not found" }, { status: 404 });
    }

    // 3. Must be closed (numbers assigned)
    if (board.status !== "closed") {
      return NextResponse.json(
        { error: "Board must be closed with numbers assigned before entering scores." },
        { status: 409 }
      );
    }

    // 3b. Belt-and-suspenders: numbers must actually exist (varies by gridType)
    if (board.gridType === "double") {
      const rowPairs = board.rowPairs as number[][] | null;
      const colPairs = board.colPairs as number[][] | null;
      if (
        !rowPairs ||
        !colPairs ||
        rowPairs.length !== 5 ||
        colPairs.length !== 5
      ) {
        return NextResponse.json(
          { error: "Board numbers have not been assigned yet." },
          { status: 409 }
        );
      }
    } else {
      if (
        !board.rowNumbers ||
        !board.colNumbers ||
        board.rowNumbers.length !== 10 ||
        board.colNumbers.length !== 10
      ) {
        return NextResponse.json(
          { error: "Board numbers have not been assigned yet." },
          { status: 409 }
        );
      }
    }

    // 4. Parse + validate — arrays must match periodLabels length
    const body: ScoresBody = await request.json();

    if (!Array.isArray(body.scoresTeamA) || !Array.isArray(body.scoresTeamB)) {
      return NextResponse.json(
        { error: "scoresTeamA and scoresTeamB must be arrays." },
        { status: 400 }
      );
    }

    const n = board.periodLabels.length;

    if (body.scoresTeamA.length !== n || body.scoresTeamB.length !== n) {
      return NextResponse.json(
        { error: `Scores arrays must match periodLabels length (${n}).` },
        { status: 400 }
      );
    }

    for (let i = 0; i < n; i++) {
      const a = body.scoresTeamA[i];
      const b = body.scoresTeamB[i];

      if (!Number.isInteger(a) || a < -1 || !Number.isInteger(b) || b < -1) {
        return NextResponse.json(
          { error: `Invalid score at index ${i}. Scores must be integers (-1 = not entered).` },
          { status: 400 }
        );
      }
    }
    
    // 5. Save
    const updated = await prisma.board.update({
      where: { boardId: id },
      data: {
        scoresTeamA: body.scoresTeamA,
        scoresTeamB: body.scoresTeamB,
      },
      select: { scoresTeamA: true, scoresTeamB: true, periodLabels: true },
    });

    return NextResponse.json(updated);
  } catch (error) {
    console.error("Score update error:", error);
    return NextResponse.json(
      { error: "Failed to update scores." },
      { status: 500 }
    );
  }
}
