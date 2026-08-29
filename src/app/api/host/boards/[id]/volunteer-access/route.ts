import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getHost } from "@/lib/auth";
import { newVolunteerToken, hashToken } from "@/lib/volunteer-access";

// ============================================================
// HOST: Create and revoke volunteer gate links — v2 §6B
//
// POST   { label }            -> creates, returns the raw link ONCE
// DELETE { volunteerAccessId } -> revokes
//
// The raw token is never stored. It is returned by the create call and cannot
// be retrieved again — a host who loses it revokes and makes another, which is
// the correct outcome for a credential.
// ============================================================

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

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: boardId } = await params;
    const auth = await authorize(boardId);
    if ("error" in auth) {
      return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const { label } = (await request.json()) as { label?: string };
    if (!label?.trim()) {
      return NextResponse.json(
        { error: "Give the link a name, like \"Renee — main gate\"." },
        { status: 400 }
      );
    }

    const token = newVolunteerToken();

    const access = await prisma.volunteerAccess.create({
      data: {
        eventId: auth.eventId,
        label: label.trim(),
        tokenHash: hashToken(token),
      },
      select: { id: true, label: true, createdAt: true },
    });

    // The only time the raw value exists outside the volunteer's phone.
    return NextResponse.json({ ok: true, access, token });
  } catch (error) {
    console.error("Volunteer access create error:", error);
    return NextResponse.json({ error: "Something went wrong." }, { status: 500 });
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: boardId } = await params;
    const auth = await authorize(boardId);
    if ("error" in auth) {
      return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const { volunteerAccessId } = (await request.json()) as {
      volunteerAccessId?: string;
    };
    if (!volunteerAccessId) {
      return NextResponse.json({ error: "No link given." }, { status: 400 });
    }

    // Revoked rather than deleted: check-in history references it, and the
    // host needs to see who admitted whom after the fact.
    const { count } = await prisma.volunteerAccess.updateMany({
      where: { id: volunteerAccessId, eventId: auth.eventId, revokedAt: null },
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
    console.error("Volunteer access revoke error:", error);
    return NextResponse.json({ error: "Something went wrong." }, { status: 500 });
  }
}
