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
              description: "Squares board credits",
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
