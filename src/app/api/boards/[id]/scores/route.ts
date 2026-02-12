import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { prisma } from "@/lib/prisma";

interface Props {
  params: Promise<{ id: string }>;
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

    // 3. Board must be closed (numbers assigned)
    if (board.status !== "closed") {
      return NextResponse.json(
        { error: "Board must be closed with numbers assigned before entering scores." },
        { status: 409 }
      );
    }

    // 3b. Data-based guard: numbers must actually exist (defense against partial state)
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

    // 4. Parse + validate scores — only allow known quarter keys
    const body = await request.json();
    const quarters = ["q1", "q2", "q3", "final"] as const;
    type Quarter = (typeof quarters)[number];

    const validatedScores: Partial<Record<Quarter, { col: number; row: number }>> = {};

    for (const q of quarters) {
      const score = body[q];
      if (score !== undefined) {
        if (
          typeof score.col !== "number" ||
          typeof score.row !== "number" ||
          score.col < 0 ||
          score.row < 0 ||
          !Number.isInteger(score.col) ||
          !Number.isInteger(score.row)
        ) {
          return NextResponse.json(
            { error: `Invalid score for ${q}. Scores must be non-negative integers.` },
            { status: 400 }
          );
        }
        validatedScores[q] = { col: score.col, row: score.row };
      }
    }

    if (Object.keys(validatedScores).length === 0) {
      return NextResponse.json(
        { error: "No valid quarter scores provided." },
        { status: 400 }
      );
    }

    // 5. Merge with existing scores (partial updates allowed)
    const existingScores = (board.scores as Record<string, unknown>) ?? {};
    const mergedScores = { ...existingScores, ...validatedScores };

    // 6. Save
    await prisma.board.update({
      where: { boardId: id },
      data: { scores: mergedScores },
    });

    return NextResponse.json({ scores: mergedScores });
  } catch (error) {
    console.error("Score update error:", error);
    return NextResponse.json(
      { error: "Failed to update scores." },
      { status: 500 }
    );
  }
}
