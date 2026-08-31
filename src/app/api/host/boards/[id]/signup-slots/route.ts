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
  return { sheetId: sheet.id };
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
      startsAt: body.startsAt ? new Date(body.startsAt) : null,
      endsAt: body.endsAt ? new Date(body.endsAt) : null,
      unitLabel: body.unitLabel?.trim() || null,
      notes: body.notes?.trim() || null,
    };

    if (input.startsAt && Number.isNaN(input.startsAt.getTime()))
      return NextResponse.json({ error: "Unrecognized start time." }, { status: 400 });
    if (input.endsAt && Number.isNaN(input.endsAt.getTime()))
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
