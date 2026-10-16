// GET /api/host/merch/[id]/orders.csv — orders export for the host.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ordersCsv } from "@/domain/merch/csv";
import { merchOwnerId } from "@/domain/merch/host-auth";
import { merchEnabled } from "@/domain/merch/runtime";
import { notFound } from "@/domain/merch/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!merchEnabled()) return notFound();
  const owner = await merchOwnerId();
  if (!owner) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const csv = await ordersCsv(id, owner, prisma);
  if (csv === null) return notFound();
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="merch-orders-${id.slice(0, 8)}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
