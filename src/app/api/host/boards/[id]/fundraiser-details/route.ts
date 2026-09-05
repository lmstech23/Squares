// src/app/api/host/boards/[id]/fundraiser-details/route.ts
// ============================================================
// HOST: edit fundraiser event details and the fundraising goal.
//
// PATCH /api/host/boards/[id]/fundraiser-details
//
// FUNDRAISER-SPECIFIC BY DESIGN. This is not an extension of
// /details, which edits gameName / teamCol / teamRow — two of those are Game
// Day axis labels and mean nothing on a fundraiser board. Game Day's dialog is
// untouched.
//
// Before this route existed, Event rows were WRITE-ONCE: `prisma.event.create`
// appears exactly once in the codebase (api/boards/route.ts) and
// `prisma.event.update` appeared nowhere. A host who typed the wrong event date
// or venue had no way to correct it through any UI or API.
//
// What may change, and when:
//
//   name                 always
//   venue                always
//   fundraisingGoalCents always — v2 §7, "a goal is aspirational, not a term
//                        of the deal", explicitly NOT locked by invariant 16
//   startsAt             until the first CONFIRMED contribution
//   endsAt               until the first CONFIRMED contribution
//   timezone             until the first CONFIRMED contribution
//
// The lock predicate lives in lib/board-lock.ts and is shared. Contribution
// price, early-bird terms and prize terms are NOT editable here at all — they
// have no edit surface anywhere, and when they get one it must call the same
// predicate.
//
// NO CONTRIBUTOR NOTIFICATION. For the pilot, a mistaken date discovered after
// contributions is a manual-support exception. Controlled material changes with
// supporter notification and an audit trail are future state.
// ============================================================

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { prisma } from "@/lib/prisma";
import { parseZoned } from "@/lib/zoned-time";
import {
  hasConfirmedContribution,
  EVENT_FIELDS_LOCKED_AFTER_CONTRIBUTION,
  LOCK_REASON,
} from "@/lib/board-lock";

interface Props {
  params: Promise<{ id: string }>;
}

const MAX_NAME = 120;
const MAX_VENUE = 200;
const MAX_GOAL_CENTS = 100_000_000; // $1,000,000

type Body = {
  name?: string | null;
  venue?: string | null;
  startsAt?: string | null;
  endsAt?: string | null;
  timezone?: string | null;
  fundraisingGoalCents?: number | null;
};

