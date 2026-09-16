import { randomInt } from "crypto";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { prisma } from "@/lib/prisma";
import { validateTicketCount } from "@/lib/board-inventory";
import { Prisma } from "@prisma/client";
import { parseZoned, endOfDayZoned } from "@/lib/zoned-time";
import { validateEntryPricing } from "@/lib/entry-pricing";
import { boardCreationGate } from "@/lib/board-creation-gate";
import { generateSlug } from "@/lib/slug";

// ============================================================
// PHASE 1 ADDITIONS:
//   1. Accept sportType (required) — drives periodType server-side
//   2. Accept gridType (optional, default "standard"); reject "double"
//      until Phase 2 ships winner calc for 5×5 boards
//   3. Server is source of truth for periodType + periodLabels.
//
// FIXED: quarters labels now end in "Final" (was "Q4"),
// matching SYSTEM-FLOW.md and the locked decision.
//
// REMOVED: nothing. All three creation paths (platform owner,
// has credits, no credits → pending), cash-mode auto-PIN,
// pending guard, and payout coordination preserved.
// ============================================================

type SportType = "nba" | "nfl" | "cbb";
type GridType = "standard" | "double";

const VALID_SPORTS: SportType[] = ["nba", "nfl", "cbb"];

// Server-side derivation: sport → period structure
const PERIOD_TYPE_BY_SPORT: Record<SportType, "halves" | "quarters"> = {
  nba: "quarters",
  nfl: "quarters",
  cbb: "halves",
};

const PERIOD_LABELS: Record<string, string[]> = {
  halves: ["H1", "Final"],
  quarters: ["Q1", "Q2", "Q3", "Final"],
};

// ============================================================
// FUNDRAISER (v2 §5, build step A3)
//   boardType branches validation and the shape of boardData. Game Day is
//   untouched — every existing field, path, and guard behaves as before.
//   Phase A: no prize fields. prizePoolPercent stays 0 and is never accepted
//   from the client, because a host must not be able to switch on a drawing
//   that has nothing behind it (v2 §16).
// ============================================================

type BoardType = "game" | "fundraiser";

// Game Day still offers a fixed set of grid sizes — its board IS the grid, and
// 25/50/75/100 are the shapes that draw. Fundraiser no longer uses this: its
// inventory is derived from goal and price (src/lib/board-inventory.ts).
const VALID_SQUARE_COUNTS = [25, 50, 75, 100];
void VALID_SQUARE_COUNTS;

/** Phase A is single-region — v2 §5. IANA, never a fixed offset. */
const BOARD_TIMEZONE = "America/New_York";

interface CreateBoardBody {
  gameName: string;
  sportType: SportType;
  squarePrice: number;
  teamRow: string;
  teamCol: string;
  gridType?: GridType;
  hostCutPercent?: number;
  payoutStructure: Record<string, number>;
  // Payout coordination
  hostVenmo?: string | null;
  hostZelle?: string | null;
  hostCashapp?: string | null;
  hostPaypal?: string | null;
  payoutVisibility?: "public" | "pin_gated";
  requirePlayerPayout?: boolean;
  // Fundraiser — v2 §5
  boardType?: BoardType;
  causeDescription?: string | null;
  totalSquares?: number;
  fundraisingGoalCents?: number | null;
  campaignEndsAt?: string;
  earlyBirdPriceCents?: number | null;
  earlyBirdEndsAt?: string | null;
  /// Standalone Entry Ticket prices - fundraiser-board-v2.md §19.
  /// Each independently optional; null or absent means the tier is NOT
  /// OFFERED, which is how a board opts out of the whole feature.
  entryChildPriceCents?: number | null;
  entryAdultEarlyPriceCents?: number | null;
  entryAdultRegularPriceCents?: number | null;
  cashHoldDays?: number;
  // Optional event block — v2 §5
  hasEvent?: boolean;
  eventName?: string | null;
  eventStartsAt?: string;
  eventVenue?: string | null;
}

/// Parsed event config, or null when the board has no event attached.
interface EventInput {
  name: string | null;
  startsAt: Date;
  timezone: string;
  venue: string | null;
}

