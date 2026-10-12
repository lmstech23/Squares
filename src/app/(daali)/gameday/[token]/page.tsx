import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AuthFrame } from "@/components/daali/AuthFrame";
import { Text } from "@/components/daali/Layout";
import { createClient } from "@/lib/supabase/server";
import { prisma } from "@/lib/prisma";
import { isGameDayEnabled } from "@/lib/game-day-access";
import { gameDayLinkStatusByToken } from "@/lib/game-day-links";
import { RedeemButton } from "./redeem-button";

// /gameday/[token] — a Game Day access link (Auth spec, "Game Day access").
//
// NOTHING HAPPENS ON PAGE LOAD: link scanners open links. The page only READS:
//   - signed out (or anonymous): to /sign-in, carrying this path as next;
//   - already entitled: straight to /host/boards/new, the link left unused;
//   - used, expired, revoked or unknown: the spec's message;
//   - otherwise "Add Game Day to your Daali account" and one button.
// It works whatever the account's setup state. Copy is the spec's; the button
// label is INTERIM, pending design review.

export const metadata: Metadata = {
  title: "Add Game Day",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};
export const dynamic = "force-dynamic";

const CANT_USE = "This Game Day link can't be used. Ask the person who sent it for a new one.";

export default async function GameDayLinkPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || user.is_anonymous) redirect(`/sign-in?next=${encodeURIComponent(`/gameday/${token}`)}`);

  if (await isGameDayEnabled(user.id)) redirect("/host/boards/new");

  const status = /^[A-Za-z0-9_-]{16,128}$/.test(token) ? await gameDayLinkStatusByToken(prisma, token) : "not-found";
  if (status !== "unused") {
    return (
      <AuthFrame title="Game Day">
        <Text>{CANT_USE}</Text>
      </AuthFrame>
    );
  }

  return (
    <AuthFrame title="Add Game Day to your Daali account">
      <RedeemButton token={token} cantUse={CANT_USE} />
    </AuthFrame>
  );
}
