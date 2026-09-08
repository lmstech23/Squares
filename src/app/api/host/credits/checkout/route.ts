import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { prisma } from "@/lib/prisma";
import { stripe } from "@/lib/stripe";

// Launch pricing: $9 for 1 credit, $24 for 3 credits
const BOARD_PACKS: Record<string, { credits: number; priceCents: number; label: string }> = {
  "1": { credits: 1, priceCents: 900, label: "1 Board Credit" },
  "3": { credits: 3, priceCents: 2400, label: "3 Board Credits" },
};

interface CheckoutBody {
  pack: string;       // "1" or "3"
  boardId?: string;   // if triggered from a pending_payment board
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

    // 2. Validate pack selection
    const body: CheckoutBody = await request.json();
    const pack = BOARD_PACKS[body.pack];

    if (!pack) {
      return NextResponse.json(
        { error: "Invalid pack. Choose '1' or '3'." },
        { status: 400 }
      );
    }

    // 3. If boardId provided, verify it's a pending_payment board owned by this host
    if (body.boardId) {
      const board = await prisma.board.findUnique({
        where: { boardId: body.boardId },
      });

      // AN OWNERSHIP CHECK, AND AN INTENTIONAL EXCEPTION TO THE GREP RULE.
      //
      // THIS ROUTE IS ACCOUNT-SCOPED, NOT BOARD-SCOPED. It sells the signed-in
      // host platform credits for their own account: the Stripe session is
      // platform-level with no connected account, `metadata.hostId` is this
      // host, and the webhook increments THEIR `boardCredits`. It runs perfectly
      // well with no `boardId` at all — that is the ordinary path, from the Buy
      // Credits button.
      //
      // `boardId` is an OPTIONAL TARGET, present only so the webhook can
      // auto-activate a board that is waiting to be paid for. The question it
      // asks is therefore literally ownership: "is this pending board mine?" It
      // is not "may this person act on this board", and a capability answer
      // would be the wrong kind of answer to the right question.
      //
      // It was briefly gated on `payout.configure`, which was wrong twice over:
      // that capability means where a board's CONTRIBUTIONS settle, and the
      // check sat inside `if (body.boardId)` — so it protected the rarer path
      // and left the common one ungated. Corrected 2026-09-08 by ruling.
      //
      // THE COLLABORATOR GREP RULE READS: no `Board.hostId` comparison may be
      // used as a SUBSTITUTE FOR BOARD CAPABILITY AUTHORIZATION. It does not
      // forbid an ownership check whose domain rule is ownership itself. A
      // future grep-to-zero pass must not replace this one; see
      // board-collaborators-addendum.md §3.
      if (!board || board.hostId !== host.id || board.status !== "pending_payment") {
        return NextResponse.json(
          { error: "Invalid pending board." },
          { status: 400 }
        );
      }
    }

    // 4. Create Stripe Checkout session (platform-level, no connected account)
    const baseUrl =
      process.env.NEXT_PUBLIC_URL ||
      request.headers.get("origin") ||
      "http://localhost:3000";

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: {
              name: pack.label,
              description: "Daali board credits",
            },
            unit_amount: pack.priceCents,
          },
          quantity: 1,
        },
      ],
      ...(host.email ? { customer_email: host.email } : {}),
      metadata: {
        type: "credit_purchase",
        hostId: host.id,
        credits: String(pack.credits),
        ...(body.boardId ? { boardId: body.boardId } : {}),
      },
      success_url: `${baseUrl}/host/boards?purchase=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/host/boards?purchase=cancelled`,
    });

    return NextResponse.json({ checkoutUrl: session.url });
  } catch (error) {
    console.error("Credit checkout error:", error);
    return NextResponse.json(
      { error: "Failed to create checkout session." },
      { status: 500 }
    );
  }
}
