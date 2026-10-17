// POST /api/merch/orders/[token]/checkout — "Still setting up payment…" retry.
// Same idempotency key and frozen parameters every time (spec §5.7).

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { startCheckout } from "@/domain/merch/orders";
import { merchDeps } from "@/domain/merch/runtime";
import { errorResponse, notFound } from "@/domain/merch/http";

export const runtime = "nodejs";

export async function POST(_req: Request, ctx: { params: Promise<{ token: string }> }) {
  // No route-level flag: startCheckout refuses to create a session when new sales are off.
  const { token } = await ctx.params;
  try {
    const order = await prisma.daaliMerchOrder.findUnique({ where: { publicToken: token }, select: { id: true } });
    if (!order) return notFound();
    const result = await startCheckout(order.id, merchDeps());
    if (result.kind === "redirect") return NextResponse.json({ kind: "checkout", next: result.url });
    if (result.kind === "retry") return NextResponse.json({ kind: "retry" }, { status: 202 });
    if (result.kind === "failed") return NextResponse.json({ kind: "failed", error: result.message }, { status: 502 });
    if (result.kind === "sales_closed") return NextResponse.json({ kind: "failed", error: "This sale isn't taking orders right now. Nothing was charged." }, { status: 409 });
    if (result.kind === "expired") return NextResponse.json({ kind: "failed", error: "Your checkout timed out. Please start again." }, { status: 409 });
    return NextResponse.json({ kind: "done", next: `/merch/order/${token}` });
  } catch (e) {
    return errorResponse(e);
  }
}
