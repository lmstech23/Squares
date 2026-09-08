// src/app/api/host/boards/[id]/signup-slots/route.ts
// ============================================================
// HOST: list and create sign-up slots.
//
// GET   slots with live fill state
// POST  create a SHIFT or an ITEM
//
// NO DELETE, here or anywhere in S2. Ruling 2 — create, edit, reorder and
// sheet open/close only. The S1 foreign keys are Restrict and SignupLog is
// append-only; deletion would need its own ruling and its own migration.
// ============================================================

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authorizeBoardEvent } from "@/lib/host-auth";
import { validateSlotInput, slotFillState, type SlotInput } from "@/lib/signups";
import { parseZoned } from "@/lib/zoned-time";

interface Props {
  params: Promise<{ id: string }>;
}

/** Resolve the sheet for this board, or the 404 the caller should return. */
async function sheetFor(boardId: string) {
  const auth = await authorizeBoardEvent(boardId);
  if ("error" in auth) return { error: auth.error, status: auth.status };

  const sheet = await prisma.signupSheet.findUnique({
    where: { eventId: auth.eventId },
    select: { id: true },
  });
  if (!sheet) return { error: "This event has no sign-up sheet yet.", status: 404 };

  // THE ZONE THE HOST'S WALL CLOCK IS READ IN. `Board.timezone` is the
  // authority - one zone per board, covering early bird, close, draw and the
  // event. It is NULLABLE, though, and `Event.timezone` is not, so the event's
  // is the fallback rather than a second opinion: the two are written together
  // and no board in production has ever had them disagree (checked 2026-09-08,
  // 10 board/event pairs, zero divergent). Falling back to a guaranteed value
  // is what stops a null zone becoming an unparseable time.
  const board = await prisma.board.findUniqueOrThrow({
    where: { boardId: auth.boardId },
    select: { timezone: true, event: { select: { timezone: true } } },
  });
  const timeZone = board.timezone ?? board.event?.timezone;
  if (!timeZone) {
    // Unreachable: authorizeBoardEvent already refused a board with no event,
    // and Event.timezone is NOT NULL. Stated rather than asserted with `!` so
    // a schema change that makes it nullable fails here with a sentence.
    return { error: "This board has no timezone set.", status: 400 };
  }
  return { sheetId: sheet.id, timeZone };
}

export async function GET(_request: Request, { params }: Props) {
  try {
    const { id } = await params;
    const s = await sheetFor(id);
    if ("error" in s) return NextResponse.json({ error: s.error }, { status: s.status });

    const slots = await prisma.signupSlot.findMany({
      where: { sheetId: s.sheetId },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      select: {
        id: true, slotType: true, name: true, startsAt: true, endsAt: true,
        capacity: true, unitLabel: true, notes: true, sortOrder: true,
        // Fill is a LIVE COUNT of position rows. There is no filledCount column
        // to drift, which is the same decision that keeps quantity off
        // HelperSignup.
        _count: { select: { positions: true } },
      },
    });

    return NextResponse.json({
      slots: slots.map((sl) => ({
        ...sl,
        _count: undefined,
        fill: slotFillState(sl.capacity, sl._count.positions),
      })),
    });
  } catch (error) {
    console.error("signup-slots GET error:", error);
    return NextResponse.json({ error: "Something went wrong." }, { status: 500 });
  }
}

type PostBody = {
  slotType?: string;
  name?: string;
  capacity?: number;
  startsAt?: string | null;
  endsAt?: string | null;
  unitLabel?: string | null;
  notes?: string | null;
};

export async function POST(request: Request, { params }: Props) {
  try {
    const { id } = await params;
    const s = await sheetFor(id);
    if ("error" in s) return NextResponse.json({ error: s.error }, { status: s.status });

    const body = (await request.json()) as PostBody;

    if (body.slotType !== "SHIFT" && body.slotType !== "ITEM") {
      return NextResponse.json({ error: "Choose a shift or an item." }, { status: 400 });
    }

    const input: SlotInput = {
      slotType: body.slotType,
      name: body.name ?? "",
      capacity: body.capacity ?? 0,
      // ZONED, NOT `new Date`. `new Date("2026-10-24T15:00")` on a bare
      // datetime-local string reads the wall clock as the RUNTIME's zone, which
      // on Vercel is UTC - so 3:00 PM typed by a host in New York was stored as
      // 3:00 PM UTC and shown back to volunteers as 11:00 AM. Four production
      // shifts were written that way before this was found.
      //
      // AMBIGUITY, PER CALL SITE. On the fall-back night 1:30 AM happens twice.
      // A shift takes the EARLIER start and the LATER end, which is the only
      // pairing that cannot open a hole in coverage: any other choice silently
      // shortens the shift on the one night of the year with an extra hour to
      // staff. This differs from the event dates in fundraiser-details, which
      // are deadlines and reason the other way round; that is why the parameter
      // exists rather than a default.
      startsAt: parseZoned(body.startsAt, s.timeZone, "earlier"),
      endsAt: parseZoned(body.endsAt, s.timeZone, "later"),
      unitLabel: body.unitLabel?.trim() || null,
      notes: body.notes?.trim() || null,
    };

    // parseZoned returns null on malformed input rather than an Invalid Date,
    // so a value that WAS sent and did not parse would otherwise look exactly
    // like "not sent" and reach validateSlotInput as a missing start time. The
    // check is on the raw body for that reason, not on the parsed value.
    if (body.startsAt && !input.startsAt)
      return NextResponse.json({ error: "Unrecognized start time." }, { status: 400 });
    if (body.endsAt && !input.endsAt)
      return NextResponse.json({ error: "Unrecognized end time." }, { status: 400 });

    // Mirrors the six S1 CHECK constraints. The database is the backstop, not
    // the only guard — a constraint violation reaching the host as a 500 with a
    // Postgres constraint name in it is a failure of this layer.
    const valid = validateSlotInput(input);
    if (!valid.ok) {
      return NextResponse.json({ error: valid.message, field: valid.field }, { status: 400 });
    }

    // New slots go last. sortOrder is rewritten wholesale by the reorder route,
    // so this only has to avoid colliding at the top.
    const last = await prisma.signupSlot.findFirst({
      where: { sheetId: s.sheetId },
      orderBy: { sortOrder: "desc" },
      select: { sortOrder: true },
    });

    const slot = await prisma.signupSlot.create({
      data: {
        sheetId: s.sheetId,
        slotType: input.slotType,
        name: input.name.trim(),
        capacity: input.capacity,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        unitLabel: input.unitLabel,
        notes: input.notes,
        sortOrder: (last?.sortOrder ?? -1) + 1,
      },
      select: {
        id: true, slotType: true, name: true, startsAt: true, endsAt: true,
        capacity: true, unitLabel: true, notes: true, sortOrder: true,
      },
    });

    return NextResponse.json({ slot: { ...slot, fill: slotFillState(slot.capacity, 0) } });
  } catch (error) {
    console.error("signup-slots POST error:", error);
    return NextResponse.json({ error: "Something went wrong." }, { status: 500 });
  }
}
