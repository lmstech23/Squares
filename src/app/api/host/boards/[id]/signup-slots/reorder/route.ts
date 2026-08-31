// src/app/api/host/boards/[id]/signup-slots/reorder/route.ts
// ============================================================
// HOST: reorder the slots on a sheet.
//
// POST { slotIds: string[] }  — the FULL ordered list for this sheet.
//
// FULL-LIST DETERMINISTIC REWRITE, not a move-one operation. The client sends
// the whole order, the server validates it names exactly this sheet's slots,
// and sortOrder is rewritten as 0..n-1. Ruling 7.
//
// Validated as SETS, not by length. A submission that swaps one id for a
// foreign one has the right length and would pass a count check while silently
// dropping a slot from the order and touching one the host does not own.
//
// Normalizing to 0..n-1 after every reorder means gaps and duplicates cannot
// accumulate, which is why no (sheetId, sortOrder) uniqueness constraint is
// needed. Ordering only ever needs relative comparison.
//
// Two concurrent reorders: both validate against the same set, both rewrite in
// full, last commit wins. That is a lost update, not corruption — a full
// rewrite cannot leave a half-applied order. A slot added or removed between
// page load and submit fails set validation and the host is told to refresh,
// which is correct: applying a stale order would drop the new slot to an
// arbitrary position.
// ============================================================

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authorizeBoardEvent } from "@/lib/host-auth";
import { validateReorder, normalizeSortOrder } from "@/lib/signups";

interface Props {
  params: Promise<{ id: string }>;
}

export async function POST(request: Request, { params }: Props) {
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
      return NextResponse.json({ error: "This event has no sign-up sheet yet." }, { status: 404 });
    }

    const body = (await request.json()) as { slotIds?: unknown };
    if (!Array.isArray(body.slotIds) || body.slotIds.some((x) => typeof x !== "string")) {
      return NextResponse.json({ error: "Send the ordered slot ids." }, { status: 400 });
    }
    const submitted = body.slotIds as string[];

    // The whole validation happens inside the transaction that writes, so the
    // set the order was checked against is the set being rewritten.
    const outcome = await prisma.$transaction(async (tx) => {
      const actual = await tx.signupSlot.findMany({
        where: { sheetId: sheet.id },
        select: { id: true },
      });

      const check = validateReorder(submitted, actual.map((s) => s.id));
      if (!check.ok) return { ok: false as const, reason: check.reason };

      for (const { id: slotId, sortOrder } of normalizeSortOrder(submitted)) {
        await tx.signupSlot.update({ where: { id: slotId }, data: { sortOrder } });
      }
      return { ok: true as const };
    });

    if (!outcome.ok) {
      return NextResponse.json({ error: outcome.reason }, { status: 409 });
    }

    const slots = await prisma.signupSlot.findMany({
      where: { sheetId: sheet.id },
      orderBy: { sortOrder: "asc" },
      select: { id: true, sortOrder: true },
    });

    return NextResponse.json({ slots });
  } catch (error) {
    console.error("signup-slots reorder error:", error);
    return NextResponse.json({ error: "Something went wrong." }, { status: 500 });
  }
}
