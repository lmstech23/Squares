// ============================================================
// HOST: edit board title, and on Game Day the two axis labels.
//
// TWO BOARD TYPES, ONE ROUTE. A fundraiser has no teams - teamCol and teamRow
// are null by design - so it sends `{ gameName }` alone. Game Day still sends
// and still requires all three, unchanged.
//
// TITLE HISTORY - fundraiser-board-v2.md §11. "Title is special. On a
// fundraiser the title IS the cause. It stays editable — real corrections
// happen — but after the first confirmed contribution every change writes to
// `titleHistory` and displays in the public audit. No alarm, no confirmation
// modal. Just a record."
//
// The same section is explicit that this NARROWS fundraiser behaviour only:
// "That reasoning still holds for Game Day and is unchanged there." So a Game
// Day title edit writes no history, at any status.
// ============================================================

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { prisma } from "@/lib/prisma";
import { hasConfirmedContribution } from "@/lib/board-lock";

interface Props {
  params: Promise<{ id: string }>;
}

const MAX_GAME_NAME = 100;
const MAX_TEAM_NAME = 50;

type DetailsBody = {
  gameName: string;
  /// Game Day only. A fundraiser omits both.
  teamCol?: string;
  teamRow?: string;
};

/**
 * One entry appended to `Board.titleHistory` (JSONB, nullable, previously
 * written by nothing and read by nothing).
 *
 * SHAPE DEFINED HERE because it did not exist. `from` is what the title was,
 * so the record is readable without replaying every earlier entry.
 */
interface TitleChange {
  from: string;
  to: string;
  at: string;
}

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
      select: { boardId: true, hostId: true, boardType: true, gameName: true },
    });

    if (!board || board.hostId !== host.id) {
      return NextResponse.json({ error: "Board not found" }, { status: 404 });
    }

    // 3. Parse + validate
    //
    // A FUNDRAISER SENDS gameName ALONE. The three-field requirement below was
    // unconditional, so `{ gameName }` came back 400 - which is why the
    // fundraiser edit dialog could never save: its Save button was gated on
    // team fields that are null on that board type by design.
    const body: DetailsBody = await request.json();
    const isFundraiser = board.boardType === "fundraiser";

    if (typeof body.gameName !== "string") {
      return NextResponse.json(
        { error: "gameName is required." },
        { status: 400 }
      );
    }

    const gameName = body.gameName.trim();
    if (gameName.length === 0) {
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

    // GAME DAY IS UNCHANGED: same requirement, same messages, same statuses.
    let teamCol = "";
    let teamRow = "";
    if (!isFundraiser) {
      if (typeof body.teamCol !== "string" || typeof body.teamRow !== "string") {
        return NextResponse.json(
          { error: "gameName, teamCol, and teamRow are all required." },
          { status: 400 }
        );
      }
      teamCol = body.teamCol.trim();
      teamRow = body.teamRow.trim();
      if (teamCol.length === 0 || teamRow.length === 0) {
        return NextResponse.json(
          { error: "All fields are required and cannot be empty." },
          { status: 400 }
        );
      }
      if (teamCol.length > MAX_TEAM_NAME || teamRow.length > MAX_TEAM_NAME) {
        return NextResponse.json(
          { error: `Team names must be ${MAX_TEAM_NAME} characters or fewer.` },
          { status: 400 }
        );
      }
    }

    // 4. Title history — v2 §11.
    //
    // Only on a fundraiser, only when the title actually changed, and only once
    // money has arrived. Before the first confirmed contribution a title edit is
    // a correction nobody has relied on; after it, the title is the cause people
    // gave to, and a silent change is the thing the section exists to prevent.
    const titleChanged = gameName !== board.gameName;
    const writeHistory =
      isFundraiser && titleChanged && (await hasConfirmedContribution(board.boardId));

    // 5. Update
    const updated = await prisma.$transaction(async (tx) => {
      if (writeHistory) {
        const entry: TitleChange[] = [
          { from: board.gameName, to: gameName, at: new Date().toISOString() },
        ];
        // ONE STATEMENT, APPENDING IN THE DATABASE. Reading the array into
        // JavaScript and writing it back would lose an entry to any concurrent
        // edit; `||` on jsonb appends to whatever the row holds at write time.
        // COALESCE covers the null the column starts as - every board in
        // production currently has NULL here, so the first append is the case
        // that has to work.
        await tx.$executeRaw`
          UPDATE boards
          SET game_name = ${gameName},
              title_history = COALESCE(title_history, '[]'::jsonb) || ${JSON.stringify(entry)}::jsonb
          WHERE board_id = ${id}::uuid
        `;
      } else if (isFundraiser) {
        // NEVER teamCol/teamRow on a fundraiser: they are null by design and
        // writing "" would replace a meaningful null with a meaningless empty
        // string on a board that has no axes.
        await tx.board.update({ where: { boardId: id }, data: { gameName } });
      } else {
        await tx.board.update({
          where: { boardId: id },
          data: { gameName, teamCol, teamRow },
        });
      }
      return tx.board.findUniqueOrThrow({
        where: { boardId: id },
        select: {
          boardId: true,
          gameName: true,
          teamCol: true,
          teamRow: true,
        },
      });
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