export async function PATCH(request: Request, { params }: Props) {
  try {
    const { id } = await params;

    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const host = await prisma.host.findUnique({ where: { supabaseUserId: user.id } });
    if (!host) return NextResponse.json({ error: "Host not found" }, { status: 404 });

    const board = await prisma.board.findUnique({
      where: { boardId: id },
      select: {
        boardId: true,
        hostId: true,
        boardType: true,
        // Fallback zone when an event is being ADDED — see effectiveTz.
        timezone: true,
        event: { select: { id: true, timezone: true, startsAt: true, endsAt: true } },
      },
    });
    if (!board || board.hostId !== host.id) {
      return NextResponse.json({ error: "Board not found" }, { status: 404 });
    }
    if (board.boardType !== "fundraiser") {
      return NextResponse.json(
        { error: "This board is not a fundraiser." },
        { status: 400 }
      );
    }

    const body = (await request.json()) as Body;

    // --- the goal, which is never locked ------------------------------------
    let goalCents: number | null | undefined;
    if ("fundraisingGoalCents" in body) {
      const g = body.fundraisingGoalCents;
      if (g === null || g === undefined) goalCents = null;
      else if (!Number.isInteger(g) || g < 0 || g > MAX_GOAL_CENTS) {
        return NextResponse.json(
          { error: "Enter a goal between $0 and $1,000,000, or leave it blank." },
          { status: 400 }
        );
      } else goalCents = g;
    }

    // --- event fields --------------------------------------------------------
    const wantsEventEdit =
      "name" in body || "venue" in body || "startsAt" in body ||
      "endsAt" in body || "timezone" in body;

    // ADDING an event to a board that has none, rather than editing one.
    //
    // This used to be refused outright, which made the creation-time checkbox a
    // ONE-WAY DOOR: a host who did not tick it could never run volunteer
    // sign-ups, because a SignupSheet keys to an eventId. She makes that choice
    // before she knows whether she will want volunteers.
    //
    // INVARIANT 16 IS NOT ENGAGED BY ADDING ONE. Its event clause reads "on
    // boards with an event — event date"; a board without one has no event date
    // to lock, so nothing previously locked is being changed. Note also that
    // the list locks "prize on/off" explicitly — the doc knows how to freeze a
    // presence toggle when it means to, and did not do so for events. From this
    // write forward the new date IS locked, by the same clause.
    const creatingEvent = wantsEventEdit && !board.event;

    if (creatingEvent && !body.startsAt) {
      return NextResponse.json(
        { error: "An event needs a start time." },
        { status: 400 }
      );
    }

    // Event.timezone is NOT NULL but Board.timezone is nullable, so a board
    // with neither cannot resolve a zone. ASK rather than assume: interpreting
    // a wall-clock start time in a guessed zone silently moves the event, which
    // is the failure src/lib/zoned-time.ts exists to prevent.
    if (creatingEvent && !body.timezone && !board.timezone) {
      return NextResponse.json(
        { error: "An event needs a time zone." },
        { status: 400 }
      );
    }

    // One query, reused for every locked field, rather than one per field.
    // Skipped when creating: there is no stored value to protect.
    const locked =
      wantsEventEdit && !creatingEvent
        ? await hasConfirmedContribution(board.boardId)
        : false;

    // Report EVERY violated field at once. Rejecting one at a time makes a host
    // resubmit repeatedly to discover a rule that could have been stated once.
    if (locked) {
      const attempted = EVENT_FIELDS_LOCKED_AFTER_CONTRIBUTION.filter((f) => f in body);
      if (attempted.length > 0) {
        return NextResponse.json(
          { error: LOCK_REASON, lockedFields: attempted },
          { status: 409 }
        );
      }
    }

    const eventData: Record<string, unknown> = {};

    if ("name" in body) {
      const n = (body.name ?? "").trim();
      if (n.length > MAX_NAME) {
        return NextResponse.json({ error: `Event name must be ${MAX_NAME} characters or fewer.` }, { status: 400 });
      }
      eventData.name = n.length === 0 ? null : n;
    }

    if ("venue" in body) {
      const v = (body.venue ?? "").trim();
      if (v.length > MAX_VENUE) {
        return NextResponse.json({ error: `Venue must be ${MAX_VENUE} characters or fewer.` }, { status: 400 });
      }
      eventData.venue = v.length === 0 ? null : v;
    }

    // The timezone in effect for this write: a new one if supplied, else the
    // event's existing one. Wall-clock input must be interpreted in the zone it
    // was typed against, never in the server's.
    // Falls back to the BOARD's timezone when creating — every board has one,
    // and it is the zone the host has been entering wall-clock times against
    // all along (campaign close, early bird).
    const effectiveTz =
      "timezone" in body && body.timezone
        ? body.timezone
        : board.event?.timezone ?? board.timezone ?? "";

    if ("timezone" in body && body.timezone) {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: body.timezone });
      } catch {
        return NextResponse.json({ error: "Unrecognized timezone." }, { status: 400 });
      }
      eventData.timezone = body.timezone;
    }

    // `later` on a start and `earlier` on an end, matching the DST policy the
    // rest of the codebase uses for deadlines vs openings — src/lib/zoned-time.ts.
    if ("startsAt" in body) {
      if (!body.startsAt) {
        return NextResponse.json({ error: "An event needs a start time." }, { status: 400 });
      }
      const d = parseZoned(body.startsAt, effectiveTz, "later");
      if (!d) return NextResponse.json({ error: "Unrecognized start time." }, { status: 400 });
      eventData.startsAt = d;
    }

    if ("endsAt" in body) {
      if (!body.endsAt) eventData.endsAt = null;
      else {
        const d = parseZoned(body.endsAt, effectiveTz, "earlier");
        if (!d) return NextResponse.json({ error: "Unrecognized end time." }, { status: 400 });
        eventData.endsAt = d;
      }
    }

    // An end before its start is a typo, not a schedule. Checked against
    // whichever of the two is being written now plus whatever is already stored.
    const finalStart = (eventData.startsAt as Date | undefined) ?? board.event?.startsAt;
    const finalEnd =
      "endsAt" in eventData ? (eventData.endsAt as Date | null) : board.event?.endsAt ?? null;
    if (finalStart && finalEnd && finalEnd <= finalStart) {
      return NextResponse.json(
        { error: "The event's end time must be after its start time." },
        { status: 400 }
      );
    }

    // --- write ---------------------------------------------------------------
    await prisma.$transaction(async (tx) => {
      if (goalCents !== undefined) {
        await tx.board.update({
          where: { boardId: board.boardId },
          data: { fundraisingGoalCents: goalCents },
        });
      }
      if (Object.keys(eventData).length === 0) return;
      if (board.event) {
        await tx.event.update({ where: { id: board.event.id }, data: eventData });
        return;
      }
      // startsAt and timezone are NOT NULL on Event; both are guaranteed here
      // by the creatingEvent guard above and the effectiveTz fallback.
      await tx.event.create({
        data: {
          boardId: board.boardId,
          name: (eventData.name as string | null) ?? null,
          venue: (eventData.venue as string | null) ?? null,
          startsAt: eventData.startsAt as Date,
          endsAt: (eventData.endsAt as Date | null) ?? null,
          timezone: effectiveTz,
        },
      });
    });

    return NextResponse.json({ ok: true, locked });
  } catch (error) {
    console.error("fundraiser-details error:", error);
    return NextResponse.json(
      { error: "Something went wrong. Please try again." },
      { status: 500 }
    );
  }
}
