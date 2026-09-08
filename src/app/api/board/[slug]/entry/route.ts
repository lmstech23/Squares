import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { stripe } from "@/lib/stripe";
import { baseUrlFromRequest } from "@/lib/base-url";
import { normalizePhone } from "@/lib/roster-identity";
import { createPendingCardContribution } from "@/lib/contributions";
import { acceptsCard } from "@/lib/accepted-payments";
import {
  quoteEntry,
  offersEntry,
  encodeEntryPasses,
  type EntryLine,
  type EntryTier,
} from "@/lib/entry-pricing";

// ============================================================
// CONTRIBUTOR: standalone Entry Ticket checkout.
//
//   choose tiers -> Contribution created pending (entryAmountCents)
//     -> one Checkout Session -> checkout.session.completed
//     -> confirmed, supporter activated, passes minted
//
// NO SQUARES MOVE and NO INVENTORY IS TOUCHED, exactly as a donation. Entry
// Tickets are admission, not a position on a board: a sold-out board can still
// sell them, and buying one is not a drawing entry.
//
// A SEPARATE ROUTE, for the reason /donate is separate. /api/checkout exists to
// lock squares and re-checks holds, caps and inventory at every step. Nothing
// here holds anything.
//
// CARD ONLY, deliberately. A direct-payment reservation would have to remember
// the priced tier lines between reservation and the host confirming receipt,
// and there is nowhere to remember them — passes are minted only inside the
// confirmation transaction, and no column holds an unconfirmed purchase's
// lines. Rather than invent one, this route sells for card and the direct
// payment question stays open.
//
// NO DONATE-ADMISSIONS TOGGLE — STANDALONE ENTRY NEVER DONATES ADMISSION.
// Someone buying admission for themselves is not donating it back. The grant is
// written with donateAdmissions false, no request field can set it, and
// `admission_grants_standalone_never_donates` makes any other value on a
// STANDALONE grant unrepresentable.
// ============================================================

export const runtime = "nodejs";

interface EntryBody {
  lines: { tier: string; quantity: number }[];
  buyerName: string;
  buyerEmail: string;
  buyerPhone?: string | null;
  /// The help checkbox. Absent on a board with no sign-up sheet, where the
  /// sheet does not render it.
  wantsToHelp?: boolean;
}

const TIER_LABEL: Record<EntryTier, string> = {
  CHILD: "Child admission",
  ADULT: "Adult admission",
};

