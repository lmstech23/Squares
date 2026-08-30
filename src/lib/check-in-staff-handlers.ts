import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getHost } from "@/lib/auth";
import { newCheckinStaffToken, hashToken } from "@/lib/check-in-staff";

// Shared implementation for the check-in staff link routes.
//
// Extracted so /api/host/boards/[id]/check-in-staff and the temporary
// /volunteer-access alias are the same code rather than two copies. Sign-up
// addendum §2 keeps the old path alive because a dashboard loaded before the
// deploy will still call it; two implementations would drift, and the one that
// drifts is whichever gets tested less.

async function authorize(boardId: string) {
  const host = await getHost();
  if (!host) return { error: "Unauthorized" as const, status: 401 };

  const board = await prisma.board.findUnique({
    where: { boardId },
    select: { hostId: true, event: { select: { id: true } } },
  });

  if (!board || board.hostId !== host.id) {
    return { error: "Board not found." as const, status: 404 };
  }
  if (!board.event) {
    return { error: "This board has no event." as const, status: 400 };
  }
  return { eventId: board.event.id };
}

/** Create a staff link. The raw token is returned once and never stored. */
export async function createCheckinStaffLink(request: Request, boardId: string) {
  try {
    const auth = await authorize(boardId);
    if ("error" in auth) {
      return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const { label } = (await request.json()) as { label?: string };
    if (!label?.trim()) {
      return NextResponse.json(
        { error: 'Give the link a name, like "Renee — main gate".' },
        { status: 400 }
      );
    }

    const token = newCheckinStaffToken();

    const access = await prisma.checkinStaffAccess.create({
      data: {
        eventId: auth.eventId,
        label: label.trim(),
        tokenHash: hashToken(token),
      },
      select: { id: true, label: true, createdAt: true },
    });

    // The only time the raw value exists outside the staff member's phone.
    return NextResponse.json({ ok: true, access, token });
  } catch (error) {
    console.error("Check-in staff create error:", error);
    return NextResponse.json({ error: "Something went wrong." }, { status: 500 });
  }
}

/** Revoke a staff link. Revoked, never deleted — check-in history refers to it. */
export async function revokeCheckinStaffLink(request: Request, boardId: string) {
  try {
    const auth = await authorize(boardId);
    if ("error" in auth) {
      return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const body = (await request.json()) as {
      checkinStaffId?: string;
      /** Accepted from a dashboard loaded before the rename deployed. */
      volunteerAccessId?: string;
    };
    const id = body.checkinStaffId ?? body.volunteerAccessId;

    if (!id) {
      return NextResponse.json({ error: "No link given." }, { status: 400 });
    }

    const { count } = await prisma.checkinStaffAccess.updateMany({
      where: { id, eventId: auth.eventId, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    if (count === 0) {
      return NextResponse.json(
        { error: "That link is already revoked." },
        { status: 409 }
      );
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Check-in staff revoke error:", error);
    return NextResponse.json({ error: "Something went wrong." }, { status: 500 });
  }
}
