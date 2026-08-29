import { prisma } from "@/lib/prisma";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import GateSurface, { type RosterEntry } from "./gate-surface";

export const dynamic = "force-dynamic";

// Volunteer surface — fundraiser-board-v2.md §6B.
//
// Purpose-built layout, existing design tokens. Laid out for a condition no
// other screen in Daali faces: outdoors, midday glare, one hand, a line of
// people, and a volunteer who has never seen the app and got no training.
//
// Deliberately absent: any money, any square, any grid, any drawing, any host
// setting. Volunteers consume entitlement and never create it.

interface Props {
  params: Promise<{ token: string }>;
}

export const metadata: Metadata = {
  title: "Check-in — Daali",
  robots: { index: false, follow: false },
};

export default async function GatePage({ params }: Props) {
  const { token } = await params;

  const { resolveGateSession } = await import("@/lib/volunteer-access");
  const session = await resolveGateSession(token);

  if (!session) notFound();

  const event = await prisma.event.findUnique({
    where: { id: session.eventId },
    select: { name: true, board: { select: { gameName: true } } },
  });

  // Roster rows are keyed to the SUPPORTER, not the purchase — one family, one
  // row, however many times they bought in. A parent who contributed twice
  // must not appear twice in a line of people.
  const supporters = await prisma.eventSupporter.findMany({
    where: {
      eventId: session.eventId,
      status: "active",
      passes: { some: { status: { in: ["active", "used"] } } },
    },
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      passes: {
        where: { status: { in: ["active", "used"] } },
        select: { id: true, status: true, label: true },
        orderBy: { sequenceNumber: "asc" },
      },
    },
    orderBy: { name: "asc" },
  });

  const roster: RosterEntry[] = supporters.map((s) => ({
    id: s.id,
    name: s.name,
    email: s.email,
    phone: s.phone,
    total: s.passes.length,
    used: s.passes.filter((p) => p.status === "used").length,
    passes: s.passes.map((p) => ({
      id: p.id,
      used: p.status === "used",
      label: p.label,
    })),
  }));

  return (
    <GateSurface
      token={token}
      eventName={event?.name ?? event?.board.gameName ?? "Check-in"}
      volunteerLabel={session.label}
      roster={roster}
    />
  );
}
