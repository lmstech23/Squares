"""
Fix checkout flow — adds pack tiers, creates squares on activation,
and addresses all review feedback.

Run from project root: python fix-checkout-tiers.py
(Run fix-checkout-flow.py FIRST)
"""
import os

# ============================================================
# 1. Add triple-pack constants
# ============================================================
CONSTANTS_FILE = "src/lib/constants.ts"

with open(CONSTANTS_FILE, "r", encoding="utf-8") as f:
    constants = f.read()

if "TRIPLE_PRICE_CENTS" not in constants:
    # Anchor on the CREDIT_PRICE_DISPLAY line
    target = 'export const CREDIT_PRICE_DISPLAY = "$9";'
    if target in constants:
        # Find the full line (including any comment)
        lines = constants.split("\n")
        for i, line in enumerate(lines):
            if target in line:
                lines.insert(i + 1, "")
                lines.insert(i + 2, 'export const TRIPLE_PRICE_CENTS = 2400;     // $24 during tournament \u2192 $45 after')
                lines.insert(i + 3, 'export const TRIPLE_PRICE_DISPLAY = "$24";   // "$24" during tournament \u2192 "$45" after')
                break
        constants = "\n".join(lines)
        with open(CONSTANTS_FILE, "w", encoding="utf-8") as f:
            f.write(constants)
        print("\u2713 constants.ts \u2014 added TRIPLE_PRICE_CENTS / TRIPLE_PRICE_DISPLAY")
    else:
        print("\u26a0 constants.ts \u2014 could not find CREDIT_PRICE_DISPLAY anchor. Add manually:")
        print('  export const TRIPLE_PRICE_CENTS = 2400;')
        print('  export const TRIPLE_PRICE_DISPLAY = "$24";')
else:
    print("\u2298 constants.ts \u2014 triple constants already exist")

# ============================================================
# 2. Rewrite /api/credits/purchase to support packs
# ============================================================
PURCHASE_FILE = "src/app/api/credits/purchase/route.ts"

PURCHASE_CONTENT = '''// ============================================================
// src/app/api/credits/purchase/route.ts
//
// Sells board credits via Stripe Checkout on the PLATFORM
// account. Supports single ($9) and triple ($24) packs.
//
// Player payments \\u2192 Stripe Connect \\u2192 host's account
// Credit purchases \\u2192 Platform Stripe \\u2192 your account
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
    description: "1 board credit \\u2014 create one board on Daali",
    unitAmount: CREDIT_PRICE_CENTS,
    quantity: 1,
    credits: 1,
  },
  triple: {
    name: "Daali Board Credits (3-Pack)",
    description: "3 board credits \\u2014 create three boards on Daali",
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
'''

with open(PURCHASE_FILE, "w", encoding="utf-8") as f:
    f.write(PURCHASE_CONTENT)
print("\u2713 /api/credits/purchase \u2014 supports single + triple packs")

# ============================================================
# 3. Rewrite checkout-buttons.tsx with both tiers + fallback
# ============================================================
BUTTONS_FILE = "src/app/host/checkout/checkout-buttons.tsx"

BUTTONS_CONTENT = '''"use client";

import { useState } from "react";

interface Props {
  boardId: string;
}

export default function CheckoutButtons({ boardId }: Props) {
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handlePurchase(pack: "single" | "triple") {
    setLoading(pack);
    setError(null);

    try {
      const res = await fetch("/api/credits/purchase", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ boardId, pack }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Something went wrong");
        setLoading(null);
        return;
      }

      if (data.checkoutUrl) {
        window.location.href = data.checkoutUrl;
      } else {
        setError("Missing checkout URL");
        setLoading(null);
      }
    } catch {
      setError("Failed to start checkout");
      setLoading(null);
    }
  }

  return (
    <div>
      <div className="space-y-3">
        <button
          onClick={() => handlePurchase("single")}
          disabled={loading !== null}
          className="w-full rounded-lg bg-green-600 text-white py-3 text-sm font-medium hover:bg-green-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {loading === "single" ? "Redirecting to Stripe\\u2026" : "1 Board \\u2014 $9"}
        </button>

        <button
          onClick={() => handlePurchase("triple")}
          disabled={loading !== null}
          className="w-full rounded-lg bg-purple-600 text-white py-3 text-sm font-medium hover:bg-purple-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {loading === "triple" ? "Redirecting to Stripe\\u2026" : "3 Boards \\u2014 $24"}
        </button>
      </div>

      <p className="text-xs text-gray-600 text-center mt-3">
        1 credit activates this board. Extra credits are saved for future boards.
      </p>

      {error && (
        <div className="rounded-lg border border-red-900/50 bg-red-950/30 p-3 mt-4">
          <p className="text-sm text-red-300">{error}</p>
        </div>
      )}
    </div>
  );
}
'''

