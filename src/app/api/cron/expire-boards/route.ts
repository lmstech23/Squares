import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function POST(request: Request) {
  // Verify cron secret (Vercel sends this automatically)
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const now = new Date();

    // Find all pending_payment boards past their 48hr TTL
    const expiredBoards = await prisma.board.findMany({
      where: {
        status: "pending_payment",
        pendingExpiresAt: { lt: now },
      },
      select: { boardId: true },
    });

    if (expiredBoards.length === 0) {
      return NextResponse.json({ expired: 0 });
    }

    const boardIds = expiredBoards.map((b) => b.boardId);

    // Flip to expired + set expiredAt (starts the 30-day auto-delete clock)
    await prisma.board.updateMany({
      where: { boardId: { in: boardIds } },
      data: {
        status: "expired",
        expiredAt: now,
        pendingExpiresAt: null,
      },
    });

    console.log(`Expired ${boardIds.length} pending_payment board(s): ${boardIds.join(", ")}`);

    return NextResponse.json({ expired: boardIds.length });
  } catch (error) {
    console.error("expire-boards cron error:", error);
    return NextResponse.json(
      { error: "Cron job failed" },
      { status: 500 }
    );
  }
}
