import { prisma } from "@/lib/prisma";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import PassRow from "./pass-row";

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

export const metadata: Metadata = {
  title: "Your tickets — Daali",
  // A ticket page is a credential. Keep it out of search results.
  robots: { index: false, follow: false },
};

export default async function PassesPage({ params }: Props) {
  const { batch } = await params;

  const grant = await prisma.admissionGrant.findUnique({
    where: { squareBatchId: batch },
    select: {
      eventSupporterId: true,
      event: {
        select: {
          name: true,
          startsAt: true,
          venue: true,
          timezone: true,
          board: { select: { gameName: true } },
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
    <div className="min-h-screen bg-gray-950 text-white">
      <div className="max-w-lg mx-auto px-4 py-6">
        <h1 className="text-xl font-bold leading-tight">{eventName}</h1>
        <p className="text-sm text-gray-400 mt-1.5">{when}</p>
        {event.venue && (
          <p className="text-sm text-gray-500 mt-0.5">{event.venue}</p>
        )}

        {passes.length === 0 ? (
          <div className="mt-6 rounded-lg border border-gray-800 bg-gray-900 p-4">
            <p className="text-sm">No tickets on this purchase.</p>
            <p className="text-xs text-gray-500 mt-1">
              Admissions were donated. Your contribution still counts toward the
              goal.
            </p>
          </div>
        ) : (
          <>
            <p className="text-sm text-gray-400 mt-5">
              {passes.length} {passes.length === 1 ? "ticket" : "tickets"}. Each
              admits one person — share one on its own and keep the rest.
            </p>
            <div className="mt-4 space-y-3">
              {passes.map((p, i) => (
                <PassRow
                  key={p.token}
                  token={p.token}
                  ordinal={i + 1}
                  total={passes.length}
                  used={p.status === "used"}
                  label={p.label}
                />
              ))}
            </div>
          </>
        )}

        <p className="text-xs text-gray-600 mt-6 leading-relaxed">
          Keep this link. It always shows your current tickets, so you can come
          back to it if the email is gone.
        </p>
      </div>
    </div>
  );
}
