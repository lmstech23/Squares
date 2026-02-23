// ============================================================
// src/app/api/credits/purchase/route.ts
//
// Sells board credits via Stripe Checkout on the PLATFORM
// account. This is completely separate from the player-facing
// Stripe Connect flow.
//
// Player payments → Stripe Connect → host's account
// Credit purchases → Platform Stripe → your account
//
// Do not commingle these.
// ============================================================

import { NextResponse } from "next/server";
import Stripe from "stripe";
import { getHost } from "@/lib/auth";
import { CREDIT_PRICE_CENTS } from "@/lib/constants";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

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

    // 2. Create Stripe Checkout session (platform account)
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: {
              name: "Daali Board Credit",
              description: "1 board credit — create one board on Daali",
            },
            unit_amount: CREDIT_PRICE_CENTS,
          },
          quantity: 1,
        },
      ],
      metadata: {
        hostId: host.id,
        type: "credit_purchase",
      },
      success_url: `${process.env.NEXT_PUBLIC_URL}/dashboard?credits=success`,
      cancel_url: `${process.env.NEXT_PUBLIC_URL}/dashboard?credits=cancelled`,
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
