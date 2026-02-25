#!/usr/bin/env python3
"""
Adds the payment-setup onboarding page.
Run from project root: python add-payment-setup.py
"""
import os

# ── 1. Create payment-setup page ──────────────────────────────────────
os.makedirs("src/app/host/payment-setup", exist_ok=True)

with open("src/app/host/payment-setup/page.tsx", "w", encoding="utf-8") as f:
    f.write('''"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type PaymentMode = "stripe" | "cash" | null;

export default function PaymentSetupPage() {
  const router = useRouter();
  const [selected, setSelected] = useState<PaymentMode>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleContinue() {
    if (!selected) return;
    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/host/payment-preference", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: selected }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || "Something went wrong");
        setLoading(false);
        return;
      }

      if (selected === "stripe") {
        router.push("/host/stripe");
      } else {
        router.push("/host/boards");
      }
    } catch {
      setError("Something went wrong. Try again.");
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-[80vh] flex-col items-center justify-center px-4">
      <div className="w-full max-w-md">
        {/* Badge */}
        <div className="flex justify-center mb-6">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-indigo-500/30 bg-indigo-500/10 px-4 py-1.5 text-xs font-semibold uppercase tracking-wider text-indigo-400">
            ✦ Almost there
          </span>
        </div>

        {/* Heading */}
        <h1 className="text-center text-2xl font-bold tracking-tight text-white mb-2">
          How will your players pay?
        </h1>
        <p className="text-center text-sm text-gray-400 mb-8">
          Pick what works for your crew. You can always change this later.
        </p>

        {/* Options */}
        <div className="space-y-3 mb-6">
          {/* Cards via Stripe */}
          <button
            type="button"
            onClick={() => setSelected("stripe")}
            className={`w-full rounded-xl border p-5 text-left transition-all ${
              selected === "stripe"
                ? "border-indigo-500 bg-indigo-500/5 ring-1 ring-indigo-500/50"
                : "border-gray-800 bg-gray-900/50 hover:border-gray-700"
            }`}
          >
            <div className="flex items-start justify-between">
              <div className="flex items-start gap-3">
                <div className="mt-0.5 flex h-10 w-10 items-center justify-center rounded-lg bg-gray-800">
                  <svg
                    className="h-5 w-5 text-gray-300"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={1.5}
                  >
                    <rect x="2" y="5" width="20" height="14" rx="2" />
                    <path d="M2 10h20" />
                  </svg>
                </div>
                <div>
                  <div className="font-semibold text-white">Cards via Stripe</div>
                  <div className="text-sm text-gray-400">
                    Accept credit &amp; debit cards online
                  </div>
                </div>
              </div>
              <div
                className={`mt-1 h-5 w-5 rounded-full border-2 flex items-center justify-center flex-shrink-0 transition-colors ${
                  selected === "stripe"
                    ? "border-indigo-500"
                    : "border-gray-600"
                }`}
              >
                {selected === "stripe" && (
                  <div className="h-2.5 w-2.5 rounded-full bg-indigo-500" />
                )}
              </div>
            </div>
            <ul className="mt-3 ml-[52px] space-y-1 text-sm text-gray-400">
              <li>• Players pay with credit &amp; debit cards</li>
              <li>• Money goes directly to your bank</li>
              <li>• Automatic — no chasing payments</li>
            </ul>
          </button>

          {/* Cash only */}
          <button
            type="button"
            onClick={() => setSelected("cash")}
            className={`w-full rounded-xl border p-5 text-left transition-all ${
              selected === "cash"
                ? "border-indigo-500 bg-indigo-500/5 ring-1 ring-indigo-500/50"
                : "border-gray-800 bg-gray-900/50 hover:border-gray-700"
            }`}
          >
            <div className="flex items-start justify-between">
              <div className="flex items-start gap-3">
                <div className="mt-0.5 flex h-10 w-10 items-center justify-center rounded-lg bg-gray-800">
                  <svg
                    className="h-5 w-5 text-gray-300"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={1.5}
                  >
                    <circle cx="12" cy="12" r="9" />
                    <path d="M12 7v10M9 9.5c0-.828 1.343-1.5 3-1.5s3 .672 3 1.5-1.343 1.5-3 1.5-3 .672-3 1.5 1.343 1.5 3 1.5 3-.672 3-1.5" />
                  </svg>
                </div>
                <div>
                  <div className="font-semibold text-white">Cash only</div>
                  <div className="text-sm text-gray-400">
                    Collect from players face-to-face
                  </div>
                </div>
              </div>
              <div
                className={`mt-1 h-5 w-5 rounded-full border-2 flex items-center justify-center flex-shrink-0 transition-colors ${
                  selected === "cash"
                    ? "border-indigo-500"
                    : "border-gray-600"
                }`}
              >
                {selected === "cash" && (
                  <div className="h-2.5 w-2.5 rounded-full bg-indigo-500" />
                )}
              </div>
            </div>
            <ul className="mt-3 ml-[52px] space-y-1 text-sm text-gray-400">
              <li>• Collect cash from players in person</li>
              <li>• Perfect for watch parties &amp; cookouts</li>
              <li>• Connect Stripe anytime later</li>
            </ul>
          </button>
        </div>

        {/* Error */}
        {error && (
          <div className="mb-4 rounded-lg border border-red-900/50 bg-red-950/30 p-3">
            <p className="text-sm text-red-300">{error}</p>
          </div>
        )}

        {/* Continue button */}
        <button
          onClick={handleContinue}
          disabled={!selected || loading}
          className={`w-full rounded-xl py-3.5 text-sm font-semibold transition-all ${
            selected
              ? "bg-indigo-600 text-white hover:bg-indigo-500 active:bg-indigo-700"
              : "bg-gray-800 text-gray-500 cursor-not-allowed"
          }`}
        >
          {loading
            ? "Setting up\\u2026"
            : selected
              ? selected === "stripe"
                ? "Continue to Stripe setup"
                : "Continue to dashboard"
              : "Choose an option to continue"}
        </button>

        {/* Footer note */}
        <p className="mt-4 text-center text-xs text-gray-500">
          This only affects how players pay you. Board credits are separate.
        </p>
      </div>
    </div>
  );
}
''')
print("✓ Created: src/app/host/payment-setup/page.tsx")