with open(BUTTONS_FILE, "w", encoding="utf-8") as f:
    f.write(BUTTONS_CONTENT)
print("\u2713 checkout-buttons.tsx \u2014 both tiers + checkoutUrl fallback")

# ============================================================
# 4. Update checkout page.tsx to remove priceDisplay prop
# ============================================================
PAGE_FILE = "src/app/host/checkout/page.tsx"

with open(PAGE_FILE, "r", encoding="utf-8") as f:
    page = f.read()

page = page.replace(
    'import { CREDIT_PRICE_CENTS } from "@/lib/constants";\nimport CheckoutButtons from "./checkout-buttons";',
    'import CheckoutButtons from "./checkout-buttons";'
)
page = page.replace(
    '\n  const priceDisplay = (CREDIT_PRICE_CENTS / 100).toFixed(0);\n',
    '\n'
)
page = page.replace(
    '<CheckoutButtons boardId={boardId} priceDisplay={priceDisplay} />',
    '<CheckoutButtons boardId={boardId} />'
)

with open(PAGE_FILE, "w", encoding="utf-8") as f:
    f.write(page)
print("\u2713 checkout page.tsx \u2014 removed priceDisplay prop")

# ============================================================
# 5. Rewrite platform webhook — multi-credit + square creation
# ============================================================
WEBHOOK_FILE = "src/app/api/webhooks/stripe-platform/route.ts"

