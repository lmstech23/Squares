import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { normalizePhone } from "@/lib/roster-identity";
import { randomUUID } from "crypto";
import { currentPriceCents } from "@/lib/claim-price";
import { prepareAdmission } from "@/lib/admission";

// ============================================================
// PLAYER: Self-serve cash reservation with PIN
//
// POST /api/board/[slug]/cash-reserve
// Body: { squareIds: string[], playerName: string, pin: string, ... }
//
// Reserves all selected squares. Skips any no longer available.
// Host must still tap "Mark Cash Received" to confirm each one.
// No auto-expiry — hosts release reservations at their discretion.
// ============================================================

interface CashReserveBody {
  squareIds: string[];
  playerName: string;
  pin: string;
  playerPhone: string;
  playerEmail?: string | null;
  playerPayoutMethod?: string | null;
  playerPayoutHandle?: string | null;
  smsOptIn?: boolean;
  /// Fundraiser only — "I'm not attending, donate my admissions" (v2 §6).
  donateAdmissions?: boolean;
  /// Fundraiser + event only. Intent, never entitlement — sign-up addendum SS3.
  wantsToHelp?: boolean;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  try {
    const body: CashReserveBody = await request.json();
    const { squareIds, playerName, pin } = body;

    if (!squareIds?.length || !playerName?.trim()) {
      return NextResponse.json(
        { error: "Square IDs and name are required." },
        { status: 400 }
      );
    }

    if (!body.playerPhone?.trim()) {
      return NextResponse.json(
        { error: "Phone number is required." },
        { status: 400 }
      );
    }

    const name = playerName.trim();
    const { slug } = await params;

    const board = await prisma.board.findUnique({
      where: { slug },
      select: {
        boardId: true,
        status: true,
        cashModeEnabled: true,
        cashPin: true,
        squarePrice: true,
        boardType: true,
        campaignEndsAt: true,
        earlyBirdPriceCents: true,
        earlyBirdEndsAt: true,
        event: { select: { id: true } },
      },
    });

    if (!board) {
      return NextResponse.json({ error: "Board not found." }, { status: 404 });
    }

    if (board.status !== "open") {
      return NextResponse.json(
        { error: "This board is no longer accepting squares." },
        { status: 409 }
      );
    }

    const isFundraiser = board.boardType === "fundraiser";

    // Fundraiser boards have no PIN — §6C. Direct payment is always on, and
    // the contributor picks the method at checkout instead of entering a code
    // the host would have to hand them in person.
    if (isFundraiser) {
      if (!board.cashModeEnabled) {
        return NextResponse.json(
          { error: "Direct payment is not available on this board." },
          { status: 403 }
        );
      }
    } else {
      if (!board.cashModeEnabled || !board.cashPin) {
        return NextResponse.json(
          { error: "Cash reservations are not enabled for this board." },
          { status: 403 }
        );
      }

      if (!pin?.trim() || pin.trim() !== board.cashPin) {
        return NextResponse.json({ error: "Incorrect PIN." }, { status: 403 });
      }
    }
    const email = body.playerEmail?.trim().toLowerCase() || null;

    // Campaigns close on a date, not a board status — invariant 6.
    if (isFundraiser && board.campaignEndsAt && board.campaignEndsAt <= new Date()) {
      return NextResponse.json(
        { error: "This campaign has closed." },
        { status: 409 }
      );
    }

    // FUNDRAISER: EMAIL AND PHONE ARE BOTH MANDATORY, on every board, with or
    // without an event. They are the two roster identity keys, and a
    // contribution that carries only one cannot be resolved to a person.
    // Previously email was required only when an event existed - the supporter
    // row needed it - which left an event-less fundraiser collecting
    // contributions nobody could be identified from.
    //
    // GAME DAY IS UNTOUCHED: neither branch below runs for it. Its phone check
    // above has always been unconditional; its email has never been required
    // and still is not.
    if (isFundraiser) {
      if (!email) {
        return NextResponse.json(
          { error: "An email address is required." },
          { status: 400 }
        );
      }
      // The same function identity uses, so nothing reaches resolveSupporter
      // that it would refuse.
      if (!normalizePhone(body.playerPhone)) {
        return NextResponse.json(
          { error: "A valid phone number is required." },
          { status: 400 }
        );
      }
    }

    // Price is fixed now, at reservation, and never recomputed — invariant 42.
    // A square reserved at the early price and confirmed a week later is still
    // owed the early price, and the host's cash panel must show that amount.
    const claimPriceCents = isFundraiser
      ? currentPriceCents(board)
      : board.squarePrice;

    const batchId = isFundraiser ? randomUUID() : null;

    const reserved: string[] = [];
    const unavailable: string[] = [];

    // Reserve each square — skip any that are no longer open.
    // Cash batches are deliberately NOT atomic (money doc §4): a parent who
    // reserves 3 and arrives with $100 must be resolvable to 2 confirmed and
    // 1 released, so each square is taken independently.
    for (const squareId of squareIds) {
      const { count } = await prisma.square.updateMany({
        where: {
          squareId,
          boardId: board.boardId,
          paymentStatus: "open",
        },
        data: {
          paymentStatus: "reserved_cash",
          paymentMethod: "cash",
          playerName: name,
          playerEmail: email,
          playerPhone: body.playerPhone?.trim() || null,
          playerPayoutMethod: (body.playerPayoutMethod as any) || null,
          playerPayoutHandle: body.playerPayoutHandle?.trim() || null,
          smsOptIn: body.smsOptIn ?? false,
          stripePaymentId: null,
          checkoutExpiresAt: null,
          releaseReason: null,
          ...(isFundraiser
            ? {
                pricePaidCents: claimPriceCents,
                batchId,
                claimedAt: new Date(),
              }
            : {}),
        },
      });

      if (count === 0) {
        unavailable.push(squareId);
      } else {
        reserved.push(squareId);
      }
    }

    // Admission preparation — addendum §4. Only once at least one square was
    // actually taken, so a reservation that lost every square to a race leaves
    // no supporter or grant behind.
    if (isFundraiser && board.event && batchId && reserved.length > 0 && email) {
      await prisma.$transaction(async (tx) => {
        await prepareAdmission(
          tx,
          board.event!.id,
          batchId,
          { name, email, phone: body.playerPhone },
          body.donateAdmissions ?? false,
          body.wantsToHelp ?? false
        );
      });
    }

    if (reserved.length === 0) {
      return NextResponse.json(
        { error: "None of the selected squares are available." },
        { status: 409 }
      );
    }

    return NextResponse.json({
      success: true,
      reserved,
      unavailable,
      playerName: name,
      
      message:
        unavailable.length > 0
          ? `${reserved.length} square(s) reserved. ${unavailable.length} were already taken.`
          : "Squares reserved! Send payment to your host — your square locks once host confirms.",
    });
  } catch (error) {
    console.error("Cash reserve error:", error);
    return NextResponse.json(
      { error: "Something went wrong. Please try again." },
      { status: 500 }
    );
  }
}
