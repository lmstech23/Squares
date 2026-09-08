import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { normalizePhone } from "@/lib/roster-identity";
import { quoteEntry, offersEntry, type EntryLine, type EntryTier } from "@/lib/entry-pricing";
import { generateReferenceCode } from "@/lib/reference-code";
import { acceptedRails, RAIL_LABEL, type DirectRail } from "@/lib/accepted-payments";

// ============================================================
// CONTRIBUTOR: reserve Entry Tickets, pay the host directly.
//
//   choose tiers -> EntryReservation created pending, price LOCKED
//     -> contributor sends money by Zelle / Venmo / Cash App / PayPal
//     -> host confirms receipt (or releases) per tier line
//     -> only then: Contribution, supporter, grant, passes
//
// NOTHING IS CREATED HERE BUT THE RESERVATION. No Contribution, no
// EventSupporter, no AdmissionGrant, no AdmissionPass, no Square. A reservation
// is a statement of intent to send money through a rail Daali cannot see; until
// the host says it arrived, it is not money and nothing may depend on it.
//
// Deferring the supporter to confirmation is the standalone entry model
// unchanged — /entry writes nothing but a ledger row either, and mints
// everything inside the confirming transaction. A `pending` supporter created
// for a reservation nobody ever pays is a row implying an attendee, and the
// supporter table feeds the roster and helper eligibility.
//
// NO HOLD, NO EXPIRY, NO COUNTDOWN. A square hold protects exclusive
// inventory; an entry ticket blocks nobody, so there is nothing to hold and
// nothing to sweep. Close is the only thing that ever disposes of an
// outstanding reservation — CLOSE-PROCEDURE.md, invariant 114.
//
// THE PRICE IS LOCKED HERE AND NEVER RE-QUOTED. A reservation taken before the
// early-bird cutoff and paid a week after it is still owed the early price.
// `unitPriceCents` and `priceBasis` are written now, and confirmation reads
// them rather than asking what the price is today.
// ============================================================

export const runtime = "nodejs";

type Rail = DirectRail;

interface ReserveBody {
  lines: { tier: string; quantity: number }[];
  buyerName: string;
  buyerEmail: string;
  buyerPhone?: string | null;
  paymentRail: string;
  /// Optional donation on top, sent in the same transfer. Not a tier line.
  donationAmountCents?: number;
  /// The help checkbox. Absent on a board with no sign-up sheet, where the
  /// panel does not render it.
  wantsToHelp?: boolean;
}

const RAILS: Rail[] = ["zelle", "cashapp", "venmo", "paypal"];

/** Which handle a rail is sent to. One map, so a new rail cannot be half-added. */
const HANDLE_FOR: Record<Rail, "hostZelle" | "hostCashapp" | "hostVenmo" | "hostPaypal"> = {
  zelle: "hostZelle",
  cashapp: "hostCashapp",
  venmo: "hostVenmo",
  paypal: "hostPaypal",
};

