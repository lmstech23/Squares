// ============================================================
// src/app/api/credits/purchase/route.ts
//
// Sells board credits via Stripe Checkout on the PLATFORM
// account. Supports single ($9) and triple ($24) packs.
//
// Player payments \u2192 Stripe Connect \u2192 host's account
// Credit purchases \u2192 Platform Stripe \u2192 your account
//
// Do not commingle these.
// ============================================================

import { NextResponse } from "next/server";
import Stripe from "stripe";
import { getHost } from "@/lib/auth";
import { CREDIT_PRICE_CENTS, TRIPLE_PRICE_CENTS } from "@/lib/constants";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

const PACKS = {
  single: {
    name: "Daali Board Credit",
    description: "1 board credit \u2014 create one board on Daali",
    unitAmount: CREDIT_PRICE_CENTS,
    quantity: 1,
    credits: 1,
  },
  triple: {
    name: "Daali Board Credits (3-Pack)",
    description: "3 board credits \u2014 create three boards on Daali",
    unitAmount: TRIPLE_PRICE_CENTS,
    quantity: 1,
    credits: 3,
  },
} as const;

type PackType = keyof typeof PACKS;

export async function POST(request: Request) {
  try {
    // 1. Authenticate host
    const host = await getHost();
    if (!host) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 }
      );
    }

    // 2. Parse body
    const body = await request.json().catch(() => ({}));
    const pack: PackType = body.pack === "triple" ? "triple" : "single";
    const boardId: string | null = body.boardId || null;

    const packConfig = PACKS[pack];

    // 3. Create Stripe Checkout session (platform account)
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: {
              name: packConfig.name,
              description: packConfig.description,
            },
            unit_amount: packConfig.unitAmount,
          },
          quantity: packConfig.quantity,
        },
      ],
      metadata: {
        hostId: host.id,
        type: "credit_purchase",
        credits: String(packConfig.credits),
        ...(boardId && { boardId }),
      },
      success_url: `${process.env.NEXT_PUBLIC_URL}/host/boards?credits=success`,
      cancel_url: boardId
        ? `${process.env.NEXT_PUBLIC_URL}/host/checkout?boardId=${boardId}`
        : `${process.env.NEXT_PUBLIC_URL}/host/boards`,
    });

    return NextResponse.json({ checkoutUrl: session.url });
  } catch (error) {
    console.error("Credit purchase error:", error);
    return NextResponse.json(
      { error: "Failed to create checkout session." },
      { status: 500 }
    );
  }
}
