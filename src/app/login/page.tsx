"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

type Method = "email" | "phone";
type Flow = "returning" | "new";

export default function LoginPage() {
  const [flow, setFlow] = useState<Flow>("returning");
  const [method, setMethod] = useState<Method>("phone");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [token, setToken] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [inviteValid, setInviteValid] = useState(false);
  const [step, setStep] = useState<"input" | "code">("input");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  function formatPhone(raw: string): string {
    const digits = raw.replace(/\D/g, "");
    if (digits.startsWith("1") && digits.length === 11) return "+" + digits;
    if (digits.length === 10) return "+1" + digits;
    return "+" + digits;
  }

  async function handleValidateInvite(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const res = await fetch("/api/auth/validate-invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: inviteCode.trim() }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Invalid code.");
        setLoading(false);
        return;
      }

      setInviteValid(true);
    } catch {
      setError("Something went wrong. Try again.");
    }

    setLoading(false);
  }

  async function handleSendCode(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const supabase = createClient();
    let result;

    if (method === "phone") {
      const formatted = formatPhone(phone);
      result = await supabase.auth.signInWithOtp({ phone: formatted });
    } else {
      result = await supabase.auth.signInWithOtp({
        email,
        options: { shouldCreateUser: true },
      });
    }

    setLoading(false);

    if (result.error) {
      setError(result.error.message);
      return;
    }

    setStep("code");
  }

  async function handleVerifyCode(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const supabase = createClient();
    let result;

    if (method === "phone") {
      const formatted = formatPhone(phone);
      result = await supabase.auth.verifyOtp({
        phone: formatted,
        token,
        type: "sms",
      });
    } else {
      result = await supabase.auth.verifyOtp({
        email,
        token,
        type: "email",
      });
    }

    if (result.error) {
      setError(result.error.message);
      setLoading(false);
      return;
    }

    // If new host with invite code, claim it after authentication
    if (flow === "new" && inviteCode.trim()) {
      try {
        const claimRes = await fetch("/api/auth/claim-invite", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: inviteCode.trim() }),
        });

        if (!claimRes.ok) {
          const data = await claimRes.json();
          console.warn("Invite claim failed:", data.error);
        }
      } catch (err) {
        console.warn("Invite claim error:", err);
      }
    }

    await new Promise((r) => setTimeout(r, 500));
    window.location.href = "/host/boards";
  }

  const displayIdentity = method === "phone" ? phone : email;
  const showOtpForm = flow === "returning" || inviteValid;

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
                <span className="text-gray-300">{displayIdentity}</span>
              </p>
            </div>

            <form onSubmit={handleVerifyCode} className="space-y-4">
              <div>
                <label htmlFor="token" className="block text-sm text-gray-400 mb-1.5">
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
                  onChange={(e) => setToken(e.target.value.replace(/\D/g, "").slice(0, 6))}
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
                {loading ? "Verifying…" : "Verify"}
              </button>
            </form>

            <button
              onClick={() => { setStep("input"); setToken(""); setError(null); }}
              className="mt-3 w-full text-center text-xs text-gray-600 hover:text-gray-400 transition-colors"
            >
              Start over
            </button>
          </div>
        ) : (
          <div>
            {/* Flow toggle */}
            <div className="flex rounded-lg border border-gray-800 bg-gray-900 mb-6 p-0.5">
              <button
                type="button"
                onClick={() => { setFlow("returning"); setError(null); setInviteValid(false); }}
                className={`flex-1 text-sm py-2 rounded-md transition-colors ${
                  flow === "returning" ? "bg-gray-800 text-white font-medium" : "text-gray-500 hover:text-gray-300"
                }`}
              >
                Sign In
              </button>
              <button
                type="button"
                onClick={() => { setFlow("new"); setError(null); }}
                className={`flex-1 text-sm py-2 rounded-md transition-colors ${
                  flow === "new" ? "bg-gray-800 text-white font-medium" : "text-gray-500 hover:text-gray-300"
                }`}
              >
                New Host
              </button>
            </div>

            {/* Invite code form (new hosts only) */}
            {flow === "new" && !inviteValid && (
              <form onSubmit={handleValidateInvite} className="space-y-4 mb-6">
                <div>
                  <label htmlFor="invite" className="block text-sm text-gray-400 mb-1.5">
                    Invite Code
                  </label>
                  <input
                    id="invite"
                    type="text"
                    required
                    value={inviteCode}
                    onChange={(e) => setInviteCode(e.target.value.toUpperCase())}
                    placeholder="DAALI-001"
                    className="w-full rounded-lg border border-gray-800 bg-gray-900 px-3 py-2.5 text-sm text-white placeholder-gray-600 outline-none focus:border-gray-600 transition-colors tracking-wider font-mono"
                  />
                </div>

                {error && <p className="text-red-400 text-sm">{error}</p>}

                <button
                  type="submit"
                  disabled={loading || !inviteCode.trim()}
                  className="w-full rounded-lg bg-white text-gray-950 py-2.5 text-sm font-medium hover:bg-gray-200 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {loading ? "Checking…" : "Validate Code"}
                </button>
              </form>
            )}

            {/* Invite validated badge */}
            {flow === "new" && inviteValid && (
              <div className="rounded-lg border border-green-900 bg-green-950/60 p-3 mb-6">
                <p className="text-sm text-green-300 font-medium">
                  ✓ Invite code accepted — 2 free boards included!
                </p>
              </div>
            )}

            {/* Phone/Email OTP form */}
            {showOtpForm && (
              <>
                <div className="flex rounded-lg border border-gray-800 bg-gray-900 mb-6 p-0.5">
                  <button
                    type="button"
                    onClick={() => { setMethod("phone"); setError(null); }}
                    className={`flex-1 text-sm py-2 rounded-md transition-colors ${
                      method === "phone" ? "bg-gray-800 text-white font-medium" : "text-gray-500 hover:text-gray-300"
                    }`}
                  >
                    Phone
                  </button>
                  <button
                    type="button"
                    onClick={() => { setMethod("email"); setError(null); }}
                    className={`flex-1 text-sm py-2 rounded-md transition-colors ${
                      method === "email" ? "bg-gray-800 text-white font-medium" : "text-gray-500 hover:text-gray-300"
                    }`}
                  >
                    Email
                  </button>
                </div>

                <form onSubmit={handleSendCode} className="space-y-4">
                  {method === "phone" ? (
                    <div>
                      <label htmlFor="phone" className="block text-sm text-gray-400 mb-1.5">
                        Phone number
                      </label>
                      <input
                        id="phone"
                        type="tel"
                        required
                        value={phone}
                        onChange={(e) => setPhone(e.target.value)}
                        placeholder="(555) 123-4567"
                        className="w-full rounded-lg border border-gray-800 bg-gray-900 px-3 py-2.5 text-sm text-white placeholder-gray-600 outline-none focus:border-gray-600 transition-colors"
                      />
                    </div>
                  ) : (
                    <div>
                      <label htmlFor="email" className="block text-sm text-gray-400 mb-1.5">
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
                  )}

                  {error && <p className="text-red-400 text-sm">{error}</p>}

                  <button
                    type="submit"
                    disabled={loading}
                    className="w-full rounded-lg bg-white text-gray-950 py-2.5 text-sm font-medium hover:bg-gray-200 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    {loading ? "Sending…" : "Send sign-in code"}
                  </button>
                </form>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
