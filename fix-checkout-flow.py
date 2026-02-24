"""
Fix checkout redirect flow.
Run from project root: python fix-checkout-flow.py
"""
import os

# ============================================================
# 1. Fix form.tsx — follow redirectTo instead of /host/boards
# ============================================================
FORM_FILE = "src/app/host/boards/new/form.tsx"

with open(FORM_FILE, "r", encoding="utf-8") as f:
    form = f.read()

old_402 = """      // Pending board created — redirect to dashboard to complete payment
      if (res.status === 402 && data.boardId) {
        router.push("/host/boards");
        return;
      }

      // Already have a pending board — redirect to dashboard
      if (res.status === 409 && data.pendingBoardId) {
        router.push("/host/boards");
        return;
      }"""

new_402 = """      // Payment required — follow server's redirect
      if (data.redirectTo) {
        router.push(data.redirectTo);
        return;
      }"""

if old_402 in form:
    form = form.replace(old_402, new_402)
    with open(FORM_FILE, "w", encoding="utf-8") as f:
        f.write(form)
    print("✓ form.tsx — redirects to checkout now")
else:
    print("⚠ form.tsx — could not find 402/409 block to replace")

# ============================================================
# 2. Fix /api/boards/route.ts — add redirectTo to 402 and 409
# ============================================================
API_FILE = "src/app/api/boards/route.ts"

with open(API_FILE, "r", encoding="utf-8") as f:
    api = f.read()

# Fix 409
old_409 = """      return NextResponse.json(
        {
          error: 'You have a pending board awaiting payment. Complete or cancel it first.',
          pendingBoardId: existingPending.boardId,
        },
        { status: 409 }
      );"""

new_409 = """      return NextResponse.json(
        {
          error: 'You have a pending board awaiting payment. Complete or cancel it first.',
          pendingBoardId: existingPending.boardId,
          redirectTo: \`/host/checkout?boardId=\${existingPending.boardId}\`,
        },
        { status: 409 }
      );"""

if old_409 in api:
    api = api.replace(old_409, new_409)
    print("✓ /api/boards — added redirectTo to 409")
else:
    print("⚠ /api/boards — could not find 409 block")

# Fix 402
old_402_api = """    return NextResponse.json(
      {
        boardId: board.boardId,
        slug: board.slug,
        status: "pending_payment",
        pendingExpiresAt: board.pendingExpiresAt,
      },
      { status: 402 }
    );"""

new_402_api = """    return NextResponse.json(
      {
        boardId: board.boardId,
        slug: board.slug,
        status: "pending_payment",
        pendingExpiresAt: board.pendingExpiresAt,
        redirectTo: \`/host/checkout?boardId=\${board.boardId}\`,
      },
      { status: 402 }
    );"""

if old_402_api in api:
    api = api.replace(old_402_api, new_402_api)
    print("✓ /api/boards — added redirectTo to 402")
else:
    print("⚠ /api/boards — could not find 402 block")

with open(API_FILE, "w", encoding="utf-8") as f:
    f.write(api)

# ============================================================
# 3. Fix /api/credits/purchase — accept boardId, fix URLs
# ============================================================
PURCHASE_FILE = "src/app/api/credits/purchase/route.ts"

PURCHASE_CONTENT = '''// ============================================================
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

    // 2. Parse optional boardId (pending board that triggered checkout)
    const body = await request.json().catch(() => ({}));
    const boardId = body.boardId || null;

    // 3. Create Stripe Checkout session (platform account)
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
print("✓ /api/credits/purchase — accepts boardId, fixed URLs")

# ============================================================
# 4. Create /host/checkout/page.tsx
# ============================================================
CHECKOUT_DIR = "src/app/host/checkout"
os.makedirs(CHECKOUT_DIR, exist_ok=True)

CHECKOUT_PAGE = '''import { redirect } from "next/navigation";
import { getHost } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { CREDIT_PRICE_CENTS } from "@/lib/constants";
import CheckoutButtons from "./checkout-buttons";

interface Props {
  searchParams: Promise<{ boardId?: string }>;
}

