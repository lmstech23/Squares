"use client";

import { useEffect, useState } from "react";
import { AuthFrame } from "@/components/daali/AuthFrame";
import { Button } from "@/components/daali/Button";
import { Stack } from "@/components/daali/Layout";
import { TextField } from "@/components/daali/TextField";
import { saveDisplayName } from "@/lib/save-display-name";
import { normalizePhone } from "@/lib/sign-in-identifier";
import type { SetupStep } from "@/lib/setup-steps";
import { createClient } from "@/lib/supabase/client";
import { CodeStep, displayPhone, TRY_AGAIN } from "../_auth/code-step";
import { confirmRedirect } from "../_auth/links";
import { SignOutLink } from "../_auth/sign-out-link";

// /setup — Daali Slice 1, S1.5. Auth spec, "Screen 3", "Screen 4" and
// "Existing accounts without an email". Copy is the spec's, verbatim, except
// where the spec gives none; those lines are marked INTERIM and are on the
// design-review list.
//
// ATTACH, NEVER SIGN IN. The phone step calls updateUser({ phone }) and
// verifyOtp(type 'phone_change'); the email step calls updateUser({ email })
// and verifyOtp(type 'email_change'). Both attach to the signed-in user. This
// file never calls signInWithOtp (T13), so setup cannot create a user.
//
// After each verified step the page reloads, and the loader decides what is
// still missing — or sends a COMPLETE organizer on.
//
// RESEND RE-ISSUES THE CHANGE. On the local stack (GoTrue v2.197.0),
// resend({ type: 'phone_change' | 'email_change' }) answers 200 and sends
// nothing when the account has no current number or address — which is every
// account this screen serves. Calling updateUser again with the same pending
// value does send a fresh code. Supabase still applies its own limits (one SMS
// per 5 seconds, one email per 60 seconds), the same ones the cooldowns show.

const NAME_INVALID = "Enter a name between 1 and 60 characters."; // INTERIM
const PHONE_INVALID = "Enter a mobile number."; // INTERIM
const PHONE_TAKEN = "That number is already on another Daali account.";
const SMS_FAILED = "We couldn't send a code to that number. Check it and try again.";
const EMAIL_TAKEN = "That email is already on another Daali account.";
const changeAgainIn = (n: number) => `You can change it again in ${n}s.`; // INTERIM

/**
 * Seconds Supabase says to wait before another change, from its "For security
 * purposes, you can only request this after N seconds." refusal; else null.
 */
function waitSeconds(err: { code?: string; message?: string }): number | null {
  const m = /after (\d+) seconds?/i.exec(err.message ?? "");
  if (m) return Number(m[1]);
  return err.code === "over_email_send_rate_limit" ? 60 : null;
}

const reloadSetup = () => window.location.assign("/setup");

// Screen 4's 30-second Resend cooldown has to survive the reload that follows
// sending the code, and Supabase's user object carries no time for a pending
// number. So this browser notes when it sent a code to which number. A visit
// without the note (another device, a later day) may resend at once; Supabase
// still enforces its own limit.
const PHONE_SENT_KEY = "daali:setup:phone-code-sent";
function notePhoneSent(phone: string) {
  try {
    sessionStorage.setItem(PHONE_SENT_KEY, JSON.stringify({ phone, at: Date.now() }));
  } catch {
    // Storage unavailable: the cooldown simply starts at zero.
  }
}
function phoneCooldownLeft(phone: string): number {
  try {
    const raw = sessionStorage.getItem(PHONE_SENT_KEY);
    const note = raw ? (JSON.parse(raw) as { phone?: string; at?: number }) : null;
    if (!note || note.phone !== phone || typeof note.at !== "number") return 0;
    return Math.max(0, 30 - Math.floor((Date.now() - note.at) / 1000));
  } catch {
    return 0;
  }
}

function phoneError(code: string | undefined): string {
  return code === "phone_exists" ? PHONE_TAKEN : SMS_FAILED;
}

export function SetupFlow({ step, emailCooldownLeft }: { step: SetupStep; emailCooldownLeft: number }) {
  if (step.step === "details") return <DetailsStep askName={step.askName} askPhone={step.askPhone} />;
  if (step.step === "phone-code") return <PhoneCodeStep phone={step.phone} />;
  return <EmailStep pending={step.pendingEmail} cooldownLeft={emailCooldownLeft} />;
}

