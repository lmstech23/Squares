import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;

  const board = await prisma.board.findUnique({
    where: { slug },
    select: {
      squares: {
        orderBy: { position: "asc" },
        select: {
          squareId: true,
          position: true,
          playerName: true,
          paymentStatus: true,
        },
      },
    },
  });

  if (!board) {
    return NextResponse.json({ error: "Board not found" }, { status: 404 });
  }

  return NextResponse.json({ squares: board.squares });
}
