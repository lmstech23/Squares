"use client";

import { useState } from "react";
import { Button } from "@/components/daali/Button";
import { Text } from "@/components/daali/Layout";
import { createClient } from "@/lib/supabase/client";

// Continue with Google — the same call on Get started and Sign in (Auth spec,
// "Google path"). /auth/callback exchanges the code, runs finalize and applies
// the allowlist to `next`; the spec's default next is /setup.

export function GoogleButton({ next }: { next: string | null }) {
  const [error, setError] = useState<string | null>(null);

  async function go() {
    setError(null);
    const callback = new URL("/auth/callback", window.location.origin);
    callback.searchParams.set("next", next ?? "/setup");
    const { error: err } = await createClient().auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: callback.toString() },
    });
    if (err) setError("Please try again.");
  }

  return (
    <>
      <Button variant="secondary" fullWidth onClick={go}>
        Continue with Google
      </Button>
      {error ? <Text size="small">{error}</Text> : null}
    </>
  );
}
