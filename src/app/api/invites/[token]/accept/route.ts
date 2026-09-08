// RECIPIENT: accept a manager invitation.
//
// POST /api/invites/[token]/accept
//
// POST-ONLY, AND THAT IS THE POINT — ruled 2026-09-08. Opening the invite page
// must never consume the invitation: a link prefetcher, a mail scanner, or a
// chat app generating a preview would otherwise spend it before the recipient
// read it. There is no GET here, so acceptance can only follow a click.
//
// THE IDENTITY COMES FROM SUPABASE, NOT FROM THE LINK — invariant 98. The token
// says which invitation; the session says who. A bound invitation additionally
// requires the session's VERIFIED EMAIL to match, and `Host.email` is never
// consulted: that column is not unique and may hold a phone number or a UUID.
//
// NO HOST IS EVER CREATED HERE. `getHostOrNull` resolves the row the ordinary
// lazy upsert already made on this person's first authenticated request. An
// invite path that created a Host would mint two free board credits with no
// CreditTransaction row, because `board_credits` is NOT NULL DEFAULT 2.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getHostOrNull } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { acceptInvite, hashInviteToken } from "@/lib/board-invites";

export const runtime = "nodejs";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ token: string }> }
) {
  try {
    const { token } = await params;

    const host = await getHostOrNull();
    if (!host) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // THE VERIFIED EMAIL OF THE AUTHENTICATED IDENTITY. Read from Supabase
    // directly rather than from the Host row: `Host.email` is written as
    // `user.email ?? user.phone ?? user.id`, so it is not evidence of anything.
    // Null when they signed in by phone, which a bound invitation refuses.
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    const verifiedEmail = user?.email ?? null;

    const result = await prisma.$transaction((tx) =>
      acceptInvite(tx, {
        tokenHash: hashInviteToken(token),
        hostId: host.id,
        verifiedEmail,
      })
    );

    if (result.ok) {
      return NextResponse.json({ ok: true, boardId: result.boardId });
    }

    // Each refusal gets its own sentence. A generic 403 strands someone who has
    // done nothing wrong and cannot guess what to change — most of all the
    // person signed in by phone against a bound invitation.
    switch (result.reason) {
      case "not-found":
        return NextResponse.json(
          { error: "This invitation link is not valid." },
          { status: 404 }
        );
      case "unusable":
        return NextResponse.json(
          {
            error:
              "This invitation is no longer available. It may have been used, " +
              "cancelled, or expired. Ask the board owner for a new one.",
          },
          { status: 409 }
        );
      case "wrong-identity":
        return NextResponse.json(
          {
            error:
              `This invitation was sent to ${result.boundEmail}. Sign in with ` +
              `that email address to accept it.`,
            boundEmail: result.boundEmail,
          },
          { status: 403 }
        );
      case "already-collaborator":
        return NextResponse.json(
          { error: "You already manage this board.", status: "already", boardId: result.boardId },
          { status: 409 }
        );
    }
  } catch (error) {
    console.error("invite accept error:", error);
    return NextResponse.json({ error: "Something went wrong." }, { status: 500 });
  }
}