export async function POST(request: Request) {
  try {
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

    // 2. Payment readiness gate
    //
    // THIS STEP WAS DELETED, NOT MISSING BY DESIGN — `349529a` removed it on
    // 2026-02-26 and left the numbering jumping from 1 to 3. Fixing only the
    // page gate would be worse than fixing neither: the host reaches the form,
    // fills in game name, teams, price and payout split, and is refused on
    // submit with the work still in the fields.
    //
    // THE API CANNOT REDIRECT, so the destination travels in the body and the
    // client routes. The three refusals keep their own messages — "you never
    // chose" and "your Stripe is not ready" are not the same problem.
    const gate = boardCreationGate(host);
    if (!gate.allow) {
      return NextResponse.json(
        { error: gate.message, reason: gate.reason, destination: gate.destination },
        { status: 403 }
      );
    }

    // 3. Parse + validate body
    const body: CreateBoardBody = await request.json();

    const boardType: BoardType = body.boardType === "fundraiser" ? "fundraiser" : "game";

    if (!body.gameName?.trim()) {
      return NextResponse.json(
        { error: boardType === "fundraiser"
            ? "Tell people what you're raising money for."
            : "Game name is required." },
        { status: 400 }
      );
    }

    if (!body.squarePrice || body.squarePrice < 100) {
      return NextResponse.json(
        {
          error:
            boardType === "fundraiser"
              ? "Contribution per square must be at least $1."
              : "Price per square must be at least $1.",
        },
        { status: 400 }
      );
    }

    // Shared across both board types.
    let totalSquares: number;
    let eventInput: EventInput | null = null;
    // Game Day only — left undefined on fundraiser boards, where the columns
    // are unused (v2 §3).
    let gridType: GridType = "standard";
    let gameOnlyData: Partial<Prisma.BoardUncheckedCreateInput> = {};
    let fundraiserOnlyData: Partial<Prisma.BoardUncheckedCreateInput> = {};

    if (boardType === "game") {
      // ---------- Game Day — unchanged ----------
      if (!body.teamRow?.trim() || !body.teamCol?.trim()) {
        return NextResponse.json(
          { error: "Both team names are required." },
          { status: 400 }
        );
      }

      // PHASE 1: Validate sportType (required, enum)
      if (!body.sportType || !VALID_SPORTS.includes(body.sportType)) {
        return NextResponse.json(
          { error: "Sport is required. Must be nba, nfl, or cbb." },
          { status: 400 }
        );
      }

      // PHASE 2: gridType determines square count
      gridType = body.gridType ?? "standard";
      if (gridType !== "standard" && gridType !== "double") {
        return NextResponse.json(
          { error: "Invalid grid type. Must be standard or double." },
          { status: 400 }
        );
      }
      totalSquares = gridType === "double" ? 25 : 100;

      // 4. Derive period type and labels server-side from sportType
      const periodType = PERIOD_TYPE_BY_SPORT[body.sportType];
      const periodLabels = PERIOD_LABELS[periodType];

      // 5. Validate host cut percentage
      const hostCutPercent = body.hostCutPercent ?? 0;
      if (!Number.isInteger(hostCutPercent) || hostCutPercent < 0 || hostCutPercent > 50) {
        return NextResponse.json(
          { error: "Host cut must be an integer between 0 and 50." },
          { status: 400 }
        );
      }

      // 6. Validate payout structure
      const payoutStructure = body.payoutStructure;

      if (!payoutStructure || typeof payoutStructure !== "object") {
        return NextResponse.json(
          { error: "Payout structure is required." },
          { status: 400 }
        );
      }

      for (const label of periodLabels) {
        if (payoutStructure[label] == null) {
          return NextResponse.json(
            { error: `Payout structure must include "${label}".` },
            { status: 400 }
          );
        }
      }

      const values = periodLabels.map((l) => payoutStructure[l]);

      if (values.some((v) => typeof v !== "number" || v < 0)) {
        return NextResponse.json(
          { error: "Payout percentages cannot be negative." },
          { status: 400 }
        );
      }

      const total = values.reduce((sum, v) => sum + v, 0);
      if (Math.abs(total - 100) > 0.01) {
        return NextResponse.json(
          { error: "Payout percentages must total 100%." },
          { status: 400 }
        );
      }

      gameOnlyData = {
        teamRow: body.teamRow.trim(),
        teamCol: body.teamCol.trim(),
        periodType,
        periodLabels,
        payoutStructure,
        hostCutPercent,
        sportType: body.sportType,
        gridType,
      };
    } else {
      // ---------- Fundraiser — v2 §5 ----------
      // No sport, teams, periods, payout split, or host cut. If any of those
      // arrive they are ignored, not stored.
      // INVENTORY IS DERIVED, NOT SUBMITTED. `body.totalSquares` is ignored on
      // a fundraiser: the count follows from the goal and the regular price, so
      // accepting a client value would let the two disagree. See
      // src/lib/board-inventory.ts.
      //
      // Computed after the goal and price are validated, below.
      totalSquares = 0;

      // Phase A is single-region. Hardcoded rather than selected, and stored
      // as an IANA zone rather than a fixed offset: "EST" as a literal -5
      // would be an hour wrong from March through November, and homecoming is
      // in October. The column stays, so adding a selector later is a form
      // change rather than a migration. v2 §5.
      const timezone = BOARD_TIMEZONE;

      // Campaign close is required on every fundraiser board, prize or not —
      // drawDate no longer doubles as the backstop (v2 §5).
      // Date only. A close date means the end of that day, so it lands at
      // 11:59:59 PM local — pick Oct 9 and someone clicking through at 4pm on
      // the 9th makes it. v2 §5.
      const campaignEndsAt = endOfDayZoned(body.campaignEndsAt, timezone);
      if (!campaignEndsAt) {
        return NextResponse.json(
          { error: "A campaign close date is required." },
          { status: 400 }
        );
      }

      // Entry Ticket tier prices, parsed BEFORE the early bird block because
      // the cutoff date is shared: an adult early entry price requires the same
      // `earlyBirdEndsAt` a square early bird price does, and the block below
      // has to know whether either product wants one.
      //
      // OPTIONAL, TIER BY TIER. A board that sends none of these is untouched
      // by the feature. The $1 floor matches squarePrice; the database CHECK
      // only requires a positive amount, and this is the stricter of the two
      // because a 50-cent admission is far more likely a typo than an intent.
      const entry: Record<string, number | null> = {
        entryChildPriceCents: null,
        entryAdultEarlyPriceCents: null,
        entryAdultRegularPriceCents: null,
      };
      for (const field of [
        "entryChildPriceCents",
        "entryAdultEarlyPriceCents",
        "entryAdultRegularPriceCents",
      ] as const) {
        const v = body[field];
        if (v != null) entry[field] = v;
      }

      // ONE VALIDATOR, shared with the edit route. The cutoff is resolved
      // below, so `cutoffPresent` is whether one will EXIST after this write:
      // a date was supplied, or a square early bird price is bringing one.
      const entryCheck = validateEntryPricing({
        childCents: entry.entryChildPriceCents,
        adultEarlyCents: entry.entryAdultEarlyPriceCents,
        adultRegularCents: entry.entryAdultRegularPriceCents,
        hasEvent: Boolean(body.hasEvent),
        cutoffPresent: Boolean(body.earlyBirdEndsAt),
      });
      if (!entryCheck.ok) {
        return NextResponse.json({ error: entryCheck.error }, { status: 400 });
      }

      // Early bird — money doc §8B. Optional; the end date is required only
      // when a price is set. No validation relates it to the other two dates.
      let earlyBirdPriceCents: number | null = null;
      let earlyBirdEndsAt: Date | null = null;
      if (body.earlyBirdPriceCents != null) {
        earlyBirdPriceCents = body.earlyBirdPriceCents;
        if (!Number.isInteger(earlyBirdPriceCents) || earlyBirdPriceCents < 100) {
          return NextResponse.json(
            { error: "Early bird price must be at least $1." },
            { status: 400 }
          );
        }
        if (earlyBirdPriceCents >= body.squarePrice) {
          return NextResponse.json(
            { error: "Early bird price must be below the standard price." },
            { status: 400 }
          );
        }
      }

      // ONE CUTOFF, EITHER PRODUCT. `earlyBirdEndsAt` is resolved when a square
      // early bird price OR an adult early entry price is set, because both
      // CHECKs require it - boards_early_bird_coherent and
      // boards_entry_pricing_coherent. Resolving it only inside the square
      // branch above is what would let a board be created with early entry
      // pricing and no date, which the database then refuses.
      if (earlyBirdPriceCents != null || entry.entryAdultEarlyPriceCents != null) {
        // Date only, same end-of-day rule as campaign close.
        earlyBirdEndsAt = endOfDayZoned(body.earlyBirdEndsAt, timezone);
        if (!earlyBirdEndsAt) {
          return NextResponse.json(
            { error: "Set a date for the early bird price to end." },
            { status: 400 }
          );
        }
      }

      // REQUIRED NOW, because it determines inventory. It was optional while it
      // only drove a progress bar (v2 §7); a board cannot be sized without it.
      // Boards created before this change may still carry null and every
      // consumer still handles that — nothing is backfilled.
      if (body.fundraisingGoalCents == null) {
        return NextResponse.json(
          { error: "A fundraising goal is required — it sets how many tickets the board has." },
          { status: 400 }
        );
      }
      const fundraisingGoalCents: number = body.fundraisingGoalCents;
      if (!Number.isInteger(fundraisingGoalCents) || fundraisingGoalCents < 100) {
        return NextResponse.json(
          { error: "Fundraising goal must be at least $1." },
          { status: 400 }
        );
      }

      // THE SERVER CHECK IS THE ONE THAT MATTERS. The client validates as she
      // types, but it can be bypassed, and the failure mode of an uncapped
      // count here is a route attempting to insert a million rows.
      const derived = validateTicketCount(fundraisingGoalCents, body.squarePrice);
      if (!derived.ok) {
        return NextResponse.json({ error: derived.error }, { status: 400 });
      }
      totalSquares = derived.count;

      const cashHoldDays = body.cashHoldDays ?? 7;
      if (!Number.isInteger(cashHoldDays) || cashHoldDays < 1 || cashHoldDays > 60) {
        return NextResponse.json(
          { error: "Cash hold window must be between 1 and 60 days." },
          { status: 400 }
        );
      }

      // Optional event block — v2 §5. Independent of every other date.
      if (body.hasEvent) {
        // Start time: the earlier occurrence — doors open at the first 1:30am.
        const startsAt = parseZoned(body.eventStartsAt, timezone, "earlier");
        if (!startsAt) {
          return NextResponse.json(
            { error: "An event date and time is required." },
            { status: 400 }
          );
        }
        // No attendance cap. One confirmed square mints one admission pass
        // (addendum v2.0 §1), so there is nothing to collect here.
        eventInput = {
          name: body.eventName?.trim() || null,
          startsAt,
          timezone,
          venue: body.eventVenue?.trim() || null,
        };
      }

      // At least one handle is required — without one there is nowhere to send
      // money, and direct payment is how most contributors will pay (§6C).
      const anyHandle = [
        body.hostVenmo,
        body.hostZelle,
        body.hostCashapp,
        body.hostPaypal,
      ].some((h) => h?.trim());
      if (!anyHandle) {
        return NextResponse.json(
          {
            error:
              "Add at least one way to receive payment — Venmo, Zelle, Cash App, or PayPal.",
          },
          { status: 400 }
        );
      }

      fundraiserOnlyData = {
        causeDescription: body.causeDescription?.trim() || null,
        campaignEndsAt,
        fundraisingGoalCents,
        timezone,
        earlyBirdPriceCents,
        earlyBirdEndsAt,
        ...entry,
        cashHoldDays,
        // Phase A: prizes are deferred and never accepted from the client.
        // prizePoolPercent stays at its 0 default — v2 §16.
        hostCutPercent: 0,
        // Direct payment is always on and never a toggle — §6C. No PIN: a PIN
        // exists so a host can hand a code to someone standing in front of
        // her, and on a fundraiser nobody is standing in front of her. The
        // contributor picks the method at checkout instead.
        cashModeEnabled: true,
        cashPin: null,
        cashLiabilityAccepted: true,
      };
    }

    // 7. Generate unique slug
    let slug = generateSlug();
    let attempts = 0;
    while (attempts < 5) {
      const existing = await prisma.board.findUnique({ where: { slug } });
      if (!existing) break;
      slug = generateSlug();
      attempts++;
    }

    // 8. Creation is free. One path, for every board type.
    const squarePriceCents = body.squarePrice;

    // --- Auto-enable cash mode for cash-only hosts ---


    const isCashHost = host.paymentPreference === "cash";


    const cashPin = isCashHost ? String(randomInt(1000, 10000)) : null;



     // Payout coordination fields
    const hostVenmo = body.hostVenmo?.trim() || null;
    const hostZelle = body.hostZelle?.trim() || null;
    const hostCashapp = body.hostCashapp?.trim() || null;
    const hostPaypal = body.hostPaypal?.trim() || null;
    const payoutVisibility = body.payoutVisibility === "pin_gated" ? "pin_gated" : "public";
    const requirePlayerPayout = body.requirePlayerPayout ?? false;


    const boardData = {
      hostId: host.id,
      gameName: body.gameName.trim(),
      squarePrice: squarePriceCents,
      totalSquares,
      slug,
      boardType,
      maxSquaresPerPlayer: 10,
      currency: "USD",
      hostPayoutResponsible: true,
      hostVenmo,
      hostZelle,
      hostCashapp,
      hostPaypal,
      // WHAT THIS BOARD ACCEPTS. Derived at creation from what the host just
      // supplied, which is the same set the backfill computed for existing
      // boards - so a board created today and one created last week describe
      // themselves the same way.
      //
      // CARD IS NOT DERIVED HERE, AND THAT IS THE POINT.
      //
      // This used to read `host.stripeChargesEnabled ? ["card"] : []`. Stripe
      // being connected means the host is ELIGIBLE to accept cards; it does not
      // mean every fundraiser they run should. Because it is a HOST-level flag,
      // connecting Stripe once turned card on for every board that host would
      // ever create, with nothing anywhere able to turn it off - which is how a
      // no-prize direct-payment fundraiser came to serve a live Stripe checkout
      // for $80 on 2026-09-08.
      //
      // Card is now an explicit choice, made in the fundraiser edit panel,
      // where the host can see it. A new board accepts none until they say so.
      //
      // THE DIRECT RAILS STAY DERIVED, deliberately. Creation already requires
      // at least one handle and collects all four, so a handle typed there IS
      // the host saying "accept this" - there is no second question to answer
      // and no ambiguity to resolve. The five-toggle creation UX is Track 2 and
      // is not being pulled forward.
      //
      // Game Day gets an empty array and nothing consults it.
      acceptedPaymentMethods:
        boardType === "fundraiser"
          ? ([
              ...(hostZelle ? ["zelle"] : []),
              ...(hostCashapp ? ["cashapp"] : []),
              ...(hostVenmo ? ["venmo"] : []),
              ...(hostPaypal ? ["paypal"] : []),
            ] as ("card" | "zelle" | "cashapp" | "venmo" | "paypal")[])
          : [],
      payoutVisibility: payoutVisibility as any,
      requirePlayerPayout,
      // Exactly one of these is populated. Game Day carries teams, sport,
      // periods, payout split and host cut; fundraiser carries none of them.
      ...gameOnlyData,
      ...fundraiserOnlyData,
      // Game Day only. Fundraiser boards set these above and must not receive
      // a PIN — §6C.
      ...(isCashHost && boardType === "game"
        ? {
            cashModeEnabled: true,
            cashPin: cashPin,
            cashLiabilityAccepted: true,
          }
        : {}),
    };

    // Event config is written in the same transaction as the board, on every
    // creation path. Terms lock at the first confirmed contribution
    // (invariant 16), which cannot happen before the board exists.
    async function createEvent(tx: Prisma.TransactionClient, boardId: string) {
      if (!eventInput) return;
      await tx.event.create({
        data: {
          boardId,
          name: eventInput.name,
          startsAt: eventInput.startsAt,
          timezone: eventInput.timezone,
          venue: eventInput.venue,
        },
      });
    }

    // --- Creation. One path, whatever the board is. ---
    //
    // DAALI DOES NOT CHARGE AN ORGANIZER TO CREATE ANYTHING. Game Day,
    // Fundraiser, Event and Volunteer are all free to create, so there is
    // nothing here to branch on: no balance to check, no credit to spend, no
    // pending_payment board, no delayed activation while someone pays us.
    //
    // This replaced four paths that differed only in how the organizer had
    // settled up. Fundraisers were already free (v2 §14), the platform owner
    // was exempt, a host with credits spent one, and a host without credits
    // got a board with no squares and 48 hours to pay for it. All four built
    // the same board; three of them just argued about it first.
    //
    // GAME DAY IS UNCHANGED BELOW THE CREATE. Squares, gameplay, scores,
    // winners and the money participants pay a host are untouched — this was
    // only ever about Daali charging the organizer.
    const board = await prisma.$transaction(async (tx) => {
      const newBoard = await tx.board.create({
        data: {
          ...boardData,
          status: "open",
          activatedAt: new Date(),
        },
      });

      await tx.square.createMany({
        data: Array.from({ length: totalSquares }, (_, i) => ({
          boardId: newBoard.boardId,
          position: i,
          paymentStatus: "open" as const,
        })),
      });

      // THE OWNER GRANT, IN THE SAME TRANSACTION AS THE BOARD.
      //
      // From the moment `requireBoardAccess` is the only way onto a board, a
      // board without this row is invisible to the person who just created
      // it. The migration backfilled every board that existed; this covers
      // every board that will exist. Same transaction, so a board can never
      // exist without its owner — not even briefly.
      //
      // `acceptedAt` is now: they did not accept an invitation, they made the
      // board, and their access begins with it. `invitedByHostId` stays null
      // for the same reason.
      await tx.boardCollaborator.create({
        data: {
          boardId: newBoard.boardId,
          hostId: host.id,
          role: "OWNER",
          status: "active",
          acceptedAt: new Date(),
        },
      });

      await createEvent(tx, newBoard.boardId);

      return newBoard;
    });

    return NextResponse.json({ boardId: board.boardId, slug: board.slug });
  } catch (error) {
    console.error("Board creation error:", error);
    return NextResponse.json(
      { error: "Failed to create board." },
      { status: 500 }
    );
  }
}
