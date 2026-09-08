// OWNER: list and revoke managers.
//
// collaborators v2.2 §7. Invariants 107, 108, 109, 119.
//
// GET                        active grants on this board
// DELETE { collaboratorId }  revoke one
//
// `collaborators.manage` — OWNER only, invariant 106. A manager who could
// revoke managers could remove the others and then be revoked by nobody.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireBoardAccess } from "@/lib/board-access";
import { revokeCollaborator } from "@/lib/board-invites";

export const runtime = "nodejs";

interface Props {
  params: Promise<{ id: string }>;
}

export async function GET(_request: Request, { params }: Props) {
  try {
    const { id: boardId } = await params;

    const access = await requireBoardAccess(boardId, "collaborators.manage");
    if (!access.ok) {
      return NextResponse.json({ error: access.error }, { status: access.status });
    }

    // ACTIVE MANAGERS ONLY, and both halves of that are deliberate.
    //
    // ACTIVE: a revoked row is history the audit needs — invariant 108 — and
    // listing it would invite an owner to try to un-revoke something terminal.
    // Re-granting is a new invitation, not an undo.
    //
    // MANAGERS: the owner's own row cannot be revoked (that is ownership
    // transfer, and DELETE below refuses it), so returning it from a
    // list-and-revoke endpoint would put a Remove control on a row that always
    // says no. A control that lies is worse than one that is absent.
    const collaborators = await prisma.boardCollaborator.findMany({
      where: { boardId, status: "active", role: "MANAGER" },
      orderBy: { acceptedAt: "asc" },
      select: {
        id: true,
        role: true,
        acceptedAt: true,
        hostId: true,
        // The address they were INVITED at, which is the only email this board
        // has any reason to believe belongs to them. See the DELETE handler.
        host: {
          select: {
            invitesAccepted: {
              where: { boardId, boundEmail: { not: null } },
              select: { boundEmail: true },
              orderBy: { acceptedAt: "desc" },
              take: 1,
            },
          },
        },
      },
    });

    return NextResponse.json({
      collaborators: collaborators.map((c) => ({
        id: c.id,
        role: c.role,
        acceptedAt: c.acceptedAt,
        isSelf: c.hostId === access.hostId,
        invitedAs: c.host.invitesAccepted[0]?.boundEmail ?? null,
      })),
    });
  } catch (error) {
    console.error("collaborators list error:", error);
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

    const { collaboratorId } = (await request.json()) as { collaboratorId?: string };
    if (!collaboratorId) {
      return NextResponse.json({ error: "A collaborator is required." }, { status: 400 });
    }

    const target = await prisma.boardCollaborator.findFirst({
      where: { id: collaboratorId, boardId },
      select: { id: true, role: true, hostId: true, status: true },
    });
    if (!target) {
      return NextResponse.json({ error: "Collaborator not found." }, { status: 404 });
    }

    // THE OWNER'S OWN ROW CANNOT BE REVOKED — §7. That is ownership transfer,
    // which is out of scope, and revoking it would leave a board with no owner
    // and no way back in. The partial unique index would then happily accept a
    // second OWNER, so this guard is the only thing standing there.
    if (target.role === "OWNER") {
      return NextResponse.json(
        { error: "The board owner cannot be removed. That is ownership transfer." },
        { status: 409 }
      );
    }

    // THE EMAILS INVARIANT 119 MATCHES ON, AND WHERE THEY COME FROM.
    //
    // NOT `Host.email` — that column holds `user.email ?? user.phone ?? user.id`
    // and is not identity, which is the whole reason binding is enforced against
    // the authenticated Supabase email instead.
    //
    // The trustworthy answer is the invitation they actually accepted on THIS
    // board: a bound invite records the address it was sent to AND who consumed
    // it, so `boundEmail` on an accepted invite is an address this person proved
    // they control. Anything else is a guess, and §7 is explicit that no guess
    // is made.
    const accepted = await prisma.boardInvite.findMany({
      where: { boardId, acceptedByHostId: target.hostId, boundEmail: { not: null } },
      select: { boundEmail: true },
    });
    const revokedEmails = accepted
      .map((i) => i.boundEmail!)
      .filter((e, i, all) => all.indexOf(e) === i);

    const result = await prisma.$transaction((tx) =>
      revokeCollaborator(tx, {
        collaboratorId: target.id,
        boardId,
        revokedByHostId: access.hostId,
        revokedEmails,
      })
    );

    if (!result.revoked) {
      return NextResponse.json(
        { error: "That collaborator is no longer active." },
        { status: 409 }
      );
    }

    // `invitesRevoked` is returned so the UI can say what else was cancelled.
    // An owner who removes a manager and is not told that a pending invitation
    // went with them has been told half of what happened.
    return NextResponse.json({ ok: true, invitesRevoked: result.invitesRevoked });
  } catch (error) {
    console.error("collaborator revoke error:", error);
    return NextResponse.json({ error: "Something went wrong." }, { status: 500 });
  }
}
