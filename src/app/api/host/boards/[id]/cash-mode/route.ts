import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getHost } from "@/lib/auth";

// ============================================================
// HOST: Toggle cash mode + set PIN + configure TTL
//
// PATCH /api/host/boards/[id]/cash-mode
// Body: {
//   enabled: boolean,
//   pin?: string,
//   ttlMinutes?: number,           // auto-expire cash reservations (default 20)
//   liabilityAccepted?: boolean    // required on first enable
// }
//
// First time enabling requires liabilityAccepted: true.
// Disclaimer text (frontend):
// "Host is responsible for collecting and managing cash payments."
// ============================================================

interface CashModeBody {
  enabled?: boolean;
  pin?: string;
  ttlMinutes?: number;
  liabilityAccepted?: boolean;
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const host = await getHost();
    if (!host) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const boardId = params.id;
    const body: CashModeBody = await request.json();
    const { enabled, pin, ttlMinutes, liabilityAccepted } = body;

    const board = await prisma.board.findUnique({
      where: { boardId },
      select: {
        hostId: true,
        cashModeEnabled: true,
        cashLiabilityAccepted: true,
      },
    });

    if (!board || board.hostId !== host.id) {
      return NextResponse.json({ error: "Board not found." }, { status: 404 });
    }

    // Liability check: first time enabling requires acceptance
    const isEnabling = enabled === true;
    if (isEnabling && !board.cashLiabilityAccepted && !liabilityAccepted) {
      return NextResponse.json(
        {
          error: "You must accept cash payment responsibility to enable cash mode.",
          requiresLiabilityAcceptance: true,
        },
        { status: 400 }
      );
    }

    // PIN validation
    const isChangingPin = pin !== undefined;
    if (isEnabling || (isChangingPin && board.cashModeEnabled)) {
      if (!pin || !/^\d{4}$/.test(pin)) {
        return NextResponse.json(
          { error: "PIN must be exactly 4 digits." },
          { status: 400 }
        );
      }
    }

    // TTL validation
    if (ttlMinutes !== undefined && (ttlMinutes < 5 || ttlMinutes > 120)) {
      return NextResponse.json(
        { error: "Cash reservation timeout must be between 5 and 120 minutes." },
        { status: 400 }
      );
    }

    // Build update
    const updateData: Record<string, unknown> = {};

    if (isEnabling) {
      updateData.cashModeEnabled = true;
      updateData.cashPin = pin!;
      if (liabilityAccepted) {
        updateData.cashLiabilityAccepted = true;
      }
    } else if (enabled === false) {
      updateData.cashModeEnabled = false;
      updateData.cashPin = null;
    } else if (isChangingPin) {
      updateData.cashPin = pin!;
    }

    if (ttlMinutes !== undefined) {
      updateData.cashReservationTtlMins = ttlMinutes;
    }

    if (Object.keys(updateData).length === 0) {
      return NextResponse.json(
        { error: "Nothing to update." },
        { status: 400 }
      );
    }

    const updated = await prisma.board.update({
      where: { boardId },
      data: updateData,
      select: {
        cashModeEnabled: true,
        cashReservationTtlMins: true,
      },
    });

    return NextResponse.json({
      cashModeEnabled: updated.cashModeEnabled,
      cashReservationTtlMins: updated.cashReservationTtlMins,
      message: updated.cashModeEnabled
        ? "Cash mode enabled. Share the PIN with players at your event."
        : "Cash mode disabled.",
    });
  } catch (error) {
    console.error("Cash mode toggle error:", error);
    return NextResponse.json(
      { error: "Something went wrong." },
      { status: 500 }
    );
  }
}
