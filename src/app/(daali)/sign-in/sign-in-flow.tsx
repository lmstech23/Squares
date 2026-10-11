"use client";

import { useState } from "react";
import Link from "next/link";
import { AuthFrame } from "@/components/daali/AuthFrame";
import { Button } from "@/components/daali/Button";
import { Divider, Stack, Text } from "@/components/daali/Layout";
import { TextField } from "@/components/daali/TextField";
import { isUnknownIdentifier } from "@/lib/auth-errors";
import { parseSignInIdentifier } from "@/lib/sign-in-identifier";
import { createClient } from "@/lib/supabase/client";
import { CodeStep, displayPhone, TRY_AGAIN } from "../_auth/code-step";
import { GoogleButton } from "../_auth/google-button";
import { confirmRedirect, withNext } from "../_auth/links";
import { sendStartLink } from "../start/start-flow";

// Screen: Welcome back (/sign-in) — Auth spec, "Returning sign-in". Copy is the
// spec's, verbatim.
//
// EMAIL AND PHONE HERE NEVER CREATE A USER: both send with
// shouldCreateUser: false. An unknown identifier is refused by Supabase
// (`otp_disabled`) and offered account creation instead:
//   - unknown email: "Create an account" sends the Get started link to that
//     address — the one deliberate create, exactly as /start would;
//   - unknown phone: "Create an account" opens /start. Phone never creates.

type Step =
  | { at: "field" }
  | { at: "email-code"; email: string; created: boolean }
  | { at: "phone-code"; phone: string }
  | { at: "unknown-email"; email: string }
  | { at: "unknown-phone" };

const INVALID = "Enter an email address or a mobile number.";
const SMS_FAILED = "We couldn't send a code to that number. Check it and try again.";

function sendSignInEmail(email: string, next: string | null) {
  return createClient().auth.signInWithOtp({
    email,
    options: { shouldCreateUser: false, emailRedirectTo: confirmRedirect(next) },
  });
}

function sendSignInSms(phone: string) {
  return createClient().auth.signInWithOtp({ phone, options: { shouldCreateUser: false } });
}

export function SignInFlow({ next }: { next: string | null }) {
  const [step, setStep] = useState<Step>({ at: "field" });
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const footer = (
    <>
      New to Daali? <Link href={withNext("/start", next)}>Create an account</Link>
    </>
  );

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const id = parseSignInIdentifier(value);
    if (id.kind === "invalid") {
      setError(INVALID);
      return;
    }
    setBusy(true);
    if (id.kind === "email") {
      const { error: err } = await sendSignInEmail(id.email, next);
      setBusy(false);
      if (isUnknownIdentifier(err)) return setStep({ at: "unknown-email", email: id.email });
      if (err) return setError(TRY_AGAIN);
      return setStep({ at: "email-code", email: id.email, created: false });
    }
    const { error: err } = await sendSignInSms(id.phone);
    setBusy(false);
    if (isUnknownIdentifier(err)) return setStep({ at: "unknown-phone" });
    if (err) return setError(SMS_FAILED);
    setStep({ at: "phone-code", phone: id.phone });
  }

  async function createForEmail(email: string) {
    setError(null);
    setBusy(true);
    const { error: err } = await sendStartLink(email, next);
    setBusy(false);
    if (err) return setError(TRY_AGAIN);
    setStep({ at: "email-code", email, created: true });
  }

  if (step.at === "email-code") {
    const { email, created } = step;
    return (
      <AuthFrame title="Check your email." footer={footer}>
        <CodeStep
          channel="email"
          target={email}
          next={next}
          autoContinue={created}
          resend={async () =>
            ((created ? await sendStartLink(email, next) : await sendSignInEmail(email, next)).error ? TRY_AGAIN : null)
          }
        />
      </AuthFrame>
    );
  }

  if (step.at === "phone-code") {
    const { phone } = step;
    return (
      <AuthFrame title={`Enter the code we texted to ${displayPhone(phone)}`} footer={footer}>
        <CodeStep
          channel="phone"
          target={phone}
          next={next}
          resend={async () => ((await sendSignInSms(phone)).error ? SMS_FAILED : null)}
        />
      </AuthFrame>
    );
  }

  if (step.at === "unknown-email") {
    const { email } = step;
    return (
      <AuthFrame title="Welcome back" footer={footer}>
        <Stack gap={16}>
          <Text>We don&apos;t have a Daali account for {email} yet.</Text>
          {error ? <Text size="small">{error}</Text> : null}
          <Button fullWidth disabled={busy} onClick={() => createForEmail(email)}>
            Create an account
          </Button>
          <Button variant="text" onClick={() => setStep({ at: "field" })}>
            Try a different email or number
          </Button>
        </Stack>
      </AuthFrame>
    );
  }

  if (step.at === "unknown-phone") {
    return (
      <AuthFrame title="Welcome back" footer={footer}>
        <Stack gap={16}>
          <Text>
            We don&apos;t have a Daali account for that number. Create one with your email and you&apos;ll add this
            number during setup.
          </Text>
          <Button fullWidth href={withNext("/start", next)}>
            Create an account
          </Button>
        </Stack>
      </AuthFrame>
    );
  }

  return (
    <AuthFrame title="Welcome back" footer={footer}>
      <Stack gap={16}>
        <GoogleButton next={next} />
        <Divider>or</Divider>
        <form onSubmit={submit}>
          <Stack gap={16}>
            <TextField
              label="Email or mobile number"
              name="identifier"
              autoComplete="username"
              required
              value={value}
              onChange={(e) => setValue(e.target.value)}
              error={error}
            />
            <Button type="submit" fullWidth disabled={busy}>
              Continue
            </Button>
          </Stack>
        </form>
      </Stack>
    </AuthFrame>
  );
}
