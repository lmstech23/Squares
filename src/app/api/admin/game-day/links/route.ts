import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminUserId } from "@/lib/admin";
import { createGameDayLink, listGameDayLinks } from "@/lib/game-day-links";

// Game Day access links — list and create. Administrators only.
//
// THE ADMINISTRATOR CHECK IS THE FIRST LINE OF EACH HANDLER. Anyone else —
// signed out, anonymous, or not in DAALI_ADMIN_USER_IDS — gets 404 and nothing
// is read or written.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const notFound = () => NextResponse.json({ error: "Not found" }, { status: 404 });

/** List every link with its status. Never returns a token or a hash. */
export async function GET() {
  if (!(await getAdminUserId())) return notFound();
  const links = await listGameDayLinks(prisma);
  return NextResponse.json({ links });
}

/** Create a link. The raw token is in this response and nowhere else, ever. */
export async function POST() {
  const adminUserId = await getAdminUserId();
  if (!adminUserId) return notFound();
  const { token, id, expiresAt } = await createGameDayLink(prisma, adminUserId);
  return NextResponse.json({ id, token, path: `/gameday/${token}`, expiresAt }, { headers: { "Cache-Control": "no-store" } });
}
