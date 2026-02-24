import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function POST(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const { count } = await prisma.board.deleteMany({
      where: {
        status: "expired",
        expiredAt: { lt: cutoff },
      },
    });

    if (count > 0) {
      console.log(`Deleted ${count} expired board(s) past 30-day retention`);
    }

    return NextResponse.json({ deleted: count });
  } catch (error) {
    console.error("delete-expired cron error:", error);
    return NextResponse.json(
      { error: "Cron job failed" },
      { status: 500 }
    );
  }
}
