// src/app/api/signup/[token]/claim/route.ts
// ============================================================
// SUPPORTER: set held quantity on one slot.
//
// POST { slotId, target }
//
// TARGET TOTAL, NOT A DELTA. `target` is the quantity she wants to hold after
// the request. A double-tap, a refresh mid-submit, or a retry after a timeout
// all compute a delta of zero the second time. That is why there is no
// idempotency key — the operation is idempotent by shape.
//
// There is no separate cancel route. Cancelling is `target: 0`, and partial
// reduction is a smaller target; one path means one set of edge cases.
//
// All the real work is in setTargetQuantity(), which is the only writer of
// HelperSignup and HelperSignupPosition and holds SELECT ... FOR UPDATE on the
// slot row throughout. This file is auth, parsing, and turning outcomes into
// sentences.
// ============================================================

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  resolveSupporterSession,
  classifyTokenFailure,
  setTargetQuantity,
  slotAvailability,
} from "@/lib/signups";

interface Props {
  params: Promise<{ token: string }>;
}

export async function POST(request: Request, { params }: Props) {
  try {
    const { token } = await params;

    // Rendering and claiming are separate gates, but both need a live token.
    const session = await resolveSupporterSession(token);
    if (!session) {
      const why = await classifyTokenFailure(token);
      // Expired and revoked get their own copy — someone holding a link that
      // used to work deserves to be told to ask for a new one. Unknown and
      // malformed are identical, so a prober learns nothing about which
      // hashes exist.
      if (why === "expired")
        return NextResponse.json(
          { error: "This link has expired. Ask the host for a new one." },
          { status: 410 }
        );
      if (why === "revoked")
        return NextResponse.json(
          { error: "This link is no longer active. Ask the host for a new one." },
          { status: 410 }
        );
      return NextResponse.json(
        { error: "This link isn't valid. Check the link in your email." },
        { status: 404 }
      );
    }

    const body = (await request.json()) as { slotId?: string; target?: number };
    if (typeof body.slotId !== "string" || typeof body.target !== "number") {
      return NextResponse.json({ error: "Choose a slot and a quantity." }, { status: 400 });
    }

    // The slot must belong to THIS supporter's event. Without this a valid
    // token could reach any slot id its holder learned.
    const slot = await prisma.signupSlot.findFirst({
      where: { id: body.slotId, sheet: { eventId: session.eventId } },
      select: { id: true, name: true, slotType: true, capacity: true, unitLabel: true },
    });
    if (!slot) {
      return NextResponse.json({ error: "That's not on this sheet." }, { status: 404 });
    }

    const outcome = await setTargetQuantity({
      slotId: slot.id,
      supporterId: session.supporterId,
      target: body.target,
      actorType: "SUPPORTER",
    });

    if (outcome.ok) {
      return NextResponse.json({
        ok: true,
        slotId: slot.id,
        quantity: outcome.quantity,
        changed: outcome.changed,
      });
    }

    if (outcome.reason === "closed") {
      return NextResponse.json(
        {
          error:
            "Sign-ups just closed. You can still cancel or reduce what you signed up for.",
        },
        { status: 409 }
      );
    }

    if (outcome.reason === "not_active") {
      return NextResponse.json(
        {
          error:
            "Your contribution isn't confirmed yet, so you can't sign up for anything new. Anything you already signed up for is still yours.",
        },
        { status: 409 }
      );
    }

    if (outcome.reason === "invalid_target") {
      return NextResponse.json({ error: outcome.message }, { status: 400 });
    }

    // Capacity moved under her. NEVER silently give fewer than asked — she is
    // told what is left and re-confirms. A host reading "3 cases" who receives
    // 2 has a real problem at 8am.
    const noun =
      slot.slotType === "ITEM" ? (slot.unitLabel ?? slot.name.toLowerCase()) : "spot";
    const left = outcome.available;
    return NextResponse.json(
      {
        error:
          left === 0
            ? `${slot.name} just filled up.`
            : `Only ${left} ${left === 1 ? noun : `${noun}s`} left.`,
        field: "target",
        available: outcome.available,
        yourCurrent: outcome.yourCurrent,
        maxTarget: outcome.maxTarget,
      },
      { status: 409 }
    );
  } catch (error) {
    console.error("signup claim error:", error);
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}

/** Re-read the sheet after a conflict, so the client can resync without a reload. */
export async function GET(_request: Request, { params }: Props) {
  try {
    const { token } = await params;
    const session = await resolveSupporterSession(token);
    if (!session) {
      return NextResponse.json({ error: "This link isn't valid." }, { status: 404 });
    }

    const sheet = await prisma.signupSheet.findUnique({
      where: { eventId: session.eventId },
      select: {
        isOpen: true,
        slots: {
          orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
          select: {
            id: true, name: true, slotType: true, capacity: true,
            startsAt: true, endsAt: true, unitLabel: true, notes: true,
            _count: { select: { positions: true } },
            signups: {
              where: { eventSupporterId: session.supporterId },
              select: { _count: { select: { positions: true } } },
            },
          },
        },
      },
    });
    if (!sheet) {
      return NextResponse.json({ error: "No sign-up sheet yet." }, { status: 404 });
    }

    return NextResponse.json({
      isOpen: sheet.isOpen,
      slots: sheet.slots.map((sl) => {
        const yourCurrent = sl.signups[0]?._count.positions ?? 0;
        return {
          id: sl.id,
          name: sl.name,
          slotType: sl.slotType,
          unitLabel: sl.unitLabel,
          notes: sl.notes,
          startsAt: sl.startsAt,
          endsAt: sl.endsAt,
          ...slotAvailability(
            sl.capacity,
            sl._count.positions,
            yourCurrent,
            sl.slotType as "SHIFT" | "ITEM"
          ),
        };
      }),
    });
  } catch (error) {
    console.error("signup sheet read error:", error);
    return NextResponse.json({ error: "Something went wrong." }, { status: 500 });
  }
}
