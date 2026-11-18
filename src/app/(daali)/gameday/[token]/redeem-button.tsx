"use client";

import { useState } from "react";
import { Button } from "@/components/daali/Button";
import { Stack, Text } from "@/components/daali/Layout";

// The one button on /gameday/[token]. Redeeming happens only here, on press.

export function RedeemButton({ token, cantUse }: { token: string; cantUse: string }) {
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const [needsSetup, setNeedsSetup] = useState(false);

  async function redeem() {
    setBusy(true);
    const res = await fetch(`/api/gameday/${encodeURIComponent(token)}/redeem`, { method: "POST" });
    const body = (await res.json().catch(() => ({}))) as { outcome?: string; destination?: string };
    if (body.destination) {
      window.location.assign(body.destination);
      return;
    }
    setBusy(false);
    // An account with no profile row yet (an existing phone-only account before
    // the backfill) finishes setup first; the link is still unused and comes back.
    if (body.outcome === "no-profile") return setNeedsSetup(true);
    setRefused(cantUse);
  }

  if (refused) return <Text>{refused}</Text>;
  if (needsSetup) {
    return (
      <Stack gap={16}>
        <Text>Finish setting up your Daali account first. This link will still work.</Text>
        <Button fullWidth href={`/setup?next=${encodeURIComponent(`/gameday/${token}`)}`}>
          Continue setup
        </Button>
      </Stack>
    );
  }
  return (
    <Button fullWidth onClick={redeem} disabled={busy}>
      Add Game Day
    </Button>
  );
}