export default async function CheckoutPage({ searchParams }: Props) {
  const host = await getHost();
  if (!host) redirect("/login");

  const params = await searchParams;
  const boardId = params.boardId;

  // If no boardId, send to dashboard
  if (!boardId) redirect("/host/boards");

  // Verify the board exists, belongs to host, and is pending
  const board = await prisma.board.findFirst({
    where: {
      boardId,
      hostId: host.id,
      status: "pending_payment",
    },
  });

  if (!board) redirect("/host/boards");

  const priceDisplay = (CREDIT_PRICE_CENTS / 100).toFixed(0);

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <div className="max-w-md mx-auto px-4 py-16">
        <h1 className="text-xl font-bold mb-2">Complete Your Board</h1>
        <p className="text-sm text-gray-400 mb-8">
          Purchase a board credit to activate{" "}
          <span className="text-white font-medium">{board.gameName}</span>.
        </p>

        <div className="rounded-lg border border-gray-800 bg-gray-900 p-5 mb-6">
          <div className="flex items-center justify-between mb-4">
            <span className="text-sm text-gray-400">Board</span>
            <span className="text-sm font-medium">{board.gameName}</span>
          </div>
          <div className="flex items-center justify-between mb-4">
            <span className="text-sm text-gray-400">Square price</span>
            <span className="text-sm font-medium">
              ${(board.squarePrice / 100).toFixed(0)}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm text-gray-400">Status</span>
            <span className="text-xs font-medium text-yellow-400 bg-yellow-400/10 px-2 py-0.5 rounded">
              Awaiting payment
            </span>
          </div>
        </div>

        <CheckoutButtons boardId={boardId} priceDisplay={priceDisplay} />

        <p className="text-xs text-gray-600 text-center mt-6">
          Board expires if not activated within 48 hours.
        </p>
      </div>
    </div>
  );
}
'''

with open(os.path.join(CHECKOUT_DIR, "page.tsx"), "w", encoding="utf-8") as f:
    f.write(CHECKOUT_PAGE)
print("✓ Created /host/checkout/page.tsx")

# ============================================================
# 5. Create checkout-buttons.tsx (client component)
# ============================================================

CHECKOUT_BUTTONS = '''"use client";

import { useState } from "react";

interface Props {
  boardId: string;
  priceDisplay: string;
}

export default function CheckoutButtons({ boardId, priceDisplay }: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handlePurchase() {
    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/credits/purchase", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ boardId }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Something went wrong");
        setLoading(false);
        return;
      }

      if (data.checkoutUrl) {
        window.location.href = data.checkoutUrl;
      }
    } catch {
      setError("Failed to start checkout");
      setLoading(false);
    }
  }

  return (
    <div>
      <button
        onClick={handlePurchase}
        disabled={loading}
        className="w-full rounded-lg bg-green-600 text-white py-3 text-sm font-medium hover:bg-green-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        {loading ? "Redirecting to Stripe…" : `Buy 1 Board Credit — $${priceDisplay}`}
      </button>

      {error && (
        <div className="rounded-lg border border-red-900/50 bg-red-950/30 p-3 mt-4">
          <p className="text-sm text-red-300">{error}</p>
        </div>
      )}
    </div>
  );
}
'''

with open(os.path.join(CHECKOUT_DIR, "checkout-buttons.tsx"), "w", encoding="utf-8") as f:
    f.write(CHECKOUT_BUTTONS)
print("✓ Created /host/checkout/checkout-buttons.tsx")

print()
print("Done! Flow is now:")
print("  1. Host creates board with 0 credits")
print("  2. API returns 402 with redirectTo → /host/checkout?boardId=xxx")
print("  3. Form follows redirectTo")
print("  4. Checkout page shows board details + Buy button")
print("  5. Buy button → /api/credits/purchase → Stripe Checkout")
print("  6. Stripe webhook → credits added → pending board activated")
print()
print("Next:")
print('  git add -A && git commit -m "feat: checkout redirect flow" && npx vercel --prod')
