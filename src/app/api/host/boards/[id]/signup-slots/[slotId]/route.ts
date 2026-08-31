// src/app/api/host/boards/[id]/signup-slots/[slotId]/route.ts
// ============================================================
// HOST: edit one slot.
//
// PATCH  name, times, unitLabel, notes, capacity
//
// NO DELETE. Ruling 2.
//
// ---------------------------------------------------------------------------
// The capacity rule, and why it is not a read-then-write
// ---------------------------------------------------------------------------
//
// "Lowering capacity below the filled count is refused" cannot be implemented
// as read-count-then-update. Two tabs both read filled = 3, both decide
// capacity = 3 is legal, and both write; or one lowers to 3 while a claim lands
// position 4. The check and the write have to be the SAME statement:
//
//   UPDATE signup_slots SET capacity = $2
//    WHERE id = $1
//      AND $2 >= (SELECT count(*) FROM helper_signup_positions
//                  WHERE slot_id = signup_slots.id)
//
// Zero rows affected means refused. Only THEN is the filled count read, purely
// to put a real number in the message — the decision never depends on it.
//
// Raw SQL because Prisma has no `_count` filter in `where`; a correlated
// subquery is not expressible through updateMany.
//
// WHAT THIS DOES AND DOES NOT GUARANTEE. It makes concurrent capacity edits
// safe: the UPDATE takes a row lock, so the second serializes and re-evaluates
// against committed state. It does NOT by itself serialize a capacity edit
// against a CLAIM — capacity is not a database constraint on claiming, since
// safety there comes from unique (slotId, position) and the ceiling is applied
// in code. S3's claim path must SELECT ... FOR UPDATE the slot row before
// allocating positions. With that, both paths lock the same row. Without it,
// capacity is advisory. Recorded in the addendum as an S2 decision that
// constrains S3.
// ============================================================

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authorizeBoardEvent } from "@/lib/host-auth";
import {
  validateSlotInput,
  slotFillState,
  capacityTooLowMessage,
  slotTypeChangeRejected,
  SLOT_TYPE_IMMUTABLE_MESSAGE,
  type SlotInput,
} from "@/lib/signups";

interface Props {
  params: Promise<{ id: string; slotId: string }>;
}

type PatchBody = {
  /**
   * Accepted only so it can be REJECTED. A saved slot's type is immutable, and
   * silently ignoring the field would return 200 with the old type in the body
   * — the host sees "saved" and the wrong thing on screen.
   */
  slotType?: string;
  name?: string;
  capacity?: number;
  startsAt?: string | null;
  endsAt?: string | null;
  unitLabel?: string | null;
  notes?: string | null;
};

export async function PATCH(request: Request, { params }: Props) {
  try {
    const { id, slotId } = await params;
    const auth = await authorizeBoardEvent(id);
    if ("error" in auth) {
      return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    // The slot must belong to THIS board's sheet. Without this join a host
    // could edit any slot id they happened to learn.
    const slot = await prisma.signupSlot.findFirst({
      where: { id: slotId, sheet: { eventId: auth.eventId } },
      select: {
        id: true, slotType: true, name: true, startsAt: true, endsAt: true,
        capacity: true, unitLabel: true, notes: true,
      },
    });
    if (!slot) {
      return NextResponse.json({ error: "Slot not found." }, { status: 404 });
    }

    const body = (await request.json()) as PatchBody;

    // TYPE IS IMMUTABLE. The database cannot enforce this: the S1 CHECKs police
    // internal consistency, so an ITEM keeping its times is rejected — but a
    // flip that also clears the now-invalid fields produces a row Postgres
    // accepts. A CHECK only sees the present row; immutability is about its
    // history. Ruled 2026-08-31.
    if (slotTypeChangeRejected(slot.slotType, body.slotType)) {
      return NextResponse.json(
        { error: SLOT_TYPE_IMMUTABLE_MESSAGE, field: "slotType" },
        { status: 409 }
      );
    }

    // Validate the FULL resulting slot, not just the changed fields — a name
    // edit must not be able to leave an ITEM holding a start time that some
    // earlier write put there.
    const next: SlotInput = {
      slotType: slot.slotType as "SHIFT" | "ITEM",
      name: "name" in body ? (body.name ?? "") : slot.name,
      capacity: "capacity" in body ? (body.capacity ?? 0) : slot.capacity,
      startsAt: "startsAt" in body ? (body.startsAt ? new Date(body.startsAt) : null) : slot.startsAt,
      endsAt: "endsAt" in body ? (body.endsAt ? new Date(body.endsAt) : null) : slot.endsAt,
      unitLabel: "unitLabel" in body ? (body.unitLabel?.trim() || null) : slot.unitLabel,
      notes: "notes" in body ? (body.notes?.trim() || null) : slot.notes,
    };

    if (next.startsAt && Number.isNaN(next.startsAt.getTime()))
      return NextResponse.json({ error: "Unrecognized start time." }, { status: 400 });
    if (next.endsAt && Number.isNaN(next.endsAt.getTime()))
      return NextResponse.json({ error: "Unrecognized end time." }, { status: 400 });

    const valid = validateSlotInput(next);
    if (!valid.ok) {
      return NextResponse.json({ error: valid.message, field: valid.field }, { status: 400 });
    }

    const capacityChanged = "capacity" in body && next.capacity !== slot.capacity;

    // Capacity and the rest are written separately, inside one transaction: a
    // refused capacity must not silently discard the name the host also typed,
    // and a successful name edit must not imply the capacity landed.
    const result = await prisma.$transaction(async (tx) => {
      if (capacityChanged) {
        const rows = await tx.$executeRawUnsafe(
          `UPDATE signup_slots
              SET capacity = $2
            WHERE id = $1::uuid
              AND $2 >= (SELECT count(*) FROM helper_signup_positions
                          WHERE slot_id = signup_slots.id)`,
          slot.id,
          next.capacity
        );
        if (rows === 0) return { refused: true as const };
      }

      const data: Record<string, unknown> = {};
      if ("name" in body) data.name = next.name.trim();
      if ("startsAt" in body) data.startsAt = next.startsAt;
      if ("endsAt" in body) data.endsAt = next.endsAt;
      if ("unitLabel" in body) data.unitLabel = next.unitLabel;
      if ("notes" in body) data.notes = next.notes;

      if (Object.keys(data).length > 0) {
        await tx.signupSlot.update({ where: { id: slot.id }, data });
      }
      return { refused: false as const };
    });

    if (result.refused) {
      // Read the count only now, and only for the message.
      const filled = await prisma.helperSignupPosition.count({ where: { slotId: slot.id } });
      return NextResponse.json(
        { error: capacityTooLowMessage(filled), field: "capacity", filled },
        { status: 409 }
      );
    }

    const updated = await prisma.signupSlot.findUnique({
      where: { id: slot.id },
      select: {
        id: true, slotType: true, name: true, startsAt: true, endsAt: true,
        capacity: true, unitLabel: true, notes: true, sortOrder: true,
        _count: { select: { positions: true } },
      },
    });

    return NextResponse.json({
      slot: updated && {
        ...updated,
        _count: undefined,
        fill: slotFillState(updated.capacity, updated._count.positions),
      },
    });
  } catch (error) {
    console.error("signup-slot PATCH error:", error);
    return NextResponse.json({ error: "Something went wrong." }, { status: 500 });
  }
}