WEBHOOK_CONTENT = '''// ============================================================
// src/app/api/webhooks/stripe-platform/route.ts
//
// PLATFORM-ONLY webhook \\u2014 handles credit purchases.
//
// Why separate?
// Player square payments go through Stripe Connect (host's account).
// Credit purchases go through the PLATFORM Stripe account (your account).
// Different Stripe accounts = different webhook endpoints = different
// signing secrets. Commingling them causes signature verification failures.
//
// This endpoint uses STRIPE_PLATFORM_WEBHOOK_SECRET.
// The existing /api/webhooks/stripe uses STRIPE_WEBHOOK_SECRET (Connect).
// ============================================================

import { NextResponse } from "next/server";
import { stripe } from "@/lib/stripe";
import { prisma } from "@/lib/prisma";
import Stripe from "stripe";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const body = await request.text();
  const signature = request.headers.get("stripe-signature");

  if (!signature) {
    return NextResponse.json(
      { error: "Missing stripe-signature header" },
      { status: 400 }
    );
  }

  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(
      body,
      signature,
      process.env.STRIPE_PLATFORM_WEBHOOK_SECRET!
    );
  } catch (err) {
    console.error("Platform webhook signature verification failed:", err);
    return NextResponse.json(
      { error: "Invalid signature" },
      { status: 400 }
    );
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;

        // Safety check \\u2014 only process credit purchases here
        if (session.metadata?.type !== "credit_purchase") {
          console.warn(
            `Platform webhook received non-credit checkout: ${session.id}`
          );
          break;
        }

        await handleCreditPurchase(session);
        break;
      }

      default:
        // Platform webhook only cares about credit purchases
        break;
    }
  } catch (err) {
    console.error(`Error handling ${event.type}:`, err);
    return NextResponse.json(
      { error: "Webhook handler failed" },
      { status: 500 }
    );
  }

  return NextResponse.json({ received: true });
}

// ============================================================
// HANDLER
// ============================================================

/**
 * Credit purchase completed \\u2014 add board credits to host.
 *
 * Guards:
 * 1. Idempotency via CreditTransaction.stripeSessionId check
 * 2. Atomic: increment + log in one transaction
 * 3. Board activation creates 100 squares (Path 3 defers this)
 *
 * Math:
 *   Single pack: +1 credit, -1 for board = 0 remaining
 *   Triple pack: +3 credits, -1 for board = 2 remaining
 */
async function handleCreditPurchase(session: Stripe.Checkout.Session) {
  const hostId = session.metadata?.hostId;
  const creditsToGrant = parseInt(session.metadata?.credits || "1", 10);

  if (!hostId) {
    console.error("Credit purchase webhook missing hostId in metadata");
    return;
  }

  // Idempotency: already processed?
  const existing = await prisma.creditTransaction.findFirst({
    where: { stripeSessionId: session.id },
  });

  if (existing) {
    console.log(`Credit purchase already processed: ${session.id}`);
    return;
  }

  // Add credits + log in one transaction
  await prisma.$transaction(async (tx) => {
    const updatedHost = await tx.host.update({
      where: { id: hostId },
      data: { boardCredits: { increment: creditsToGrant } },
    });

    await tx.creditTransaction.create({
      data: {
        hostId,
        type: "purchase",
        amount: creditsToGrant,
        balanceAfter: updatedHost.boardCredits,
        stripeSessionId: session.id,
      },
    });
  });

  // \\u2500\\u2500 Activate pending board if one exists \\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500
  // If the host had a pending_payment board, flip it to open,
  // create 100 squares (Path 3 deferred square creation), and
  // deduct 1 credit.
  const pendingBoard = await prisma.board.findFirst({
    where: { hostId, status: "pending_payment" },
    orderBy: { createdAt: "desc" },
  });

  if (pendingBoard) {
    await prisma.$transaction(async (tx) => {
      // Deduct 1 credit for this board
      const host = await tx.host.update({
        where: { id: hostId, boardCredits: { gt: 0 } },
        data: { boardCredits: { decrement: 1 } },
      });

      // Activate the board
      await tx.board.update({
        where: { boardId: pendingBoard.boardId },
        data: {
          status: "open",
          pendingExpiresAt: null,
          activatedAt: new Date(),
        },
      });

      // Create 100 squares \\u2014 Path 3 deferred this until payment
      await tx.square.createMany({
        data: Array.from({ length: 100 }, (_, i) => ({
          boardId: pendingBoard.boardId,
          position: i,
          paymentStatus: "open" as const,
        })),
      });

      // Log the credit consumption
      await tx.creditTransaction.create({
        data: {
          hostId,
          type: "board_created",
          amount: -1,
          balanceAfter: host.boardCredits,
          boardId: pendingBoard.boardId,
        },
      });
    });

    console.log(
      `Credit purchased (${creditsToGrant}) + board activated: host=${hostId}, board=${pendingBoard.boardId}, session=${session.id}`
    );
  } else {
    console.log(
      `Credit purchased (${creditsToGrant}, no pending board): host=${hostId}, session=${session.id}`
    );
  }
}
'''

with open(WEBHOOK_FILE, "w", encoding="utf-8") as f:
    f.write(WEBHOOK_CONTENT)
print("\u2713 platform webhook \u2014 multi-credit + creates 100 squares on activation")

print()
print("Done! Changes:")
print("  1. constants.ts \\u2014 TRIPLE_PRICE_CENTS + TRIPLE_PRICE_DISPLAY")
print("  2. /api/credits/purchase \\u2014 single ($9) + triple ($24) packs")
print("  3. checkout-buttons.tsx \\u2014 both tier buttons + fallback fix")
print("  4. checkout page.tsx \\u2014 cleaned up props")
print("  5. platform webhook \\u2014 grants N credits + creates 100 squares on activation")
print()
print("Math check:")
print("  Single: host buys 1 credit (+1), board activates (-1) = 0 remaining")
print("  Triple: host buys 3 credits (+3), board activates (-1) = 2 remaining")
print()
print("Next:")
print('  git add -A && git commit -m "feat: multi-tier checkout + square creation" && npx vercel --prod')
