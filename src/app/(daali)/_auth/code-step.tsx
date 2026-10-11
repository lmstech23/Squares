"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/daali/Button";
import { Stack, Text } from "@/components/daali/Layout";
import { TextField } from "@/components/daali/TextField";
import { createClient } from "@/lib/supabase/client";
import { completeSignIn } from "@/lib/complete-sign-in";

// The six-digit code step, for email and for phone — Daali Slice 1, S1.4.
//
//   email  "Check your email", Resend after 60 seconds (Auth spec, Email path)
//   phone  "Enter the code we texted to …", Resend after 30 seconds
//
// The code is verified in the browser (verifyOtp), then completeSignIn runs
// finalize on the server and names the destination.
//
// AUTO-CONTINUE (Get started only): if the link is confirmed in another tab of
// this browser, the session cookie appears here too, so polling for it lets
// this screen continue on its own. A link confirmed on a DIFFERENT device
// signs that device in and cannot sign this one in; see the S1.4 report.

const WRONG_CODE = "That code didn't work. Check it or send a new one.";
const TRY_AGAIN = "Please try again.";

export function useCooldown(seconds: number) {
  const [left, setLeft] = useState(seconds);
  useEffect(() => {
    if (left <= 0) return;
    const t = setTimeout(() => setLeft((n) => n - 1), 1000);
    return () => clearTimeout(t);
  }, [left]);
  return { left, restart: () => setLeft(seconds) };
}

export type CodeStepProps = {
  channel: "email" | "phone";
  /** The email, or the phone in E.164. */
  target: string;
  /** Sends the code again. Resolves to an error message, or null. */
  resend: () => Promise<string | null>;
  next: string | null;
  autoContinue?: boolean;
};

export function displayPhone(e164: string): string {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}

async function finish(next: string | null) {
  const destination = await completeSignIn(next);
  window.location.assign(destination);
}

export function CodeStep({ channel, target, resend, next, autoContinue = false }: CodeStepProps) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const cooldown = useCooldown(channel === "email" ? 60 : 30);

  useEffect(() => {
    if (!autoContinue) return;
    const supabase = createClient();
    let done = false;
    const timer = setInterval(async () => {
      const { data } = await supabase.auth.getSession();
      if (data.session && !done) {
        done = true;
        clearInterval(timer);
        await finish(next);
      }
    }, 3000);
    return () => {
      done = true;
      clearInterval(timer);
    };
  }, [autoContinue, next]);

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const supabase = createClient();
    const { error: err } =
      channel === "email"
        ? await supabase.auth.verifyOtp({ email: target, token: code.trim(), type: "email" })
        : await supabase.auth.verifyOtp({ phone: target, token: code.trim(), type: "sms" });
    if (err) {
      setError(WRONG_CODE);
      setBusy(false);
      return;
    }
    await finish(next);
  }

  async function onResend() {
    setError(null);
    const message = await resend();
    if (message) setError(message);
    cooldown.restart();
  }

  return (
    <form onSubmit={verify}>
      <Stack gap={16}>
        {channel === "email" ? <Text>We sent a link to {target}.</Text> : null}
        <TextField
          label="Code"
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]{6}"
          maxLength={6}
          required
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
          error={error}
        />
        <Button type="submit" fullWidth disabled={busy || code.length !== 6}>
          Continue
        </Button>
        <Button variant="text" onClick={onResend} disabled={cooldown.left > 0}>
          {cooldown.left > 0 ? `Resend in ${cooldown.left}s` : "Resend"}
        </Button>
      </Stack>
    </form>
  );
}

export { TRY_AGAIN };