/** Codes collide at 1 in 33.5 million per board. Five attempts is generous. */
const CODE_ATTEMPTS = 5;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  try {
    const { slug } = await params;
    const body: ReserveBody = await request.json();

    const name = body.buyerName?.trim() ?? "";
    const email = body.buyerEmail?.trim().toLowerCase() ?? "";

    if (!name) {
      return NextResponse.json({ error: "Your name is required." }, { status: 400 });
    }
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json({ error: "A valid email is required." }, { status: 400 });
    }
    // Both identity keys, as every entry path requires. A reservation the host
    // cannot contact is one they cannot reconcile, and the CHECK on the table
    // refuses a blank either way.
    const phone = normalizePhone(body.buyerPhone);
    if (!phone) {
      return NextResponse.json(
        { error: "A valid phone number is required." },
        { status: 400 }
      );
    }

    const rail = RAILS.find((r) => r === body.paymentRail);
    if (!rail) {
      return NextResponse.json({ error: "Choose how you will pay." }, { status: 400 });
    }

    // A DONATION ON TOP, IN THE SAME TRANSFER. One reference code, one payment,
    // one host action. No floor: the $5 card minimum exists because Stripe's
    // per-transaction cost eats a small gift, and a direct payment has no
    // processor - the same reasoning the cash donation path uses.
    const donationAmountCents = Math.trunc(Number(body.donationAmountCents ?? 0));
    if (!Number.isFinite(donationAmountCents) || donationAmountCents < 0) {
      return NextResponse.json(
        { error: "A donation cannot be negative." },
        { status: 400 }
      );
    }

    // COERCED, NOT VALIDATED. Anything other than an explicit `true` is false.
    // There is nothing to reject here: an absent answer and a declined one are
    // the same stored value, exactly as they are on the grant and the ledger.
    // Interest claims nothing (invariant 36), so a spoofed `true` reserves no
    // slot and grants no authority — it shows one person a sign-up link.
    const wantsToHelp = body.wantsToHelp === true;

    const rawLines = Array.isArray(body.lines) ? body.lines : [];
    const lines: EntryLine[] = [];
    for (const line of rawLines) {
      if (line?.tier !== "CHILD" && line?.tier !== "ADULT") {
        return NextResponse.json({ error: "Unknown ticket type." }, { status: 400 });
      }
      lines.push({ tier: line.tier, quantity: Math.trunc(Number(line.quantity) || 0) });
    }

    const board = await prisma.board.findUnique({
      where: { slug },
      include: { event: { select: { id: true } } },
    });

    if (!board) {
      return NextResponse.json({ error: "Board not found." }, { status: 404 });
    }
    if (board.boardType !== "fundraiser") {
      return NextResponse.json(
        { error: "Entry tickets are not available on this board." },
        { status: 400 }
      );
    }
    if (!board.event) {
      return NextResponse.json({ error: "This board has no event." }, { status: 400 });
    }
    if (!offersEntry(board)) {
      return NextResponse.json(
        { error: "Entry tickets are not available on this board." },
        { status: 400 }
      );
    }
    // BOTH GUARDS, as every purchase path carries both. Status stops sales the
    // moment the board enters `closing`, independently of the date; the date
    // stops them even if a close has not run yet.
    if (board.status !== "open") {
      return NextResponse.json(
        { error: "This board is no longer accepting contributions." },
        { status: 409 }
      );
    }
    if (board.campaignEndsAt && board.campaignEndsAt <= new Date()) {
      return NextResponse.json({ error: "This campaign has closed." }, { status: 409 });
    }

    if (!board.cashModeEnabled) {
      return NextResponse.json(
        { error: "Direct payment is not enabled for this board." },
        { status: 403 }
      );
    }
    // THE RAIL MUST BE BOTH ACCEPTED AND POSSIBLE. `acceptedRails` requires the
    // board to list it AND the handle to exist, so a handle the host has stored
    // but paused is not an offer. Reaching this means a stale form.
    if (!acceptedRails(board).includes(rail)) {
      return NextResponse.json(
        { error: `This board is not accepting ${RAIL_LABEL[rail]}.` },
        { status: 503 }
      );
    }
    const handle = board[HANDLE_FOR[rail]]!;

    // ONE QUOTE, TAKEN ONCE. Everything persisted below derives from it, and
    // confirmation reads what was stored rather than asking again.
    const quote = quoteEntry(board, lines, new Date());
    if (!quote.ok) {
      return NextResponse.json({ error: quote.error }, { status: 400 });
    }

    // THE EXPANSION SEAM, flagged here because this is where it is created.
    //
    // Confirmation has to turn these grouped lines BACK into per-pass prices
    // and counts before calling confirmEntryPurchase, which asserts that the
    // passes sum to the contribution amount. A grouped line that expands to the
    // wrong quantity, or to the right quantity at today's price instead of
    // `unitPriceCents`, mints the wrong passes and the assertion either fires
    // on a correct purchase or passes on an incorrect one. When the host
    // confirmation path is built it needs explicit regression coverage of that
    // expansion, not just of the confirmation.
    //
    // Grouped into tier lines — the resolution unit (invariant 114). `quoteEntry`
    // returns one entry PER PASS because the card path stores a price per pass;
    // a reservation stores a price per line and a quantity, because the host
    // confirms "two adults arrived", not "pass #3 arrived".
    const grouped = new Map<
      string,
      { tier: EntryTier; priceBasis: "FLAT" | "EARLY" | "REGULAR"; unitPriceCents: number; quantity: number }
    >();
    for (const p of quote.passes) {
      const key = `${p.tier}:${p.priceBasis}`;
      const existing = grouped.get(key);
      if (existing) existing.quantity += 1;
      else
        grouped.set(key, {
          tier: p.tier,
          priceBasis: p.priceBasis,
          unitPriceCents: p.pricePaidCents,
          quantity: 1,
        });
    }
    const lineRows = [...grouped.values()];

    // COLLISION RETRY AROUND THE WHOLE TRANSACTION, not around a pre-check.
    //
    // Checking whether a code is free and then inserting it is a race; the
    // unique index is the only thing that actually decides. And a P2002 ABORTS
    // THE TRANSACTION it fires in — proven in this codebase — so the retry has
    // to discard the transaction and start a new one rather than catch and
    // continue inside it.
    let created: {
      id: string;
      referenceCode: string;
      donationAmountCents: number;
    } | null = null;
    for (let attempt = 0; attempt < CODE_ATTEMPTS && !created; attempt++) {
      const referenceCode = generateReferenceCode();
      try {
        created = await prisma.$transaction(async (tx) => {
          const reservation = await tx.entryReservation.create({
            data: {
              boardId: board.boardId,
              eventId: board.event!.id,
              referenceCode,
              contributorName: name,
              contributorEmail: email,
              contributorPhone: phone,
              paymentRail: rail,
              donationAmountCents,
              // Held here until confirmation, which is where the grant that
              // actually carries it is created.
              wantsToHelp,
              // `pending` until the host confirms or releases. Nothing else may
              // move it, and no sweep will.
              status: "pending",
            },
            select: { id: true, referenceCode: true, donationAmountCents: true },
          });

          await tx.entryReservationLine.createMany({
            data: lineRows.map((l) => ({
              reservationId: reservation.id,
              tier: l.tier,
              priceBasis: l.priceBasis,
              unitPriceCents: l.unitPriceCents,
              quantity: l.quantity,
              // quantityConfirmed defaults to 0 and contributionId stays null:
              // no money has arrived and no ledger row exists yet.
            })),
          });

          return reservation;
        });
      } catch (err) {
        const collision =
          err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
        if (!collision) throw err;
        // Next attempt draws a new code. Nothing was written.
      }
    }

    if (!created) {
      console.error(
        `Entry reservation: ${CODE_ATTEMPTS} reference code collisions on board ${board.boardId}`
      );
      return NextResponse.json(
        { error: "Something went wrong. Please try again." },
        { status: 500 }
      );
    }

    return NextResponse.json({
      reservationId: created.id,
      referenceCode: created.referenceCode,
      // Three numbers, because a single total cannot be checked against what
      // was chosen. The screens show tickets, donation and total.
      ticketCents: quote.totalCents,
      donationCents: created.donationAmountCents,
      totalCents: quote.totalCents + created.donationAmountCents,
      paymentRail: rail,
      railLabel: RAIL_LABEL[rail],
      handle,
      lines: lineRows.map((l) => ({
        tier: l.tier,
        priceBasis: l.priceBasis,
        unitPriceCents: l.unitPriceCents,
        quantity: l.quantity,
      })),
    });
  } catch (error) {
    console.error("Entry reservation error:", error);
    return NextResponse.json(
      { error: "Something went wrong. Please try again." },
      { status: 500 }
    );
  }
}
