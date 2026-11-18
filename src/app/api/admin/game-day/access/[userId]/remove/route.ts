import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminUserId } from "@/lib/admin";
import { removeGameDayAccess } from "@/lib/game-day-links";

// Remove Game Day access from an account. Administrators only: the check is
// the first line of the handler; anyone else gets 404 and nothing changes.
//
// Sets organizer_profiles.legacy_boards_enabled = false for that account and
// nothing else. Its existing boards, their pages, management and payments are
// untouched.

export const runtime = "nodejs";

export async function POST(_request: Request, { params }: { params: Promise<{ userId: string }> }) {
  if (!(await getAdminUserId())) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const { userId } = await params;
  const removed = await removeGameDayAccess(prisma, userId);
  return NextResponse.json({ removed }, { status: removed ? 200 : 404 });
}
