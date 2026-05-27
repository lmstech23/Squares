import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { prisma } from "@/lib/prisma";

interface Props {
  params: Promise<{ id: string }>;
}

const MAX_GAME_NAME = 100;
const MAX_TEAM_NAME = 50;

type DetailsBody = {
  gameName: string;
  teamCol: string;
  teamRow: string;
};

export async function PATCH(request: Request, { params }: Props) {
  try {
    const { id } = await params;

    // 1. Auth — same pattern as scores route
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
      select: { boardId: true, hostId: true },
    });

    if (!board || board.hostId !== host.id) {
      return NextResponse.json({ error: "Board not found" }, { status: 404 });
    }

    // 3. Parse + validate — all three fields required
    const body: DetailsBody = await request.json();

    if (
      typeof body.gameName !== "string" ||
      typeof body.teamCol !== "string" ||
      typeof body.teamRow !== "string"
    ) {
      return NextResponse.json(
        { error: "gameName, teamCol, and teamRow are all required." },
        { status: 400 }
      );
    }

    const gameName = body.gameName.trim();
    const teamCol = body.teamCol.trim();
    const teamRow = body.teamRow.trim();

    if (gameName.length === 0 || teamCol.length === 0 || teamRow.length === 0) {
      return NextResponse.json(
        { error: "All fields are required and cannot be empty." },
        { status: 400 }
      );
    }

    if (gameName.length > MAX_GAME_NAME) {
      return NextResponse.json(
        { error: `Game name must be ${MAX_GAME_NAME} characters or fewer.` },
        { status: 400 }
      );
    }

    if (teamCol.length > MAX_TEAM_NAME || teamRow.length > MAX_TEAM_NAME) {
      return NextResponse.json(
        { error: `Team names must be ${MAX_TEAM_NAME} characters or fewer.` },
        { status: 400 }
      );
    }

    // 4. Update
    const updated = await prisma.board.update({
      where: { boardId: id },
      data: { gameName, teamCol, teamRow },
      select: {
        boardId: true,
        gameName: true,
        teamCol: true,
        teamRow: true,
      },
    });

    return NextResponse.json(updated);
  } catch (error) {
    console.error("Board details update error:", error);
    return NextResponse.json(
      { error: "Failed to update board details." },
      { status: 500 }
    );
  }
}