"use client";

import { useState } from "react";
import Link from "next/link";
import { AuthFrame } from "@/components/daali/AuthFrame";
import { Button } from "@/components/daali/Button";
import { Stack } from "@/components/daali/Layout";
import { TextField } from "@/components/daali/TextField";
import { createClient } from "@/lib/supabase/client";
import { CodeStep, TRY_AGAIN } from "../_auth/code-step";
import { GoogleButton } from "../_auth/google-button";
import { confirmRedirect, withNext } from "../_auth/links";

// Screen 1: Create your Daali account (/start) — Auth spec, "New-account flow".
// Copy is the spec's, verbatim.
//
// The email path is the one place email may create a user:
// signInWithOtp({ shouldCreateUser: true }). An address that already has an
// account is simply signed in by the same link; Get started never shows an
// "account exists" error.

type Step = { at: "choose" } | { at: "email" } | { at: "check"; email: string };

export function sendStartLink(email: string, next: string | null) {
  return createClient().auth.signInWithOtp({
    email,
    options: { shouldCreateUser: true, emailRedirectTo: confirmRedirect(next) },
  });
}

export function StartFlow({ next }: { next: string | null }) {
  const [step, setStep] = useState<Step>({ at: "choose" });
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const footer = (
    <>
      Already have a Daali account? <Link href={withNext("/sign-in", next)}>Sign in</Link>
    </>
  );

  async function send(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const { error: err } = await sendStartLink(email.trim(), next);
    setBusy(false);
    if (err) {
      setError(TRY_AGAIN);
      return;
    }
    setStep({ at: "check", email: email.trim() });
  }

  if (step.at === "check") {
    return (
      <AuthFrame title="Check your email." footer={footer}>
        <CodeStep
          channel="email"
          target={step.email}
          next={next}
          autoContinue
          resend={async () => ((await sendStartLink(step.email, next)).error ? TRY_AGAIN : null)}
        />
      </AuthFrame>
    );
  }

  if (step.at === "email") {
    return (
      <AuthFrame title="Create your Daali account" footer={footer}>
        <form onSubmit={send}>
          <Stack gap={16}>
            <TextField
              label="What's your email?"
              type="email"
              name="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              error={error}
            />
            <Button type="submit" fullWidth disabled={busy}>
              Send link
            </Button>
          </Stack>
        </form>
      </AuthFrame>
    );
  }

  return (
    <AuthFrame
      title="Create your Daali account"
      subtitle="Free to use. Choose how you'd like to sign up. There's no password to remember."
      footer={footer}
    >
      <Stack gap={16}>
        <GoogleButton next={next} />
        <Button fullWidth onClick={() => setStep({ at: "email" })}>
          Continue with email
        </Button>
      </Stack>
    </AuthFrame>
  );
}
