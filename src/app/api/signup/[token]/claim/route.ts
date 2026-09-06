// src/app/api/signup/[token]/claim/route.ts
// ============================================================
// SUPPORTER: set held quantities across one or more slots, in one save.
//
// POST { changes: [{ slotId, target }, ...] }
//
// A supporter picks everything she wants and saves once. Nothing commits on
// change.
//
// SEQUENTIAL, ONE setTargetQuantity CALL PER SLOT, AND DELIBERATELY NOT WRAPPED
// IN A TRANSACTION. setTargetQuantity already opens its own and holds
// SELECT ... FOR UPDATE on the slot row throughout, so calling it once per slot
// gives exactly the isolation this needs: a slot that fills up rolls back that
// slot and nothing else. A transaction around the loop would roll back the
// saves that SUCCEEDED, which is the opposite of what a partial failure should
// do. And sequential, never Promise.all - each call releases its lock before
// the next acquires one, so two slot locks are never held at once and deadlock
// is impossible by construction.
//
// PARTIAL FAILURE RETURNS 200. The batch was processed; `ok` and the per-slot
// `results` carry the outcome. A caller that reads only the status code will
// believe a half-saved batch saved completely.
//
// TARGET TOTAL, NOT A DELTA. `target` is the quantity she wants to hold after
// the request. A double-tap, a refresh mid-submit, or a retry after a timeout
// all compute a delta of zero the second time. That is why there is no
// idempotency key — the operation is idempotent by shape.
//
// There is no separate cancel route. Cancelling is `target: 0`, and partial
// reduction is a smaller target; one path means one set of edge cases.
//
// THE OLD SINGLE-SLOT SHAPE `{ slotId, target }` IS STILL ACCEPTED, normalized
// to a one-item batch. Every push deploys instantly and a supporter may have
// the sheet already open; without this her next save posts a shape the route no
// longer understands. Removal condition is in STATUS.md.
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
import type { BatchChange, BatchResult } from "@/lib/signup-batch";

interface Props {
  params: Promise<{ token: string }>;
}

/**
 * A sheet is host-authored and small; this is a guard against a malformed or
 * hostile request, not a product limit anyone will meet.
 */
const MAX_BATCH = 100;

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

    const body = (await request.json()) as {
      changes?: unknown;
      slotId?: unknown;
      target?: unknown;
    };

    // Normalize both shapes to a batch. The single-slot form is a valid
    // degenerate batch, not a separate code path.
    let changes: BatchChange[];
    if (Array.isArray(body.changes)) {
      changes = body.changes as BatchChange[];
    } else if (typeof body.slotId === "string" && typeof body.target === "number") {
      changes = [{ slotId: body.slotId, target: body.target }];
    } else {
      return NextResponse.json({ error: "Choose a slot and a quantity." }, { status: 400 });
    }

    if (changes.length === 0) {
      return NextResponse.json({ error: "Nothing to save." }, { status: 400 });
    }
    if (changes.length > MAX_BATCH) {
      return NextResponse.json({ error: "Too many changes at once." }, { status: 400 });
    }
    for (const c of changes) {
      if (typeof c?.slotId !== "string" || typeof c?.target !== "number") {
        return NextResponse.json({ error: "Choose a slot and a quantity." }, { status: 400 });
      }
    }

    // A duplicated slot id is a client bug, not a state a supporter can reach:
    // one slot has one target. Refusing beats guessing which one she meant.
    const ids = changes.map((c) => c.slotId);
    if (new Set(ids).size !== ids.length) {
      return NextResponse.json({ error: "Duplicate slot in one save." }, { status: 400 });
    }

    // Every slot must belong to THIS supporter's event. One query, so a
    // fifteen-slot save does not make fifteen round trips - and an id that is
    // not on this sheet fails the whole request rather than being skipped
    // quietly.
    const slots = await prisma.signupSlot.findMany({
      where: { id: { in: ids }, sheet: { eventId: session.eventId } },
      select: { id: true, name: true, slotType: true, capacity: true, unitLabel: true },
    });
    if (slots.length !== ids.length) {
      return NextResponse.json({ error: "That's not on this sheet." }, { status: 404 });
    }
    const bySlot = new Map(slots.map((s) => [s.id, s]));

    // SEQUENTIAL. See the header: each call takes and releases its own row
    // lock, so nothing is ever held across iterations.
    const results: BatchResult[] = [];
    for (const change of changes) {
      const slot = bySlot.get(change.slotId)!;
      try {
        const outcome = await setTargetQuantity({
          slotId: slot.id,
          supporterId: session.supporterId,
          target: change.target,
          actorType: "SUPPORTER",
        });

        if (outcome.ok) {
          results.push({
            slotId: slot.id,
            ok: true,
            quantity: outcome.quantity,
            changed: outcome.changed,
          });
          continue;
        }

        if (outcome.reason === "closed") {
          results.push({
            slotId: slot.id,
            ok: false,
            reason: "closed",
            error:
              "Sign-ups just closed. You can still cancel or reduce what you signed up for.",
          });
          continue;
        }

        if (outcome.reason === "not_active") {
          results.push({
            slotId: slot.id,
            ok: false,
            reason: "not_active",
            error:
              "Your contribution isn't confirmed yet, so you can't sign up for anything new. Anything you already signed up for is still yours.",
          });
          continue;
        }

        if (outcome.reason === "invalid_target") {
          results.push({
            slotId: slot.id,
            ok: false,
            reason: "invalid_target",
            error: outcome.message,
          });
          continue;
        }

        // Capacity moved under her. NEVER silently give fewer than asked - she
        // is told what is left and re-confirms. A host reading "3 cases" who
        // receives 2 has a real problem at 8am.
        const noun =
          slot.slotType === "ITEM" ? (slot.unitLabel ?? slot.name.toLowerCase()) : "spot";
        const left = outcome.available;
        results.push({
          slotId: slot.id,
          ok: false,
          reason: "capacity",
          error:
            left === 0
              ? `${slot.name} just filled up.`
              : `Only ${left} ${left === 1 ? noun : `${noun}s`} left.`,
          available: outcome.available,
          yourCurrent: outcome.yourCurrent,
          maxTarget: outcome.maxTarget,
        });
      } catch (err) {
        // ONE SLOT MUST NOT ABORT THE REST. A thrown error here is a database
        // problem, not a rule, so it is reported against its slot and the loop
        // continues - the same isolation a capacity conflict gets.
        console.error("signup batch item failed:", slot.id, err);
        results.push({
          slotId: slot.id,
          ok: false,
          reason: "error",
          error: "Couldn't save this one. Try again.",
        });
      }
    }

    // 200 EVEN WITH FAILURES INSIDE. The batch was processed; the body says
    // what happened. Auth, token and shape problems above keep their 4xx.
    return NextResponse.json({
      ok: results.every((r) => r.ok),
      results,
    });
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