/** Screen 3: the name and/or the mobile number, whichever is missing. */
function DetailsStep({ askName, askPhone }: { askName: boolean; askPhone: boolean }) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [phoneErr, setPhoneErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setNameError(null);
    setPhoneErr(null);

    const e164 = askPhone ? normalizePhone(phone) : null;
    if (askPhone && !e164) return setPhoneErr(PHONE_INVALID);

    setBusy(true);
    // The name is saved first, so it survives if the person stops at the phone step.
    if (askName) {
      const saved = await saveDisplayName(name);
      if (!saved.ok) {
        setBusy(false);
        return setNameError(saved.reason === "invalid" ? NAME_INVALID : TRY_AGAIN);
      }
    }
    if (askPhone && e164) {
      const { error } = await createClient().auth.updateUser({ phone: e164 });
      if (error) {
        setBusy(false);
        return setPhoneErr(phoneError(error.code));
      }
      notePhoneSent(e164);
    }
    reloadSetup();
  }

  return (
    <AuthFrame title="Finish setting up your Daali" footer={<SignOutLink />}>
      <form onSubmit={submit}>
        <Stack gap={24}>
          {askName ? (
            <TextField
              label="What should we call you?"
              name="displayName"
              autoComplete="name"
              maxLength={60}
              required
              helper="This is how you'll appear to people you invite."
              value={name}
              onChange={(e) => setName(e.target.value)}
              error={nameError}
            />
          ) : null}
          {askPhone ? (
            <TextField
              label="Mobile number"
              name="phone"
              type="tel"
              autoComplete="tel"
              required
              helper="We'll verify your number so you can also use it to sign in to Daali."
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              error={phoneErr}
            />
          ) : null}
          <Button type="submit" fullWidth disabled={busy}>
            {askPhone ? "Send code" : "Continue" /* INTERIM: name only */}
          </Button>
        </Stack>
      </form>
    </AuthFrame>
  );
}

/** Screen 4: Confirm your number. Resend after 30 seconds, and Change number. */
function PhoneCodeStep({ phone }: { phone: string }) {
  const [changing, setChanging] = useState(false);
  // Read after mount, so the server render and the first browser render agree.
  const [cooldownLeft, setCooldownLeft] = useState<number | null>(null);
  useEffect(() => setCooldownLeft(phoneCooldownLeft(phone)), [phone]);
  if (changing) return <DetailsStep askName={false} askPhone />;

  return (
    <AuthFrame title={`Enter the code we texted to ${displayPhone(phone)}`} footer={<SignOutLink />}>
      {cooldownLeft === null ? null : (
        <CodeStep
          channel="phone"
          target={phone}
          next={null}
          verifyType="phone_change"
          cooldownLeft={cooldownLeft}
          resend={async () => {
            const { error } = await createClient().auth.updateUser({ phone });
            if (!error) notePhoneSent(phone);
            return error ? phoneError(error.code) : null;
          }}
          secondary={{ label: "Change number", onClick: () => setChanging(true) }}
          onVerified={reloadSetup}
        />
      )}
    </AuthFrame>
  );
}

/**
 * Add your email — existing accounts created without one. Pending until the
 * code or link is verified; on return the pending address shows with Resend
 * and Change email.
 */
function EmailStep({ pending, cooldownLeft }: { pending: string | null; cooldownLeft: number }) {
  const [changing, setChanging] = useState(false);
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Supabase refuses a change inside 60 seconds of the last send; count it down
  // the way Resend does, instead of a bare "Please try again."
  const [wait, setWait] = useState(0);
  useEffect(() => {
    if (wait <= 0) return;
    const t = setTimeout(() => setWait((n) => n - 1), 1000);
    return () => clearTimeout(t);
  }, [wait]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const { error: err } = await createClient().auth.updateUser(
      { email: email.trim() },
      { emailRedirectTo: confirmRedirect(null) }
    );
    if (err) {
      setBusy(false);
      if (err.code === "email_exists") return setError(EMAIL_TAKEN);
      const seconds = waitSeconds(err);
      if (seconds) return setWait(seconds);
      return setError(TRY_AGAIN);
    }
    reloadSetup();
  }

  if (pending && !changing) {
    return (
      <AuthFrame
        title="Add your email"
        subtitle="We'll use it to sign you in and send your receipts."
        footer={<SignOutLink />}
      >
        <CodeStep
          channel="email"
          target={pending}
          next={null}
          verifyType="email_change"
          cooldownLeft={cooldownLeft}
          resend={async () => {
            const { error: err } = await createClient().auth.updateUser(
              { email: pending },
              { emailRedirectTo: confirmRedirect(null) }
            );
            return err ? (err.code === "email_exists" ? EMAIL_TAKEN : TRY_AGAIN) : null;
          }}
          secondary={{ label: "Change email", onClick: () => setChanging(true) }}
          onVerified={reloadSetup}
        />
      </AuthFrame>
    );
  }

  return (
    <AuthFrame
        title="Add your email"
        subtitle="We'll use it to sign you in and send your receipts."
        footer={<SignOutLink />}
      >
      <form onSubmit={send}>
        <Stack gap={16}>
          <TextField
            label="Email"
            type="email"
            name="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            error={wait > 0 ? changeAgainIn(wait) : error}
          />
          <Button type="submit" fullWidth disabled={busy || wait > 0}>
            Send code
          </Button>
        </Stack>
      </form>
    </AuthFrame>
  );
}
