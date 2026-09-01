// src/app/signup/[token]/page.tsx
//
// The supporter sign-up sheet. Sign-up addendum §6.
//
// No login, no password, no account — the emailed SupporterAccessToken is the
// whole session, exactly as the gate link is for check-in staff.
//
// RENDERING AND CLAIMING ARE SEPARATE GATES. A valid, unexpired, unrevoked
// token opens this page regardless of supporter status. A supporter whose
// contribution was disputed keeps her commitments (§10, invariant 44) and must
// be able to see and withdraw them; refusing to render would hide the very rows
// the host is meant to review. Whether she may sign up for anything NEW is a
// second question, answered by mayClaim().

import type { Metadata } from "next";
import { prisma } from "@/lib/prisma";
import {
  resolveSupporterSession,
  classifyTokenFailure,
  slotAvailability,
  mayClaim,
} from "@/lib/signups";
import SignupSheetView from "./sheet-view";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Volunteer sign-up — Daali",
  // A sign-up link is a credential. Keep it out of search results.
  robots: { index: false, follow: false },
};

interface Props {
  params: Promise<{ token: string }>;
}

function Message({ title, body }: { title: string; body: string }) {
  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <div className="max-w-lg mx-auto px-4 py-16">
        <h1 className="text-lg font-semibold">{title}</h1>
        <p className="text-sm text-gray-400 mt-2 leading-relaxed">{body}</p>
      </div>
    </div>
  );
}

export default async function SignupPage({ params }: Props) {
  const { token } = await params;

  const session = await resolveSupporterSession(token);

  if (!session) {
    const why = await classifyTokenFailure(token);
    // Expired and revoked get their own copy — someone holding a link that used
    // to work should be told to ask for a new one, not that it was never valid.
    // Unknown and malformed are identical, so nothing leaks about which hashes
    // exist.
    if (why === "expired")
      return (
        <Message
          title="This link has expired"
          body="Ask the host for a new one and we'll send it over."
        />
      );
    if (why === "revoked")
      return (
        <Message
          title="This link is no longer active"
          body="Ask the host for a new one and we'll send it over."
        />
      );
    return (
      <Message
        title="This link isn't valid"
        body="Check the link in your email, or ask the host to send it again."
      />
    );
  }

  const sheet = await prisma.signupSheet.findUnique({
    where: { eventId: session.eventId },
    select: {
      title: true,
      instructions: true,
      isOpen: true,
      event: { select: { name: true, venue: true, startsAt: true, timezone: true } },
      slots: {
        orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
        select: {
          id: true, name: true, slotType: true, capacity: true,
          startsAt: true, endsAt: true, unitLabel: true, notes: true,
          _count: { select: { positions: true } },
          signups: {
            where: { eventSupporterId: session.supporterId },
            select: { _count: { select: { positions: true } } },
          },
        },
      },
    },
  });

  // A host can issue tokens and never build a sheet. Reachable, so it gets a
  // sentence rather than a 404 page.
  if (!sheet) {
    return (
      <Message
        title="Nothing to sign up for yet"
        body="The host hasn't added any volunteer needs. Keep this link — it'll work when she does."
      />
    );
  }

  const canClaim = mayClaim(session.status);

  return (
    <SignupSheetView
      token={token}
      firstName={session.name.split(" ")[0] ?? session.name}
      title={sheet.title ?? "Volunteer Sign-Up"}
      instructions={sheet.instructions}
      isOpen={sheet.isOpen}
      canClaim={canClaim}
      eventName={sheet.event.name}
      eventVenue={sheet.event.venue}
      eventTimezone={sheet.event.timezone}
      slots={sheet.slots.map((sl) => {
        const yourCurrent = sl.signups[0]?._count.positions ?? 0;
        const a = slotAvailability(
          sl.capacity,
          sl._count.positions,
          yourCurrent,
          sl.slotType as "SHIFT" | "ITEM"
        );
        return {
          id: sl.id,
          name: sl.name,
          slotType: sl.slotType as "SHIFT" | "ITEM",
          unitLabel: sl.unitLabel,
          notes: sl.notes,
          startsAt: sl.startsAt ? sl.startsAt.toISOString() : null,
          endsAt: sl.endsAt ? sl.endsAt.toISOString() : null,
          capacity: a.capacity,
          filled: a.filled,
          available: a.available,
          yourCurrent: a.yourCurrent,
          maxTarget: a.maxTarget,
        };
      })}
    />
  );
}