# ── 2. Create API route ──────────────────────────────────────────────
os.makedirs("src/app/api/host/payment-preference", exist_ok=True)

with open("src/app/api/host/payment-preference/route.ts", "w", encoding="utf-8") as f:
    f.write('''import { NextResponse } from "next/server";
import { getHost } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function POST(request: Request) {
  const host = await getHost();
  if (!host) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { mode } = await request.json();
  if (mode !== "stripe" && mode !== "cash") {
    return NextResponse.json({ error: "Invalid mode" }, { status: 400 });
  }

  await prisma.host.update({
    where: { id: host.id },
    data: { paymentPreference: mode },
  });

  return NextResponse.json({ ok: true });
}
''')
print("✓ Created: src/app/api/host/payment-preference/route.ts")


# ── 3. Update schema.prisma — add paymentPreference to Host ─────────
schema_file = "prisma/schema.prisma"
with open(schema_file, "r", encoding="utf-8") as f:
    schema = f.read()

if "paymentPreference" not in schema:
    # Add after cashLiabilityAccepted or stripePayoutsEnabled — find the end of Host fields
    # Look for a good anchor in the Host model
    anchors = [
        "cashLiabilityAccepted",
        "stripePayoutsEnabled",
        "stripeChargesEnabled",
        "stripeAccountId",
        "boardCredits",
    ]
    inserted = False
    for anchor in anchors:
        if anchor in schema:
            # Find the end of that line
            idx = schema.index(anchor)
            line_end = schema.index("\n", idx)
            insert_point = line_end + 1
            new_field = '  paymentPreference  String?  @map("payment_preference")\n'
            schema = schema[:insert_point] + new_field + schema[insert_point:]
            inserted = True
            break

    if not inserted:
        print("⚠ Could not find anchor in Host model — add manually:")
        print('  paymentPreference  String?  @map("payment_preference")')
    else:
        with open(schema_file, "w", encoding="utf-8") as f:
            f.write(schema)
        print("✓ Updated: prisma/schema.prisma (added paymentPreference)")
else:
    print("✓ schema.prisma already has paymentPreference — skipped")


# ── 4. Wire redirect: new hosts → payment-setup ─────────────────────
boards_page = "src/app/host/boards/page.tsx"
with open(boards_page, "r", encoding="utf-8") as f:
    content = f.read()

if "payment-setup" not in content:
    # Add redirect check after the existing host/auth check
    # Look for the pattern where host is fetched and checked
    if "redirect(\"/login\")" in content:
        old = 'redirect("/login");'
        # We need to add AFTER the login redirect block closes
        # Find the line after redirect("/login") and its closing }
        login_idx = content.index(old)
        # Find the next closing brace + newline after this
        brace_after = content.index("\n", login_idx + len(old))
        insert_at = brace_after + 1

        redirect_check = '''
  // New hosts who haven't chosen payment method yet
  if (!host.paymentPreference) {
    redirect("/host/payment-setup");
  }

'''
        content = content[:insert_at] + redirect_check + content[insert_at:]

        with open(boards_page, "w", encoding="utf-8") as f:
            f.write(content)
        print("✓ Updated: src/app/host/boards/page.tsx (redirect if no preference)")
    else:
        print("⚠ Could not find redirect pattern in boards/page.tsx — add manually:")
        print('  if (!host.paymentPreference) { redirect("/host/payment-setup"); }')
else:
    print("✓ boards/page.tsx already has payment-setup redirect — skipped")


# ── 5. Update verify-otp to redirect new users to payment-setup ─────
otp_file = "src/app/api/auth/verify-otp/route.ts"
with open(otp_file, "r", encoding="utf-8") as f:
    otp = f.read()

# Only change the default redirect for NEW sessions
# The auth callback handles the actual redirect, so update that instead
callback_file = "src/app/auth/callback/route.ts"
with open(callback_file, "r", encoding="utf-8") as f:
    callback = f.read()

if "payment-setup" not in callback:
    # Change default next from /host/boards to /host/payment-setup for new users
    # But returning users should still go to /host/boards
    # Best approach: always go to /host/boards, let the boards page redirect if needed
    # The boards page redirect (step 4) handles this already
    print("✓ Auth callback unchanged — boards page handles the redirect")
else:
    print("✓ Auth callback already references payment-setup — skipped")


# ── 6. Set existing hosts' preference to 'stripe' so they skip this page
print()
print("=" * 60)
print("NEXT STEPS")
print("=" * 60)
print()
print("1. Run this SQL in Supabase SQL Editor:")
print()
print("   ALTER TABLE hosts")
print("     ADD COLUMN IF NOT EXISTS payment_preference TEXT DEFAULT NULL;")
print()
print("   -- Set existing hosts to 'stripe' so they skip the new page")
print("   UPDATE hosts SET payment_preference = 'stripe'")
print("     WHERE stripe_account_id IS NOT NULL;")
print()
print("2. Then run:")
print("   npx prisma generate")
print("   git add -A")
print('   git commit -m "feat: payment setup page - optional Stripe onboarding"')
print("   git push origin main")
print()