export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  try {
    const { slug } = await params;
    const body: EntryBody = await request.json();

    const name = body.buyerName?.trim() ?? "";
    const email = body.buyerEmail?.trim().toLowerCase() ?? "";

    if (!name) {
      return NextResponse.json({ error: "Your name is required." }, { status: 400 });
    }
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json({ error: "A valid email is required." }, { status: 400 });
    }
    // The same mandatory pair the donation route enforces, validated with the
    // same function identity resolution uses. A pass has to reach a person.
    const phone = normalizePhone(body.buyerPhone);
    if (!phone) {
      return NextResponse.json(
        { error: "A valid phone number is required." },
        { status: 400 }
      );
    }

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
      include: {
        host: { select: { stripeAccountId: true, stripeChargesEnabled: true } },
        event: { select: { id: true } },
      },
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
    // An Entry Ticket is admission to an event. No event means nothing to admit
    // to, and nowhere for the supporter or the passes to live.
    if (!board.event) {
      return NextResponse.json({ error: "This board has no event." }, { status: 400 });
    }
    // A board that configured no entry prices is not selling entry. This is the
    // optionality guard that keeps the feature invisible to every other
    // fundraiser.
    if (!offersEntry(board)) {
      return NextResponse.json(
        { error: "Entry tickets are not available on this board." },
        { status: 400 }
      );
    }
    if (board.status !== "open") {
      return NextResponse.json(
        { error: "This board is no longer accepting contributions." },
        { status: 409 }
      );
    }
    if (board.campaignEndsAt && board.campaignEndsAt <= new Date()) {
      return NextResponse.json({ error: "This campaign has closed." }, { status: 409 });
    }

    // ONE QUOTE, taken once, at one instant. Everything downstream — the ledger
    // amount, the Stripe line items, and the passes minted on the way back — is
    // derived from this object and never re-priced.
    const quote = quoteEntry(board, lines, new Date());
    if (!quote.ok) {
      return NextResponse.json({ error: quote.error }, { status: 400 });
    }

    // CAPABILITY AND INTENT, both. A live Stripe account makes card possible;
    // the board's accepted list makes it intended. Before that list existed,
    // connecting Stripe for any reason turned card on for every fundraiser the
    // host owned.
    // The second clause is the type-level restatement of the first: acceptsCard
    // already requires a Stripe account, but it returns a boolean and cannot
    // narrow `stripeAccountId` for the session call below. Restated rather than
    // asserted past, so the compiler is checking the same thing the guard is.
    if (!acceptsCard(board, board.host) || !board.host.stripeAccountId) {
      return NextResponse.json(
        { error: "This board is not accepting card payments." },
        { status: 503 }
      );
    }

    // Ledger row first, session second — the donation route's ordering, for the
    // same reason: a failed session leaves a released row and no charge.
    const contribution = await prisma.$transaction((tx) =>
      createPendingCardContribution(tx, {
        boardId: board.boardId,
        squareAmountCents: 0,
        donationAmountCents: 0,
        entryAmountCents: quote.totalCents,
        // THE SAME `quote.passes` THE STRIPE METADATA IS BUILT FROM, two dozen
        // lines below. The ledger row and the session cannot share a
        // transaction - one is a database write, the other an external API call
        // - but they can share a SOURCE, and one array taken once is what stops
        // them disagreeing about how many tickets were bought.
        //
        // Recorded because nothing else here does. The direct-payment path has
        // always had `entry_reservation_lines.quantity`; this path carried its
        // quantity only in Stripe metadata, which the webhook decoded straight
        // into passes and this database never kept.
        entryTicketCount: quote.passes.length,
        contributorName: name,
        contributorEmail: email,
        contributorPhone: phone,
        // THE PENDING LEDGER ROW IS THE STORAGE. Unlike a reservation, this
        // path needs no new column: the contribution already carries
        // `wantsToHelp`, it is created here, and the webhook reads it back to
        // stamp the grant. Anything but an explicit `true` is false — an
        // unasked question and a declined one store the same value.
        wantsToHelp: body.wantsToHelp === true,
        // Nothing is held, so nothing expires — the donation reading exactly.
        holdExpiresAt: null,
      })
    );

    // Stripe line items are grouped for the receipt. The PASSES are what get
    // minted, and they travel separately in metadata: grouping the display is
    // presentation, grouping the passes would lose per-pass price.
    const grouped = new Map<string, { label: string; unit: number; qty: number }>();
    for (const pass of quote.passes) {
      const key = `${pass.tier}:${pass.pricePaidCents}`;
      const existing = grouped.get(key);
      if (existing) existing.qty += 1;
      else
        grouped.set(key, {
          label: TIER_LABEL[pass.tier],
          unit: pass.pricePaidCents,
          qty: 1,
        });
    }

    const baseUrl = baseUrlFromRequest(request);
    const boardUrl = `${baseUrl}/board/${board.slug}`;

    let session;
    try {
      session = await stripe.checkout.sessions.create(
        {
          mode: "payment",
          line_items: [...grouped.values()].map((g) => ({
            price_data: {
              currency: board.currency.toLowerCase(),
              product_data: { name: g.label, description: board.gameName },
              unit_amount: g.unit,
            },
            quantity: g.qty,
          })),
          customer_email: email,
          metadata: {
            boardId: board.boardId,
            contributionId: contribution.id,
            kind: "entry",
            // The priced passes, verbatim. See encodeEntryPasses for why they
            // are carried rather than re-quoted on the way back.
            entryPasses: encodeEntryPasses(quote.passes),
          },
          success_url: `${boardUrl}?entry=true&session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${boardUrl}?cancelled=true`,
        },
        { stripeAccount: board.host.stripeAccountId }
      );
    } catch (stripeError) {
      console.error("Entry Checkout creation failed:", stripeError);
      await prisma.contribution.updateMany({
        where: { id: contribution.id, status: "pending" },
        data: { status: "released", releasedAt: new Date() },
      });
      return NextResponse.json(
        { error: "Payment setup failed. Please try again." },
        { status: 502 }
      );
    }

    await prisma.contribution.update({
      where: { id: contribution.id },
      data: { checkoutSessionId: session.id },
    });

    return NextResponse.json({
      checkoutUrl: session.url,
      contributionId: contribution.id,
      amountCents: quote.totalCents,
      passCount: quote.passes.length,
    });
  } catch (error) {
    console.error("Entry purchase error:", error);
    return NextResponse.json(
      { error: "Something went wrong. Please try again." },
      { status: 500 }
    );
  }
}
