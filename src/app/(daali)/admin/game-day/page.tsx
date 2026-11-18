import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/daali/AppShell";
import { prisma } from "@/lib/prisma";
import { getAdminUserId } from "@/lib/admin";
import { listGameDayAccounts, listGameDayLinks } from "@/lib/game-day-links";
import { AdminGameDay } from "./admin-game-day";

// /admin/game-day — Daali's administrator page for Game Day access links
// (Auth spec, "Game Day access"). INTERIM layout, pending design review.
//
// 404 for anyone who is not a listed administrator, signed out included. The
// check is the first thing the loader does, before any read; the endpoints the
// page calls each check again on their own (src/app/api/admin/game-day/**).

export const metadata: Metadata = { title: "Game Day access", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

export default async function AdminGameDayPage() {
  const adminUserId = await getAdminUserId();
  if (!adminUserId) notFound();

  const [links, accounts, profile] = await Promise.all([
    listGameDayLinks(prisma),
    listGameDayAccounts(prisma),
    prisma.organizerProfile.findUnique({ where: { userId: adminUserId }, select: { displayName: true } }),
  ]);

  return (
    <AppShell displayName={profile?.displayName?.trim() || "Administrator"} breadcrumb="Game Day access" signedOutHref="/sign-in" homeHref="/home">
      <AdminGameDay
        links={links.map((l) => ({
          id: l.id,
          status: l.status,
          createdAt: l.createdAt.toISOString(),
          expiresAt: l.expiresAt.toISOString(),
          usedAt: l.usedAt?.toISOString() ?? null,
          usedBy: l.usedBy,
        }))}
        accounts={accounts}
      />
    </AppShell>
  );
}
