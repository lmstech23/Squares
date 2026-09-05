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
//   squarePrice          until the first confirmed REGULAR-price square
//   earlyBirdPriceCents  until the first confirmed EARLY-BIRD square
//   earlyBirdEndsAt      until the first confirmed EARLY-BIRD square
//   hostVenmo / hostZelle / hostCashapp / hostPaypal
//                        ALWAYS, including after the campaign closes, subject
//                        only to at least one surviving
//
// The lock predicates live in lib/board-lock.ts and are shared WITH THE EDIT
// SURFACE, so the form disables exactly what this route would refuse. A host
// should learn a field is locked by looking at it, not by saving and getting
// a 409.
//
// The three price locks are INDEPENDENT of the event lock and of each other
// — launch-readiness v2.1 invariant 76. Prize terms are still not editable
// here; when they get a surface they must call the same predicates.
//
// NO CONTRIBUTOR NOTIFICATION. For the pilot, a mistaken date discovered after
// contributions is a manual-support exception. Controlled material changes with
// supporter notification and an audit trail are future state.
// ============================================================

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { prisma } from "@/lib/prisma";
import { parseZoned, endOfDayZoned } from "@/lib/zoned-time";
import { ticketCountFor, validateTicketCount } from "@/lib/board-inventory";
import {
  hasConfirmedContribution,
  EVENT_FIELDS_LOCKED_AFTER_CONTRIBUTION,
  LOCK_REASON,
  pricingLocks,
  EARLY_BIRD_LOCK_REASON,
  REGULAR_LOCK_REASON,
} from "@/lib/board-lock";

interface Props {
  params: Promise<{ id: string }>;
}

const MAX_NAME = 120;
const MAX_VENUE = 200;
const MAX_GOAL_CENTS = 100_000_000; // $1,000,000
// Only reached if Board.timezone is null, which no board created by
// api/boards has been - it hardcodes the same zone.
const DEFAULT_TIMEZONE = "America/New_York";

type Body = {
  name?: string | null;
  venue?: string | null;
  startsAt?: string | null;
  endsAt?: string | null;
  timezone?: string | null;
  fundraisingGoalCents?: number | null;
  /// v2 §11 lists the description as always editable. Until now nothing
  /// could edit it: it was set at creation and reachable by no route.
  causeDescription?: string | null;
  /// Pricing. Locked independently per launch-readiness v2.1 invariant 76.
  squarePrice?: number;
  earlyBirdPriceCents?: number | null;
  earlyBirdEndsAt?: string | null;
  /// Direct-payment handles. NEVER LOCKED - see the block that applies them.
  hostVenmo?: string | null;
  hostZelle?: string | null;
  hostCashapp?: string | null;
  hostPaypal?: string | null;
};

const HANDLE_FIELDS = ["hostVenmo", "hostZelle", "hostCashapp", "hostPaypal"] as const;
type HandleField = (typeof HANDLE_FIELDS)[number];

