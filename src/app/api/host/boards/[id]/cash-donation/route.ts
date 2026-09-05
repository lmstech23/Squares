import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getHost } from "@/lib/auth";
import { boardTotals, recordCashDonation, countsTowardRaised } from "@/lib/contributions";

// ============================================================
// HOST: record a cash donation — donations §7, invariant 65.
//
// POST { amountCents, donorName, donorEmail?, donorPhone?, isHostEntry? }
//
// ONE HOST ACTION. Recorded `confirmed` immediately, attributed to the
// recording host. There is no reserve step and no expiry: the reserve->confirm
// pattern exists because a cash SQUARE is inventory that must be held off the
// board. A cash donation holds nothing, so a hold would be a state with no
// purpose and an expiry with nothing to expire.
//
// No minimum. The host is recording money already in her hand (§6).
//
// Email is optional here and ONLY here (§10). EventSupporter.email is NOT
// NULL, so a cash donation with no email is a Contribution and nothing else —
// the host wrote down that money was handed to her at the church and nothing
// more is known. Forcing a fake email to satisfy a constraint is worse.
//
// GET returns the board's four numbers plus the ledger, which is what makes
// the flow testable end to end.
// ============================================================

export const runtime = "nodejs";

interface CashDonationBody {
  amountCents: number;
  donorName: string;
  donorEmail?: string | null;
  donorPhone?: string | null;
  isHostEntry?: boolean;
}

async function loadOwnedBoard(boardId: string) {
  const host = await getHost();
  if (!host) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };

  const board = await prisma.board.findUnique({
    where: { boardId },
    select: {
      boardId: true,
      hostId: true,
      status: true,
      boardType: true,
      campaignEndsAt: true,
      event: { select: { id: true } },
    },
  });

  if (!board || board.hostId !== host.id) {
    return { error: NextResponse.json({ error: "Board not found." }, { status: 404 }) };
  }
  return { host, board };
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: boardId } = await params;
    const loaded = await loadOwnedBoard(boardId);
    if ("error" in loaded) return loaded.error;
    const { host, board } = loaded;

    const body: CashDonationBody = await request.json();
    const amountCents = Math.trunc(body.amountCents ?? 0);
    const name = body.donorName?.trim() ?? "";

    if (!name) {
      return NextResponse.json({ error: "A contributor name is required." }, { status: 400 });
    }
    if (!Number.isFinite(amountCents) || amountCents <= 0) {
      return NextResponse.json({ error: "Enter an amount greater than zero." }, { status: 400 });
    }
    // A Game Day board must never accumulate donation money — donations §5.
    if (board.boardType !== "fundraiser") {
      return NextResponse.json(
        { error: "Donations are not available on this board." },
        { status: 400 }
      );
    }
    // Donations stop when the board leaves OPEN — invariant 66.
    if (board.status !== "open") {
      return NextResponse.json(
        { error: "This board is no longer accepting contributions." },
        { status: 409 }
      );
    }
    if (board.campaignEndsAt && board.campaignEndsAt <= new Date()) {
      return NextResponse.json({ error: "This campaign has closed." }, { status: 409 });
    }

    const email = body.donorEmail?.trim().toLowerCase() || null;
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json({ error: "That email is not valid." }, { status: 400 });
    }

    const contribution = await recordCashDonation({
      boardId: board.boardId,
      eventId: board.event?.id ?? null,
      amountCents,
      contributorName: name,
      contributorEmail: email,
      contributorPhone: body.donorPhone?.trim() || null,
      recordedByHostId: host.id,
      isHostEntry: body.isHostEntry ?? false,
    });

    return NextResponse.json({
      success: true,
      contributionId: contribution.id,
      totals: await boardTotals(board.boardId),
    });
  } catch (error) {
    console.error("Cash donation error:", error);
    return NextResponse.json(
      { error: "Something went wrong. Please try again." },
      { status: 500 }
    );
  }
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: boardId } = await params;
    const loaded = await loadOwnedBoard(boardId);
    if ("error" in loaded) return loaded.error;

    const contributions = await prisma.contribution.findMany({
      where: { boardId },
      orderBy: { createdAt: "desc" },
      take: 100,
      select: {
        id: true,
        status: true,
        paymentMethod: true,
        squareAmountCents: true,
        donationAmountCents: true,
        totalPaidCents: true,
        contributorName: true,
        contributorEmail: true,
        confirmedAt: true,
        voidedAt: true,
        createdAt: true,
        _count: { select: { squares: true } },
      },
    });

    return NextResponse.json({
      totals: await boardTotals(boardId),
      // Deliberately the RAW list, including released and voided rows, because
      // this is the surface used to verify the ledger. `countsTowardRaised` is
      // what the totals above go through; the list is for eyes.
      countsTowardRaisedFilter: countsTowardRaised,
      contributions,
    });
  } catch (error) {
    console.error("Contribution list error:", error);
    return NextResponse.json({ error: "Something went wrong." }, { status: 500 });
  }
}
