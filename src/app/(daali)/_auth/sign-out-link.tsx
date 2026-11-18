"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

// Sign out, as a footer link — Daali Slice 1, S1.6 (Auth spec: /setup carries a
// Sign out link, so a person who stops partway is never stuck in a signed-in
// session they cannot leave). INTERIM, pending design review: no frame exists.

export function SignOutLink() {
  const [busy, setBusy] = useState(false);
  async function signOut() {
    setBusy(true);
    await createClient().auth.signOut();
    window.location.assign("/sign-in");
  }
  return (
    <button type="button" onClick={signOut} disabled={busy}>
      {busy ? "Signing out…" : "Sign out"}
    </button>
  );
}
