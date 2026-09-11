import { prisma } from "@/lib/prisma";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import PassViewer from "./pass-viewer";

export const dynamic = "force-dynamic";

// Passes screen — fundraiser-board-v2.md §6.
//
// A stable URL the ticket email links to, so someone who deletes the email can
// still reach their tickets. The batch id is the key: a random UUID already on
// every purchase, unguessable, and known at the moment the email is sent.
//
// The link is the credential, the same model as the check-in surface. There is
// no login here — a contributor has no account and never will.
//
// Shows every ticket the SUPPORTER currently holds, not only the ones from
// this purchase. A second purchase adds to the same set, so a returning
// supporter sees everything in one place rather than hunting through emails.

interface Props {
  params: Promise<{ batch: string }>;
}

import { ADMISSION } from "@/lib/board-vocabulary";
import { themeStyle } from "@/lib/public-theme";

export const metadata: Metadata = {
  title: "Your passes — Daali",
  // A ticket page is a credential. Keep it out of search results.
  robots: { index: false, follow: false },
};

export default async function PassesPage({ params }: Props) {
  const { batch } = await params;

  // TWO KINDS OF ADDRESS, one screen.
  //
  //   squareBatchId   a purchase that included squares - the original key
  //   id              a STANDALONE Entry Ticket purchase, which has no batch
  //
  // Both are unguessable server-generated UUIDs known at the moment the email
  // is sent, so the credential model is unchanged. What the screen shows is
  // unchanged too: every pass the SUPPORTER currently holds, whichever door
  // they came in by, so someone who bought squares in August and Entry Tickets
  // in September sees one set rather than two.
  //
  // The id clause is added only when the value could BE a uuid. `id` is
  // `@db.Uuid` and Prisma raises P2023 rather than matching nothing when the
  // value will not cast, so an unconditional clause would turn every junk URL
  // from a clean 404 into a 500. `squareBatchId` is plain text and needs no
  // such guard.
  const isUuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(batch);

  const grant = await prisma.admissionGrant.findFirst({
    where: {
      OR: [{ squareBatchId: batch }, ...(isUuid ? [{ id: batch }] : [])],
    },
    select: {
      eventSupporterId: true,
      event: {
        select: {
          name: true,
          startsAt: true,
          venue: true,
          timezone: true,
          // themeId: public theme, spec §6. Null until one is assigned.
          board: { select: { gameName: true, themeId: true } },
        },
      },
    },
  });

  if (!grant) notFound();

  // Ordinals come from the supporter's current usable passes in sequence
  // order — never from sequenceNumber, which is monotonic and leaves gaps once
  // anything is voided. Someone whose count changed must not see "Ticket 5 of
  // 4" or a hole where a voided pass used to be.
  const passes = await prisma.admissionPass.findMany({
    where: {
      eventSupporterId: grant.eventSupporterId,
      status: { in: ["active", "used"] },
    },
    select: { token: true, status: true, label: true },
    orderBy: { sequenceNumber: "asc" },
  });

  const event = grant.event;

  // Null theme -> no attributes on the root, exactly today's page (invariant 1).
  const theme = event.board.themeId
    ? await prisma.publicTheme.findUnique({
        where: { themeId: event.board.themeId },
        select: { primaryColor: true, surface: true },
      })
    : null;
  const eventName = event.name ?? event.board.gameName;

  const when = new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: event.timezone,
  }).format(event.startsAt);

  return (
    <div className="min-h-screen bg-tone-950 text-tone-fg" {...themeStyle(theme)}>
      <div className="max-w-lg mx-auto px-4 py-6">
        <h1 className="text-xl font-bold leading-tight">{eventName}</h1>
        <p className="text-sm text-tone-400 mt-1.5">{when}</p>
        {event.venue && (
          <p className="text-sm text-tone-500 mt-0.5">{event.venue}</p>
        )}

        {passes.length === 0 ? (
          <div className="mt-6 rounded-lg border border-tone-800 bg-tone-900 p-4">
            <p className="text-sm">No passes on this purchase.</p>
            <p className="text-xs text-tone-500 mt-1">
              Admissions were donated. Your contribution still counts toward the
              goal.
            </p>
          </div>
        ) : (
          <>
            <p className="text-sm text-tone-400 mt-5">
              {passes.length} {passes.length === 1 ? ADMISSION.one : ADMISSION.many}. Each
              admits one person — share one on its own and keep the rest.
            </p>
            {/* ONE AT A TIME. The stacked list let a gate scanner catch a
                neighbouring code — admission addendum §7. */}
            <PassViewer
              passes={passes.map((p) => ({
                token: p.token,
                used: p.status === "used",
                label: p.label,
              }))}
            />
          </>
        )}

        <p className="text-xs text-tone-600 mt-6 leading-relaxed">
          Keep this link. It always shows your current passes, so you can come
          back to it if the email is gone.
        </p>
      </div>
    </div>
  );
}
