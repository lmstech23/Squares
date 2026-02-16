#!/usr/bin/env python3
"""Fix #5 — Switch host login from magic link to email OTP.
Run from your project root: python fix-otp-auth.py
"""

import sys

FILE = "src/app/login/page.tsx"

try:
    with open(FILE, "r") as f:
        content = f.read()
except FileNotFoundError:
    print(f"✗ Not found: {FILE}")
    sys.exit(1)

NEW_CONTENT = '''"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [token, setToken] = useState("");
  const [step, setStep] = useState<"email" | "code">("email");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  async function handleSendCode(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const supabase = createClient();
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        shouldCreateUser: true,
      },
    });

    setLoading(false);

    if (error) {
      setError(error.message);
      return;
    }

    setStep("code");
  }

  async function handleVerifyCode(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const supabase = createClient();
    const { error } = await supabase.auth.verifyOtp({
      email,
      token,
      type: "email",
    });

    setLoading(false);

    if (error) {
      setError(error.message);
      return;
    }

    // OTP verified — session is set. Redirect to dashboard.
    router.push("/host/boards");
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-950 px-4">
      <div className="w-full max-w-sm">
        <h1 className="text-2xl font-bold text-white mb-1">Squares</h1>
        <p className="text-gray-500 text-sm mb-8">
          Sign in to create and manage boards.
        </p>

        {step === "code" ? (
          <div>
            <div className="rounded-lg border border-gray-800 bg-gray-900 p-6 mb-4">
              <p className="text-white text-sm font-medium mb-1">
                Enter your code
              </p>
              <p className="text-gray-500 text-sm">
                We sent a 6-digit code to{" "}
                <span className="text-gray-300">{email}</span>
              </p>
            </div>

            <form onSubmit={handleVerifyCode} className="space-y-4">
              <div>
                <label
                  htmlFor="token"
                  className="block text-sm text-gray-400 mb-1.5"
                >
                  Code
                </label>
                <input
                  id="token"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  required
                  maxLength={6}
                  value={token}
                  onChange={(e) =>
                    setToken(e.target.value.replace(/\\D/g, "").slice(0, 6))
                  }
                  placeholder="000000"
                  className="w-full rounded-lg border border-gray-800 bg-gray-900 px-3 py-2.5 text-sm text-white placeholder-gray-600 outline-none focus:border-gray-600 transition-colors tracking-[0.3em] text-center font-mono"
                />
              </div>

              {error && <p className="text-red-400 text-sm">{error}</p>}

              <button
                type="submit"
                disabled={loading || token.length !== 6}
                className="w-full rounded-lg bg-white text-gray-950 py-2.5 text-sm font-medium hover:bg-gray-200 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {loading ? "Verifying\\u2026" : "Verify"}
              </button>
            </form>

            <button
              onClick={() => {
                setStep("email");
                setToken("");
                setError(null);
              }}
              className="mt-3 w-full text-center text-xs text-gray-600 hover:text-gray-400 transition-colors"
            >
              Use a different email
            </button>
          </div>
        ) : (
          <form onSubmit={handleSendCode} className="space-y-4">
            <div>
              <label
                htmlFor="email"
                className="block text-sm text-gray-400 mb-1.5"
              >
                Email
              </label>
              <input
                id="email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                className="w-full rounded-lg border border-gray-800 bg-gray-900 px-3 py-2.5 text-sm text-white placeholder-gray-600 outline-none focus:border-gray-600 transition-colors"
              />
            </div>

            {error && <p className="text-red-400 text-sm">{error}</p>}

            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-lg bg-white text-gray-950 py-2.5 text-sm font-medium hover:bg-gray-200 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {loading ? "Sending\\u2026" : "Send sign-in code"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
'''

with open(FILE, "w") as f:
    f.write(NEW_CONTENT)

print(f"✓ Fixed: {FILE}")
print()
print("Changes:")
print("  - Magic link → 6-digit OTP code")
print("  - User enters code on same page (no redirect needed)")
print("  - Removed emailRedirectTo (no callback dependency)")
print("  - Added useRouter for client-side redirect after verify")
print()
print("The /auth/callback route still works for any existing magic links.")
print()
print('Next: git add -A && git commit -m "fix: switch login to email OTP" && git push origin main')
