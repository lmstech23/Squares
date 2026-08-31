import { prisma } from "@/lib/prisma";
import { notFound } from "next/navigation";
import type { Metadata } from "next";

export const dynamic = "force-dynamic";

// A single ticket — the thing that gets forwarded.
//
// Mom buys four and sends this link to her daughter. The daughter should see
// one ticket and nothing else: not the other three, not who bought them, not
// the contribution. She holds an entitlement to walk through a gate, and that
// is the whole of what this page is.

interface Props {
  params: Promise<{ token: string }>;
}

export const metadata: Metadata = {
  title: "Your pass — Daali",
  // A ticket is a credential. Keep it out of search results.
  robots: { index: false, follow: false },
};

export default async function TicketPage({ params }: Props) {
  const { token } = await params;

  const pass = await prisma.admissionPass.findUnique({
    where: { token },
    select: {
      status: true,
      label: true,
      supporter: {
        select: {
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
      },
    },
  });

  // A voided pass is gone, not merely inactive. `void` is terminal, so a
  // forwarded screenshot from before someone changed their mind must not
  // resolve to a page that looks like a ticket.
  if (!pass || pass.status === "void") notFound();

  const event = pass.supporter.event;
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
    <div className="min-h-screen bg-gray-950 text-white flex items-center justify-center px-4 py-8">
      <div className="w-full max-w-sm text-center">
        <h1 className="text-lg font-bold leading-tight">{eventName}</h1>
        <p className="text-sm text-gray-400 mt-1.5">{when}</p>
        {event.venue && (
          <p className="text-sm text-gray-500 mt-0.5">{event.venue}</p>
        )}

        <div className="mt-6 rounded-lg border border-gray-800 bg-gray-900 p-5">
          {/* No ordinal here. "Ticket 2 of 4" is meaningful to the person who
              bought four; to the cousin who was sent one it is noise about
              somebody else's purchase. */}
          <p className="text-sm font-medium">
            {pass.label ?? "Admits one person"}
          </p>

          <div className="mt-4 flex justify-center">
            {/* eslint-disable-next-line @next/next/no-img-element -- generated
                per token by an API route, not a static asset. */}
            <img
              src={`/api/tickets/${encodeURIComponent(token)}/qr`}
              alt="Admission pass QR code"
              width={240}
              height={240}
              className={`rounded bg-white p-3 ${pass.status === "used" ? "opacity-40" : ""}`}
            />
          </div>

          {pass.status === "used" && (
            <p className="text-xs text-gray-500 mt-3">
              Already scanned at the gate.
            </p>
          )}
        </div>

        <p className="text-xs text-gray-600 mt-4 leading-relaxed">
          Show this code at the gate. Keep the link — it is the pass.
        </p>
      </div>
    </div>
  );
}
