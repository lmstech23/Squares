import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminUserId } from "@/lib/admin";
import { revokeGameDayLink } from "@/lib/game-day-links";

// Revoke an unused Game Day link. Administrators only: the check is the first
// line of the handler; anyone else gets 404 and nothing changes.
//
// One conditional UPDATE that matches only an unused, unrevoked link. If the
// link was redeemed first, it reports that it can't be revoked as unused.

export const runtime = "nodejs";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await getAdminUserId())) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ outcome: "not-found" }, { status: 404 });

  const outcome = await revokeGameDayLink(prisma, id);
  const status = outcome === "revoked" ? 200 : outcome === "not-found" ? 404 : 409;
  return NextResponse.json({ outcome }, { status });
}
