// OWNER: create, list and cancel manager invitations.
//
// collaborators v2.2 §5. Invariants 96–100.
//
// POST   { boundEmail? }   -> creates, returns the raw token ONCE
// GET                      -> the pending list
// DELETE { inviteId }      -> cancels an unused invitation
//
// `collaborators.manage` throughout — OWNER only. Invariant 106: a manager who
// could invite managers could add themselves an ally, and the delegation graph
// becomes something nobody drew.
//
// DELIVERY IS COPY-AND-SHARE. The app sends no invitation email or SMS in this
// slice — ruled 2026-09-08. The raw URL is returned once and the owner sends it
// however they like. That keeps this independent of the communications backlog
// and matches the token model exactly: shown once, never stored, only the hash
// persists.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireBoardAccess } from "@/lib/board-access";
import {
  generateInviteToken,
  hashInviteToken,
  INVITE_TTL_DAYS,
} from "@/lib/board-invites";

export const runtime = "nodejs";

interface Props {
  params: Promise<{ id: string }>;
}

/** Emails must outlive this deploy, so the configured URL wins over the host
 *  header — the same rule the confirmation emails follow. */
function baseUrl(request: Request): string {
  return (
    process.env.NEXT_PUBLIC_URL ??
    request.headers.get("origin") ??
    "https://beta.daali.app"
  );
}

export async function POST(request: Request, { params }: Props) {
  try {
    const { id: boardId } = await params;

    const access = await requireBoardAccess(boardId, "collaborators.manage");
    if (!access.ok) {
      return NextResponse.json({ error: access.error }, { status: access.status });
    }

    const body = (await request.json().catch(() => ({}))) as {
      boundEmail?: string | null;
    };

    // BINDING IS OPTIONAL AND DEFAULTS TO OFF at the API. §5 wants it default-on
    // in the UI when the owner types an email, which is a form decision; here,
    // absent means a bearer link, deliberately.
    const raw = body.boundEmail?.trim().toLowerCase() || null;
    if (raw !== null && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) {
      return NextResponse.json(
        { error: "Enter a valid email address, or leave it blank for a link anyone can use." },
        { status: 400 }
      );
    }

    // NO DUPLICATE PRE-CHECK, DELIBERATELY.
    //
    // "Does this person already manage the board?" cannot be answered before
    // acceptance: there is no trustworthy pre-authentication identity key. The
    // only candidate is `Host.email`, and that column is neither unique nor
    // reliably an email — it holds `user.email ?? user.phone ?? user.id`. Matching
    // on it would refuse an invitation for the wrong person, or pass one for
    // somebody else entirely.
    //
    // DUPLICATE LIVE GRANTS ARE PREVENTED AUTHORITATIVELY AT ACCEPTANCE, by
    // `board_collaborators_live_grant_key`. A courtesy check here would have
    // been advisory at best and wrong at worst, and it is better to let someone
    // send a redundant invitation than to block a valid one.

    const token = generateInviteToken();
    const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 864e5);

    const invite = await prisma.boardInvite.create({
      data: {
        boardId,
        role: "MANAGER",
        tokenHash: hashInviteToken(token),
        boundEmail: raw,
        createdByHostId: access.hostId,
        expiresAt,
      },
      select: { id: true, boundEmail: true, expiresAt: true, createdAt: true },
    });

    // THE RAW TOKEN, ONCE. It is not stored and cannot be recovered; an owner
    // who loses it cancels and makes another, which is the correct outcome for
    // a credential.
    return NextResponse.json({
      invite,
      url: `${baseUrl(request)}/invite/${token}`,
    });
  } catch (error) {
    console.error("invite create error:", error);
    return NextResponse.json({ error: "Something went wrong." }, { status: 500 });
  }
}

export async function GET(_request: Request, { params }: Props) {
  try {
    const { id: boardId } = await params;

    const access = await requireBoardAccess(boardId, "collaborators.manage");
    if (!access.ok) {
      return NextResponse.json({ error: access.error }, { status: access.status });
    }

    // PENDING ONLY. An accepted invite is history and its link is worthless; a
    // revoked one is a cancellation. Neither is actionable, and listing them
    // would invite an owner to try to "un-cancel" something terminal.
    //
    // NO TOKEN OR HASH IS SELECTED. The hash is not a credential, but returning
    // it invites a reader to treat it as one.
    const invites = await prisma.boardInvite.findMany({
      where: { boardId, acceptedAt: null, revokedAt: null },
      orderBy: { createdAt: "desc" },
      select: { id: true, boundEmail: true, expiresAt: true, createdAt: true },
    });

    return NextResponse.json({ invites });
  } catch (error) {
    console.error("invite list error:", error);
    return NextResponse.json({ error: "Something went wrong." }, { status: 500 });
  }
}

export async function DELETE(request: Request, { params }: Props) {
  try {
    const { id: boardId } = await params;

    const access = await requireBoardAccess(boardId, "collaborators.manage");
    if (!access.ok) {
      return NextResponse.json({ error: access.error }, { status: access.status });
    }

    const { inviteId } = (await request.json()) as { inviteId?: string };
    if (!inviteId) {
      return NextResponse.json({ error: "An invitation is required." }, { status: 400 });
    }

    // SCOPED TO THIS BOARD AND CONDITIONAL ON BEING UNUSED. An invite id from
    // another board reads as not found rather than as a permission error, and a
    // cancel racing an acceptance matches zero rows — the acceptance stands.
    const { count } = await prisma.boardInvite.updateMany({
      where: { id: inviteId, boardId, acceptedAt: null, revokedAt: null },
      data: { revokedAt: new Date(), revokedByHostId: access.hostId },
    });

    if (count === 0) {
      return NextResponse.json(
        { error: "That invitation is no longer pending." },
        { status: 409 }
      );
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("invite cancel error:", error);
    return NextResponse.json({ error: "Something went wrong." }, { status: 500 });
  }
}
