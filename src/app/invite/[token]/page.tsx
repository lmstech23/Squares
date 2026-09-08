import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { prisma } from "@/lib/prisma";
import { getHostOrNull } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { hashInviteToken } from "@/lib/board-invites";
import AcceptInvite from "./accept-invite";

export const dynamic = "force-dynamic";

// The invitation landing page — collaborators v2.2 §5.
//
// THIS PAGE NEVER CONSUMES THE INVITATION. It reads, it renders, and it offers a
// button; acceptance is a POST behind a click. A link prefetcher, a mail
// scanner, or a chat app generating a preview would otherwise spend an
// invitation before the recipient had read it. Ruled 2026-09-08, and the reason
// there is no GET on the accept route at all.
//
// UNAUTHENTICATED VISITORS ARE SENT TO LOGIN CARRYING THIS PATH, so the
// invitation survives the round trip. That is what `next` is for, and
// `safeReturnPath` is why it cannot become an open redirect.

export const metadata: Metadata = {
  title: "Board invitation — Daali",
  // Carries a board name and possibly an email address. Keep it out of search.
  robots: { index: false, follow: false },
};

export default async function InvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  const invite = await prisma.boardInvite.findUnique({
    where: { tokenHash: hashInviteToken(token) },
    select: {
      boundEmail: true,
      acceptedAt: true,
      revokedAt: true,
      expiresAt: true,
      board: { select: { gameName: true } },
      createdBy: { select: { name: true } },
    },
  });

  // ONE ANSWER FOR "no such invitation". A token that never existed and one that
  // was mistyped are the same thing to a visitor, and distinguishing them would
  // let someone probe for valid tokens.
  if (!invite) return <Dead title="This invitation link is not valid." />;

  // ACCEPTED, REVOKED AND EXPIRED READ AS ONE STATE to the visitor — invariant
  // 99. Which of the three it is says something about a link they hold and is
  // not theirs to learn.
  const dead =
    invite.acceptedAt !== null ||
    invite.revokedAt !== null ||
    invite.expiresAt <= new Date();
  if (dead) {
    return (
      <Dead
        title="This invitation is no longer available."
        detail="It may have been used, cancelled, or expired. Ask the board owner for a new one."
      />
    );
  }

  const host = await getHostOrNull();

  // NOT SIGNED IN. Sent to login carrying this exact path, so the invitation is
  // still there when they come back. The bound email is shown FIRST, because
  // someone who signs in with the wrong identity has wasted a round trip and
  // will not know why they were refused.
  if (!host) {
    redirect(`/login?next=${encodeURIComponent(`/invite/${token}`)}`);
  }

  // The VERIFIED email of the authenticated identity — invariant 98. Never
  // `Host.email`, which holds `user.email ?? user.phone ?? user.id` and is not
  // evidence of anything.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const verifiedEmail = user?.email ?? null;

  const bound = invite.boundEmail;
  const identityMatches =
    !bound || (verifiedEmail?.trim().toLowerCase() === bound.trim().toLowerCase());

  return (
    <div className="min-h-screen bg-gray-950 text-white flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <p className="text-sm text-gray-400">You have been invited to help run</p>
        <h1 className="mt-1 text-2xl font-bold leading-tight">
          {invite.board.gameName}
        </h1>
        {invite.createdBy.name && (
          <p className="mt-1 text-sm text-gray-500">
            Invited by {invite.createdBy.name}
          </p>
        )}

        <div className="mt-5 rounded-lg border border-gray-800 bg-gray-900 p-4">
          <p className="text-sm font-medium">As a manager you can</p>
          <ul className="mt-2 space-y-1 text-xs text-gray-400 leading-relaxed">
            <li>· Record and confirm payments</li>
            <li>· Manage the roster, passes and volunteer sign-ups</li>
            <li>· Edit the board&apos;s description and goal</li>
          </ul>
          {/* SAID PLAINLY, because it is the question a manager asks on day one
              and the answer is not obvious from anything else on this page. */}
          <p className="mt-3 text-xs text-gray-500 leading-relaxed">
            Contributions go to the owner&apos;s account. You manage the board;
            you don&apos;t receive the money.
          </p>
        </div>

        {identityMatches ? (
          <AcceptInvite token={token} />
        ) : (
          /* NOT A GENERIC 403. Someone signed in by phone, or as the wrong
             address, has done nothing wrong and cannot guess what to change.
             The invited address is named, and the way out is a link. */
          <div className="mt-5 rounded-lg border border-amber-900/60 bg-amber-950/20 p-4">
            <p className="text-sm text-amber-200">
              This invitation was sent to <strong>{bound}</strong>.
            </p>
            <p className="mt-1.5 text-xs text-amber-200/80 leading-relaxed">
              You are signed in as{" "}
              <strong>{verifiedEmail ?? "a phone number"}</strong>. Sign in with
              the invited email address to accept it.
            </p>
            <a
              href={`/login?next=${encodeURIComponent(`/invite/${token}`)}`}
              className="inline-block mt-3 rounded-lg border border-amber-700 px-3 py-1.5 text-xs text-amber-100 hover:border-amber-500 transition-colors"
            >
              Sign in as {bound}
            </a>
          </div>
        )}
      </div>
    </div>
  );
}

function Dead({ title, detail }: { title: string; detail?: string }) {
  return (
    <div className="min-h-screen bg-gray-950 text-white flex items-center justify-center px-4">
      <div className="w-full max-w-sm text-center">
        <h1 className="text-lg font-semibold">{title}</h1>
        {detail && (
          <p className="mt-2 text-sm text-gray-400 leading-relaxed">{detail}</p>
        )}
      </div>
    </div>
  );
}