// The SAME sentence api/boards/route.ts uses when refusing a board with no
// handle. Duplicated as a literal rather than shared, because extracting it
// would mean editing the creation route, which this change is scoped out of.
// Flagged: if one is ever reworded the other must be too.
const NO_PAYMENT_HANDLE =
  "Add at least one way to receive payment — Venmo, Zelle, Cash App, or PayPal.";

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
        squarePrice: true,
        earlyBirdPriceCents: true,
        earlyBirdEndsAt: true,
        fundraisingGoalCents: true,
        causeDescription: true,
        hostVenmo: true,
        hostZelle: true,
        hostCashapp: true,
        hostPaypal: true,
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

    // --- the cause description, which is never locked ------------------------
    //
    // NO LENGTH CAP, matching creation, which applies none. Adding one here
    // would let this route refuse a description creation had already accepted.
    let boardDataCause: string | null | undefined;
    if ("causeDescription" in body) {
      boardDataCause = body.causeDescription?.trim() || null;
    }

    // --- pricing and inventory ------------------------------------------------
    //
    // THREE SEPARATE RULES, deliberately not merged.
    //
    // PRICE — launch-readiness v2.1 §1.4, invariant 76: "The early bird fields
    // lock at the first confirmed square whose priceSource = early_bird. The
    // regular price (squarePrice) locks at the first confirmed square whose
    // priceSource = regular. Neither lock affects the other." So after the
    // first EARLY BIRD sale the regular price may still change — nobody has
    // bought at it.
    //
    // INVENTORY — money doc invariant 16 locks square count at the first
    // confirmed contribution OF ANY KIND. Ticket numbers are square positions;
    // an early-bird buyer holding ticket #87 must not have the board shrink.
    //
    // GOAL — v2 §7, aspirational, never locked. It simply stops driving
    // inventory once inventory is locked.
    const locks = await pricingLocks(board.boardId);

    if ("squarePrice" in body && locks.regularLocked) {
      return NextResponse.json({ error: REGULAR_LOCK_REASON }, { status: 409 });
    }
    if (("earlyBirdPriceCents" in body || "earlyBirdEndsAt" in body) && locks.earlyBirdLocked) {
      return NextResponse.json({ error: EARLY_BIRD_LOCK_REASON }, { status: 409 });
    }

    const boardData: Record<string, unknown> = {};

    if ("squarePrice" in body) {
      const v = body.squarePrice;
      if (!Number.isInteger(v) || (v as number) < 100) {
        return NextResponse.json({ error: "Ticket price must be at least $1." }, { status: 400 });
      }
      boardData.squarePrice = v;
    }
    if ("earlyBirdPriceCents" in body) {
      const v = body.earlyBirdPriceCents;
      if (v == null) boardData.earlyBirdPriceCents = null;
      else {
        if (!Number.isInteger(v) || v < 100) {
          return NextResponse.json({ error: "Early bird price must be at least $1." }, { status: 400 });
        }
        boardData.earlyBirdPriceCents = v;
      }
    }
    if ("earlyBirdEndsAt" in body) {
      // DATE-ONLY, END OF DAY, IN THE BOARD'S ZONE — the same rule creation
      // uses (api/boards/route.ts) and the same rule campaign close uses.
      //
      // This was `new Date(body.earlyBirdEndsAt)`, written when no UI reached
      // it. A wall-clock string with no offset is parsed as LOCAL time, and on
      // Vercel local is UTC — so "ends March 3" saved from a form would have
      // become 00:00 UTC, i.e. 7pm Eastern on March 2, ending the early price
      // a day early. That is exactly the failure zoned-time.ts exists to
      // prevent, and CLAUDE.md forbids the construct by name.
      const raw = body.earlyBirdEndsAt;
      if (!raw) boardData.earlyBirdEndsAt = null;
      else {
        const d = endOfDayZoned(raw, board.timezone ?? DEFAULT_TIMEZONE);
        if (!d) {
          return NextResponse.json(
            { error: "Set a date for the early bird price to end." },
            { status: 400 }
          );
        }
        boardData.earlyBirdEndsAt = d;
      }
    }

    // A REAL MESSAGE, not a generic 400 — launch-readiness §1.4 is explicit:
    // "An 'early bird price' that isn't lower than the regular price is not an
    // early bird price, and the host has almost certainly typed the two into
    // the wrong fields."
    const finalRegular = (boardData.squarePrice as number | undefined) ?? board.squarePrice;
    const finalEarly =
      "earlyBirdPriceCents" in boardData
        ? (boardData.earlyBirdPriceCents as number | null)
        : board.earlyBirdPriceCents;
    if (finalEarly != null && finalEarly >= finalRegular) {
      return NextResponse.json(
        {
          error:
            "The early bird price must be below the ticket price. " +
            "Check the two amounts are not the wrong way round.",
        },
        { status: 400 }
      );
    }
    // The live CHECK also requires an end date whenever an early price exists.
    if (finalEarly != null) {
      const finalEnds =
        "earlyBirdEndsAt" in boardData
          ? (boardData.earlyBirdEndsAt as Date | null)
          : board.earlyBirdEndsAt;
      if (!finalEnds) {
        return NextResponse.json(
          { error: "An early bird price needs an end date." },
          { status: 400 }
        );
      }
    }

    // A RESIZE NEEDS AN ACTUAL CHANGE, not merely a field being present.
    //
    // The edit form always sends fundraisingGoalCents - it is one dialog and
    // the goal is one of its inputs - so `"goal" in body` was true on every
    // save, including one that fixed a venue typo. That ran the resize on an
    // unlocked board for no reason. Nothing visibly broke, because recomputing
    // the same count from the same two numbers is a no-op, but it meant an
    // unrelated edit could create or delete rows the moment anything else
    // drifted.
    //
    // Compared in CENTS against the stored values, not as strings: "50" and
    // "50.00" are the same price, and re-saving the same number must not count
    // as a change.
    const goalChanged =
      goalCents !== undefined && goalCents !== board.fundraisingGoalCents;
    const priceChanged =
      "squarePrice" in boardData && boardData.squarePrice !== board.squarePrice;
    const willResize = !locks.inventoryLocked && (goalChanged || priceChanged);

    const nextGoal = goalCents !== undefined ? goalCents : board.fundraisingGoalCents;
    const nextPrice = (boardData.squarePrice as number | undefined) ?? board.squarePrice;

    // The resize path below reaches the same ceiling as creation, so it is
    // rejected here rather than silently declining to resize. Gated on
    // `willResize` too: a board that predates the cap must not have a venue
    // correction refused over a count nobody is changing.
    if (willResize && nextGoal != null) {
      const check = validateTicketCount(nextGoal, nextPrice);
      if (!check.ok) {
        return NextResponse.json({ error: check.error }, { status: 400 });
      }
    }

    // --- direct-payment handles ----------------------------------------------
    //
    // NO LOCK, AT ANY POINT IN THE BOARD'S LIFE. Not after the first confirmed
    // contribution, not after the campaign closes. Handles are named in no
    // invariant; they were immutable only because nothing wrote them, which is
    // not the same as being protected. A wrong handle is MOST urgent while
    // money is moving: every contributor who reads it sends real money to a
    // stranger, and the host cannot get it back.
    //
    // NO FORMAT VALIDATION, deliberately and consistently with creation. There
    // is no reliable shape for a Cash App tag, a Zelle enrolment (a phone
    // number or an email) or a PayPal.me link, and a regex that rejects a valid
    // handle would be worse than one that accepts a typo - it would block the
    // correction this route exists to allow.
    //
    // AT LEAST ONE MUST SURVIVE, matching creation. Clearing Venmo while Zelle
    // remains is an ordinary edit and is allowed. Clearing the last one would
    // leave contributors a board with nowhere to send money, which is the state
    // creation already refuses to produce.
    const finalHandles: Record<HandleField, string | null> = {
      hostVenmo: board.hostVenmo,
      hostZelle: board.hostZelle,
      hostCashapp: board.hostCashapp,
      hostPaypal: board.hostPaypal,
    };
    let touchedHandles = false;
    for (const f of HANDLE_FIELDS) {
      if (!(f in body)) continue;
      touchedHandles = true;
      // Same normalisation as creation: trim, and empty means absent.
      finalHandles[f] = body[f]?.trim() || null;
    }
    if (touchedHandles) {
      if (!HANDLE_FIELDS.some((f) => finalHandles[f])) {
        return NextResponse.json({ error: NO_PAYMENT_HANDLE }, { status: 400 });
      }
      for (const f of HANDLE_FIELDS) {
        if (f in body) boardData[f] = finalHandles[f];
      }
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
      if (goalCents !== undefined) boardData.fundraisingGoalCents = goalCents;
      if (boardDataCause !== undefined) boardData.causeDescription = boardDataCause;
      if (Object.keys(boardData).length > 0) {
        await tx.board.update({ where: { boardId: board.boardId }, data: boardData });
      }

      // INVENTORY RECALCULATION — only while NOTHING is confirmed, and only
      // when the goal or the ticket price ACTUALLY MOVED. After the first
      // confirmed square neither a goal change nor a price change resizes the
      // board; the goal still saves, it just stops driving size.
      if (willResize) {
        const want = ticketCountFor(nextGoal, nextPrice);
        if (want != null) {
          const existing = await tx.square.count({ where: { boardId: board.boardId } });
          if (want > existing) {
            await tx.square.createMany({
              data: Array.from({ length: want - existing }, (_, i) => ({
                boardId: board.boardId,
                position: existing + i,
                paymentStatus: "open" as const,
              })),
            });
          } else if (want < existing) {
            // Only `open` squares may be removed, highest positions first. A
            // pending or reserved square is somebody's claim in flight; nothing
            // is confirmed yet, but deleting it would take a hold out from
            // under a live checkout.
            const removable = await tx.square.findMany({
              where: { boardId: board.boardId, paymentStatus: "open" },
              orderBy: { position: "desc" },
              take: existing - want,
              select: { squareId: true },
            });
            if (removable.length > 0) {
              await tx.square.deleteMany({
                where: { squareId: { in: removable.map((r) => r.squareId) } },
              });
            }
            // Falling short is not an error: the board keeps the squares it
            // could not free, and the count settles once those holds resolve.
          }

          // totalSquares FOLLOWS THE ROWS, IN THE SAME TRANSACTION.
          //
          // This block wrote and deleted Square rows and left the column
          // alone, so a resize silently desynchronised the two. At least three
          // screens read the column and not the rows: the host page's
          // "X of Y confirmed", the boards list "N / M paid", and the progress
          // bar denominator. A board resized from 100 to 150 kept reporting
          // "of 100" while fifty real tickets existed underneath.
          //
          // RECOUNTED, NOT SET TO `want`. The shrink path above is allowed to
          // fall short - it will not delete a square somebody is holding - so
          // `want` is a request and the count is the answer. Writing `want`
          // here would replace a stale column with a confidently wrong one.
          if (want !== existing) {
            const actual = await tx.square.count({ where: { boardId: board.boardId } });
            await tx.board.update({
              where: { boardId: board.boardId },
              data: { totalSquares: actual },
            });
          }
        }
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
