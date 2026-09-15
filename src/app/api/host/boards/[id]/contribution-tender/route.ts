import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireBoardAccess } from "@/lib/board-access";
import { parseTender, parseTenderReference, type OfflineTender } from "@/lib/tender";

// ============================================================
// HOST: correct the tender or the reference on an offline contribution.
// fundraiser-payment-method-addendum.md v1.2.7 §6.
//
// PATCH { contributionId, tender?, tenderReference? }
//
// TWO FIELDS, AND THAT ASYMMETRY IS THE WHOLE SAFETY ARGUMENT. A correction
// that cannot touch a dollar or a state cannot break reconciliation, so it
// needs no confirmation modal and no close-flow gate. Settlement, amount,
// status, contributor identity and every date are NOT correctable here.
//
// FORBIDDEN FIELDS ARE REFUSED, NEVER IGNORED. A request naming `amount` gets
// a 400 that says so. Dropping it silently would let a caller believe money
// moved when it did not - the worst outcome available on a money surface.
//
// AUTHORIZATION IS THE BOARD'S, NOT THE ROW'S. Any organizer who may manage
// this board may correct any offline contribution on it, whoever recorded it.
// `recordedByHostId` answers who recorded the money; this log answers who
// later changed how it is described. Making the original recorder the owner
// of the row would leave a correction impossible the day she is unavailable,
// which is exactly when a ledger gets fixed.
//
// EVERY ACTUAL CHANGE IS LOGGED, one row per field. Changing both writes two.
// A request that sets a field to the value it already holds writes nothing:
// an audit trail of non-events is an audit trail nobody reads.
// ============================================================

export const runtime = "nodejs";

/** The only keys this route accepts. Anything else is refused by name. */
const ALLOWED = new Set(["contributionId", "tender", "tenderReference"]);

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: boardId } = await params;

    // `cash.record` is the manage-the-money capability both OWNER and MANAGER
    // hold. The board's existing authorization is the boundary; nothing here
    // consults recordedByHostId.
    const access = await requireBoardAccess(boardId, "cash.record");
    if (!access.ok) {
      return NextResponse.json({ error: access.error }, { status: access.status });
    }

    const body: Record<string, unknown> = await request.json();
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return NextResponse.json({ error: "A correction body is required." }, { status: 400 });
    }

    // REFUSED BY NAME, in the order the caller sent them.
    const forbidden = Object.keys(body).filter((k) => !ALLOWED.has(k));
    if (forbidden.length) {
      return NextResponse.json(
        {
          error:
            `Only tender and tenderReference are correctable here. Refused: ${forbidden.join(", ")}. ` +
            "Settlement, amounts, status, contributor identity and dates are not correctable through this path.",
          refusedFields: forbidden,
        },
        { status: 400 }
      );
    }

    if (typeof body.contributionId !== "string" || !body.contributionId) {
      return NextResponse.json({ error: "A contribution id is required." }, { status: 400 });
    }

    const wantsTender = "tender" in body;
    const wantsReference = "tenderReference" in body;
    if (!wantsTender && !wantsReference) {
      return NextResponse.json({ error: "Nothing to correct." }, { status: 400 });
    }

    // CARD is refused here as everywhere else: it belongs to Stripe alone, and
    // a correction is not a way in through the back.
    let nextTender: OfflineTender | null = null;
    if (wantsTender) {
      const parsed = parseTender(body.tender, undefined);
      if (!parsed.ok) {
        return NextResponse.json({ error: parsed.error }, { status: 400 });
      }
      nextTender = parsed.tender;
    }

    let nextReference: string | null = null;
    if (wantsReference) {
      const parsed = parseTenderReference(body.tenderReference);
      if (!parsed.ok) {
        return NextResponse.json({ error: parsed.error }, { status: 400 });
      }
      nextReference = parsed.reference;
    }

    // Scoped to THIS board before anything else: an id from another host's
    // board must read as not found, never as a permission error.
    const row = await prisma.contribution.findFirst({
      where: { id: body.contributionId, boardId },
      select: { id: true, settlement: true, tender: true, tenderReference: true },
    });
    if (!row) {
      return NextResponse.json({ error: "Contribution not found." }, { status: 404 });
    }

    // A witnessed row's method is Stripe's record. Correcting it would put a
    // non-CARD tender on a STRIPE row, which the check constraint refuses
    // anyway - this is the honest refusal rather than a constraint violation.
    if (row.settlement !== "OFFLINE") {
      return NextResponse.json(
        { error: "A card contribution's method is Stripe's record and is not correctable." },
        { status: 409 }
      );
    }

    const tenderChanged = wantsTender && nextTender !== row.tender;
    const referenceChanged = wantsReference && nextReference !== row.tenderReference;

    if (!tenderChanged && !referenceChanged) {
      // Idempotent and silent: nothing changed, so nothing is logged.
      return NextResponse.json({
        ok: true,
        changed: 0,
        tender: row.tender,
        tenderReference: row.tenderReference,
      });
    }

    const updated = await prisma.$transaction(async (tx) => {
      const data: { tender?: OfflineTender; tenderReference?: string | null } = {};
      if (tenderChanged) data.tender = nextTender!;
      if (referenceChanged) data.tenderReference = nextReference;

      const after = await tx.contribution.update({
        where: { id: row.id },
        data,
        select: { tender: true, tenderReference: true },
      });

      // ONE ROW PER FIELD, inside the same transaction as the change. A log
      // written afterwards is a log that can be missing.
      if (tenderChanged) {
        await tx.tenderCorrectionLog.create({
          data: {
            contributionId: row.id,
            hostId: access.hostId,
            field: "TENDER",
            oldValue: row.tender,
            newValue: nextTender,
          },
        });
      }
      if (referenceChanged) {
        await tx.tenderCorrectionLog.create({
          data: {
            contributionId: row.id,
            hostId: access.hostId,
            field: "REFERENCE",
            oldValue: row.tenderReference,
            newValue: nextReference,
          },
        });
      }
      return after;
    });

    return NextResponse.json({
      ok: true,
      changed: (tenderChanged ? 1 : 0) + (referenceChanged ? 1 : 0),
      tender: updated.tender,
      tenderReference: updated.tenderReference,
    });
  } catch (error) {
    console.error("Tender correction error:", error);
    return NextResponse.json(
      { error: "Something went wrong. Please try again." },
      { status: 500 }
    );
  }
}
