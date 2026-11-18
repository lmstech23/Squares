"use client";

import { useState } from "react";
import { Button } from "@/components/daali/Button";
import { Stack, Text } from "@/components/daali/Layout";
import { createClient } from "@/lib/supabase/client";
import { completeSignIn } from "@/lib/complete-sign-in";
import { withNext } from "../../_auth/links";

// The email link's landing button — Auth spec, "Email path", step 5.
//
// NOTHING VERIFIES ON PAGE LOAD. Email security scanners open links; a token
// spent by a scanner would leave the person with a dead link. verifyOtp runs
// only when the button is pressed.

export function ConfirmButton({
  tokenHash,
  type,
  next,
}: {
  tokenHash: string | null;
  /** "email" for sign-in and sign-up links; "email_change" for adding an email at /setup. */
  type: "email" | "email_change";
  next: string | null;
}) {
  const [expired, setExpired] = useState(!tokenHash);
  const [busy, setBusy] = useState(false);

  async function confirm() {
    if (!tokenHash) return;
    setBusy(true);
    const { error } = await createClient().auth.verifyOtp({ token_hash: tokenHash, type });
    if (error) {
      setExpired(true);
      setBusy(false);
      return;
    }
    window.location.assign(await completeSignIn(next));
  }

  if (expired) {
    return (
      <Stack gap={16}>
        <Text>This link has expired.</Text>
        <Button fullWidth href={withNext("/sign-in", next)}>
          Send a new link
        </Button>
      </Stack>
    );
  }

  return (
    <Button fullWidth onClick={confirm} disabled={busy}>
      Continue to Daali
    </Button>
  );
}
