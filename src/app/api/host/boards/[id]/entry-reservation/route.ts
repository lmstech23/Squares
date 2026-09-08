import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireBoardAccess } from "@/lib/board-access";
import { sendEmail } from "@/lib/email";
import {
  confirmEntryReservation,
  releaseEntryReservation,
  reservationTotalCents,
  ReservationNotPending,
} from "@/lib/entry-reservation";
import { sendPendingConfirmations } from "@/lib/confirmation-email";

// ============================================================
// HOST: resolve a direct-payment Entry Ticket reservation.
//
// PATCH /api/host/boards/[id]/entry-reservation
// Body: { reservationId, action: "confirm" | "release" }
//
// BINARY, AND WHOLE-RESERVATION. The schema can express a partly-paid
// reservation and its CHECK enforces the bounds, but this surface does not
// offer it: confirm means every line. The capability is kept because partial
// payment is real and will need a surface, and retrofitting the column later
// would mean migrating rows that had already lost the distinction.
//
// NO BOARD-STATUS GUARD ON CONFIRM, deliberately, and this is the one place
// that differs from every other money route here. The host is asserting that
// money is already in their account. Refusing because the campaign closed would
// leave a contributor who paid with no passes and no record — Ruling 5. The
// contribution is recorded and stamped `postCloseAt` instead, so it can be
// shown to the host separately without moving a sealed `finalRaisedCents`.
//
// RELEASE NOTIFIES THE BUYER. The dangerous case is someone who sent money and
// believes they are going; silence is the worst outcome available. A failed
// send does not roll back the release — the reservation is resolved either way
// and an un-released row would be worse than an un-sent email.
// ============================================================

export const runtime = "nodejs";

interface Body {
  reservationId?: string;
  action?: "confirm" | "release";
  reason?: string;
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: boardId } = await params;
    const board = await prisma.board.findUnique({
      where: { boardId },
      select: { boardId: true, hostId: true, gameName: true },
    });
    const access = await requireBoardAccess(boardId, "cash.confirm");
    if (!access.ok) {
      return NextResponse.json({ error: access.error }, { status: access.status });
    }
    if (!board) {
      return NextResponse.json({ error: "Board not found." }, { status: 404 });
    }

    const body = (await request.json()) as Body;
    if (body.action !== "confirm" && body.action !== "release") {
      return NextResponse.json({ error: "Unknown action." }, { status: 400 });
    }
    if (!body.reservationId) {
      return NextResponse.json({ error: "A reservation is required." }, { status: 400 });
    }

    // Scoped to THIS board before anything else. A reservation id from another
    // host's board must read as not found, never as a permission error.
    const reservation = await prisma.entryReservation.findFirst({
      where: { id: body.reservationId, boardId: board.boardId },
      select: {
        id: true,
        status: true,
        referenceCode: true,
        contributorName: true,
        contributorEmail: true,
        lines: {
          select: { tier: true, priceBasis: true, unitPriceCents: true, quantity: true },
        },
      },
    });
    if (!reservation) {
      return NextResponse.json({ error: "Reservation not found." }, { status: 404 });
    }
    if (reservation.status !== "pending") {
      return NextResponse.json(
        { error: "This reservation has already been resolved." },
        { status: 409 }
      );
    }

    // ------------------------------------------------------------ release ---
    if (body.action === "release") {
      const { released } = await prisma.$transaction((tx) =>
        releaseEntryReservation(tx, {
          reservationId: reservation.id,
          reason: body.reason?.trim() || "released by host",
        })
      );
      if (!released) {
        return NextResponse.json(
          { error: "This reservation has already been resolved." },
          { status: 409 }
        );
      }

      // OUTSIDE THE TRANSACTION, and non-fatal. Someone who sent money and
      // thinks they are going must hear about this; a mail failure must not
      // leave the reservation un-released.
      try {
        await sendEmail(
          reservation.contributorEmail,
          `Your reservation was released — ${board.gameName}`,
          `<p style="margin:0;font:600 16px system-ui,sans-serif;">
             Your ticket reservation was released.
           </p>
           <p style="margin:8px 0 0;font:14px system-ui,sans-serif;">
             ${esc(board.gameName)} · reference ${esc(reservation.referenceCode)}
           </p>
           <p style="margin:8px 0 0;font:14px system-ui,sans-serif;">
             Nothing was charged and nothing is owed. <strong>If you did send
             payment, reply to this email or contact the host — please do not
             send it again.</strong>
           </p>`
        );
      } catch (err) {
        console.warn(`Release notice failed for reservation ${reservation.id}:`, err);
      }

      return NextResponse.json({ ok: true, action: "release" });
    }

    // ------------------------------------------------------------ confirm ---
    let result;
    try {
      result = await prisma.$transaction((tx) =>
        confirmEntryReservation(tx, { reservationId: reservation.id, hostId: access.hostId })
      );
    } catch (err) {
      if (err instanceof ReservationNotPending) {
        return NextResponse.json({ error: err.message }, { status: 409 });
      }
      throw err;
    }

    // The passes exist now, so the receipt can go. Board-scoped and claim-safe:
    // the sender stamps before it sends, so the cron cannot double up.
    try {
      await sendPendingConfirmations({ boardId: board.boardId });
    } catch (err) {
      console.warn(`Entry reservation confirmation email failed:`, err);
    }

    return NextResponse.json({
      ok: true,
      action: "confirm",
      contributionId: result.contributionId,
      passesMinted: result.passesMinted,
      postClose: result.postClose,
      amountCents: reservationTotalCents(reservation.lines),
    });
  } catch (error) {
    console.error("Entry reservation resolve error:", error);
    return NextResponse.json(
      { error: "Something went wrong. Please try again." },
      { status: 500 }
    );
  }
}

/** Host-controlled board names reach email HTML here, same as elsewhere. */
function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
