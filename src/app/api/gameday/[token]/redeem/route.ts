import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { createClient } from "@/lib/supabase/server";
import { redeemGameDayLink } from "@/lib/game-day-links";

// Redeem a Game Day access link — the button on /gameday/[token]. Never on
// page load: link scanners open links.
//
// A signed-in, non-anonymous account only. One transaction: mark the link used
// only if it is unused, unrevoked and unexpired, and set
// legacy_boards_enabled only if that matched (src/lib/game-day-links.ts).

export const runtime = "nodejs";

export async function POST(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || user.is_anonymous) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { token } = await params;
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(token)) return NextResponse.json({ outcome: "unusable" }, { status: 410 });

  const outcome = await redeemGameDayLink(prisma, token, user.id);
  if (outcome === "redeemed" || outcome === "already-entitled") {
    return NextResponse.json({ outcome, destination: "/host/boards/new" });
  }
  return NextResponse.json({ outcome }, { status: 410 });
}
