// src/app/api/host/boards/[id]/signup-sheet/route.ts
// ============================================================
// HOST: create a volunteer sign-up sheet, and edit its title, instructions,
// and open/closed state.
//
// POST   create the sheet          — explicit host action, never automatic
// PATCH  title / instructions / isOpen
//
// BOARD-SCOPED, reusing authorizeBoardEvent. Sign-up addendum §14 showed
// /api/host/events/[id]/..., which did not match the established architecture;
// an event-scoped resolver would be a second authorization concept for one
// feature. Ruling 4.
//
// A sheet is NOT created with the event. An event can exist without volunteer
// needs, and auto-creating one would put an empty sheet in front of every host
// who never wanted it. Ruling 5.
// ============================================================

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authorizeBoardEvent } from "@/lib/host-auth";
import {
  DEFAULT_SHEET_TITLE,
  MAX_SHEET_TITLE,
  MAX_SHEET_INSTRUCTIONS,
} from "@/lib/signups";

interface Props {
  params: Promise<{ id: string }>;
}

export async function POST(_request: Request, { params }: Props) {
  try {
    const { id } = await params;
    const auth = await authorizeBoardEvent(id);
    if ("error" in auth) {
      return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    // `eventId` is unique on SignupSheet, so a duplicate is a real conflict
    // rather than something to silently upsert past — a host who clicks twice
    // should keep the sheet she already has, notes and all.
    const existing = await prisma.signupSheet.findUnique({
      where: { eventId: auth.eventId },
      select: { id: true },
    });
    if (existing) {
      return NextResponse.json(
        { error: "This event already has a sign-up sheet." },
        { status: 409 }
      );
    }

    const sheet = await prisma.signupSheet.create({
      data: { eventId: auth.eventId, title: DEFAULT_SHEET_TITLE },
      select: { id: true, title: true, instructions: true, isOpen: true },
    });

    return NextResponse.json({ sheet });
  } catch (error) {
    console.error("signup-sheet POST error:", error);
    return NextResponse.json(
      { error: "Something went wrong. Please try again." },
      { status: 500 }
    );
  }
}

type PatchBody = {
  title?: string | null;
  instructions?: string | null;
  isOpen?: boolean;
};

export async function PATCH(request: Request, { params }: Props) {
  try {
    const { id } = await params;
    const auth = await authorizeBoardEvent(id);
    if ("error" in auth) {
      return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const sheet = await prisma.signupSheet.findUnique({
      where: { eventId: auth.eventId },
      select: { id: true },
    });
    if (!sheet) {
      return NextResponse.json(
        { error: "This event has no sign-up sheet yet." },
        { status: 404 }
      );
    }

    const body = (await request.json()) as PatchBody;
    const data: Record<string, unknown> = {};

    if ("title" in body) {
      const t = (body.title ?? "").trim();
      if (t.length > MAX_SHEET_TITLE) {
        return NextResponse.json(
          { error: `Keep the title under ${MAX_SHEET_TITLE} characters.` },
          { status: 400 }
        );
      }
      // Blank falls back to the default rather than to null: a sheet with no
      // heading reads as broken, not as minimal.
      data.title = t.length === 0 ? DEFAULT_SHEET_TITLE : t;
    }

    if ("instructions" in body) {
      const i = (body.instructions ?? "").trim();
      if (i.length > MAX_SHEET_INSTRUCTIONS) {
        return NextResponse.json(
          { error: `Keep instructions under ${MAX_SHEET_INSTRUCTIONS} characters.` },
          { status: 400 }
        );
      }
      data.instructions = i.length === 0 ? null : i;
    }

    // Closing stops SUPPORTER CLAIMING and nothing else — cancellation,
    // supporter viewing and host administration all continue. Reversible, so no
    // confirmation is asked for. Ruling 1.
    if ("isOpen" in body) {
      if (typeof body.isOpen !== "boolean") {
        return NextResponse.json({ error: "isOpen must be true or false." }, { status: 400 });
      }
      data.isOpen = body.isOpen;
    }

    if (Object.keys(data).length === 0) {
      return NextResponse.json({ error: "Nothing to update." }, { status: 400 });
    }

    const updated = await prisma.signupSheet.update({
      where: { id: sheet.id },
      data,
      select: { id: true, title: true, instructions: true, isOpen: true },
    });

    return NextResponse.json({ sheet: updated });
  } catch (error) {
    console.error("signup-sheet PATCH error:", error);
    return NextResponse.json(
      { error: "Something went wrong. Please try again." },
      { status: 500 }
    );
  }
}
