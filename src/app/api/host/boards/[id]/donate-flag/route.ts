import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getHost } from "@/lib/auth";
import { setDonateFlag } from "@/lib/confirm-square";

// ============================================================
// HOST: Toggle a purchase's donate setting after the fact
//
// POST /api/host/boards/[id]/donate-flag
// Body: { grantId: string, donate: boolean }
//
// Addendum §6. For the supporter who decides to come after all, or the one who
// cannot. Toggling ON voids that grant's active passes; toggling OFF mints new
// ones with new tokens and new numbers — never the old ones, because `void` is
// terminal.
//
// A `used` pass is never voidable. Three people already walked through the
// gate; that grant cannot be retroactively donated, and the request is
// rejected rather than partially applied.
// ============================================================

interface Body {
  grantId: string;
  donate: boolean;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const host = await getHost();
    if (!host) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id: boardId } = await params;
    const { grantId, donate } = (await request.json()) as Body;

    if (!grantId || typeof donate !== "boolean") {
      return NextResponse.json(
        { error: "A grant and a setting are required." },
        { status: 400 }
      );
    }

    // The grant must belong to an event on this host's board. Without this a
    // host could toggle admissions on someone else's board by guessing an id.
    const grant = await prisma.admissionGrant.findFirst({
      where: { id: grantId, event: { boardId, board: { hostId: host.id } } },
      select: { id: true },
    });

    if (!grant) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }

    // One transaction: minting takes a row lock on the supporter, and the
    // grant flag must not commit without the passes it implies.
    const outcome = await prisma.$transaction((tx) =>
      setDonateFlag(tx, grantId, donate)
    );

    if (!outcome.ok) {
      if (outcome.reason === "used_passes") {
        const n = outcome.usedCount ?? 0;
        return NextResponse.json(
          {
            error:
              `${n} ${n === 1 ? "ticket has" : "tickets have"} already been ` +
              `scanned at the gate, so this purchase can't be donated.`,
          },
          { status: 409 }
        );
      }
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }

    return NextResponse.json({
      ok: true,
      voided: outcome.voided,
      minted: outcome.minted,
    });
  } catch (error) {
    console.error("Donate flag error:", error);
    return NextResponse.json(
      { error: "Something went wrong. Please try again." },
      { status: 500 }
    );
  }
}
