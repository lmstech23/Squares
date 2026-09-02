// src/app/host/boards/[id]/volunteers/page.tsx
//
// Host volunteer management. Sign-up addendum §8, S3b.
//
// A ROUTE, NOT A MODAL. The host opens this standing at a table on weak signal:
// it has to survive a refresh, work from a bookmark, and own the whole viewport
// on a phone. It is also the smallest option — the slot builder already takes
// server-fetched props, so a modal would have forced a client fetch-on-mount and
// the loading state S2 deliberately removed.
//
// THE ROUTE GATES ITSELF. The compact link's absence from a Game Day board is
// not access control — a host can type or bookmark this URL. Product gate and
// host authorization are both enforced here.
//
// Per-slot supporter visibility renders as SIBLING SERVER OUTPUT, below the
// builder rather than through it. The list does not change while the host types
// in a form, and coupling it to that client state would make every keystroke a
// reason to re-render a roster.

import type { Metadata } from "next";
import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getHost } from "@/lib/auth";
import SignupPanel from "../signup-panel";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Volunteer sign-up — Daali",
};

interface Props {
  params: Promise<{ id: string }>;
}

/** One person's holding on one slot, after the zero-position filter. */
interface Helper {
  supporterId: string;
  name: string;
  quantity: number;
}

export default async function VolunteersPage({ params }: Props) {
  const { id } = await params;

  const host = await getHost();
  if (!host) redirect("/login");

  const board = await prisma.board.findUnique({
    where: { boardId: id },
    select: {
      boardId: true,
      slug: true,
      gameName: true,
      boardType: true,
      hostId: true,
      event: { select: { id: true, name: true, timezone: true } },
    },
  });

  // 404, not 403, for a board this host does not own — distinguishing "does not
  // exist" from "exists but is not yours" tells a prober which board ids are
  // real. Same order and same status as the board page.
  if (!board || board.hostId !== host.id) notFound();

  // The product gate. `board.boardType === "fundraiser"` is the SAME comparison
  // the host board page's fundraiser branch uses — not a second board-type
  // concept. Game Day has no volunteer sign-up, and a sheet keys to `eventId`,
  // so a board without an event has nothing to manage.
  if (board.boardType !== "fundraiser") notFound();
  const event = board.event;
  if (!event) notFound();

  const sheet = await prisma.signupSheet.findUnique({
    where: { eventId: event.id },
    select: {
      id: true,
      title: true,
      instructions: true,
      isOpen: true,
      slots: {
        orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
        select: {
          id: true, slotType: true, name: true, startsAt: true, endsAt: true,
          capacity: true, unitLabel: true, notes: true, sortOrder: true,
          // Fill is a LIVE COUNT of position rows. No `filledCount` column to
          // drift — the same decision that keeps quantity off HelperSignup.
          _count: { select: { positions: true } },
          signups: {
            select: {
              id: true,
              supporter: { select: { id: true, name: true } },
              _count: { select: { positions: true } },
            },
          },
        },
      },
    },
  });

  const slots = sheet?.slots ?? [];

  // Alphabetical, tie-broken on the supporter id. Sorting happens HERE and not
  // in the query: Prisma cannot order a nested relation by a field on a
  // relation of that relation, and the stable tiebreak matters because two
  // helpers with the same display name must not swap places between renders.
  const helpersFor = (slot: (typeof slots)[number]): Helper[] =>
    slot.signups
      .filter((g) => {
        if (g._count.positions > 0) return true;
        // A commitment holding no positions violates invariant 39 — quantity IS
        // count(HelperSignupPosition). It is the same corruption the S3
        // SHIFT-ceiling bug produced. Hide it from the host, but never swallow
        // it: identifiers only, no names or emails.
        console.warn(
          "volunteers: zero-position HelperSignup — invariant 39 violation",
          {
            boardId: board.boardId,
            eventId: event.id,
            slotId: slot.id,
            helperSignupId: g.id,
            eventSupporterId: g.supporter.id,
          }
        );
        return false;
      })
      .map((g) => ({
        supporterId: g.supporter.id,
        name: g.supporter.name,
        quantity: g._count.positions,
      }))
      .sort(
        (a, b) =>
          a.name.localeCompare(b.name, "en", { sensitivity: "base" }) ||
          a.supporterId.localeCompare(b.supporterId)
      );

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <div className="max-w-2xl mx-auto px-4 py-6">
        {/* A bookmarked URL carries a UUID and nothing else, so the page says
            which board it is. Two boards with similar names are otherwise
            indistinguishable here. */}
        <Link
          href={`/host/boards/${board.boardId}`}
          className="text-xs text-gray-500 hover:text-white transition-colors"
        >
          ← {board.gameName}
        </Link>
        <h1 className="text-xl font-bold mt-2">Volunteer sign-up</h1>
        <p className="text-xs text-gray-600 mt-1">
          {event.name ? `${event.name} · ` : ""}
          {board.slug}
        </p>

        <div className="mt-5">
          <SignupPanel
            boardId={board.boardId}
            eventTimezone={event.timezone}
            sheet={
              sheet
                ? {
                    id: sheet.id,
                    title: sheet.title,
                    instructions: sheet.instructions,
                    isOpen: sheet.isOpen,
                  }
                : null
            }
            slots={slots.map((sl) => ({
              id: sl.id,
              slotType: sl.slotType as "SHIFT" | "ITEM",
              name: sl.name,
              startsAt: sl.startsAt ? sl.startsAt.toISOString() : null,
              endsAt: sl.endsAt ? sl.endsAt.toISOString() : null,
              capacity: sl.capacity,
              unitLabel: sl.unitLabel,
              notes: sl.notes,
              sortOrder: sl.sortOrder,
              filled: sl._count.positions,
              // Finished on the server: zero-position rows already dropped,
              // already sorted. The panel renders it and derives nothing.
              helpers: helpersFor(sl),
            }))}
          />
        </div>

      </div>
    </div>
  );
}
