// POST /api/host/merch/[id]/orders/[orderId] {action}: handed_out | cancel_free | resend_receipt

import { NextResponse, after } from "next/server";
import { prisma } from "@/lib/prisma";
import { cancelFreeOrder, markHandedOut } from "@/domain/merch/orders";
import { hostResend, processOutbox } from "@/domain/merch/notifications";
import { merchOwnerId } from "@/domain/merch/host-auth";
import { merchEnabled, outboxDeps } from "@/domain/merch/runtime";
import { notFound } from "@/domain/merch/http";

export const runtime = "nodejs";

export async function POST(req: Request, ctx: { params: Promise<{ id: string; orderId: string }> }) {
  if (!merchEnabled()) return notFound();
  const owner = await merchOwnerId();
  if (!owner) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id, orderId } = await ctx.params;
  const order = await prisma.daaliMerchOrder.findFirst({ where: { id: orderId, listingId: id, listing: { ownerUserId: owner } }, select: { id: true } });
  if (!order) return notFound();

  const { action } = (await req.json().catch(() => ({}))) as { action?: string };
  const now = new Date();
  let ok = false;
  if (action === "handed_out") ok = await markHandedOut(orderId, owner, prisma, now);
  else if (action === "cancel_free") ok = await cancelFreeOrder(orderId, owner, prisma, now);
  else if (action === "resend_receipt") {
    ok = await hostResend(orderId, owner, prisma, now);
    if (ok) after(() => processOutbox(outboxDeps(), { orderId }).catch(() => {}));
  }
  else return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  return ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "That change isn't possible for this order." }, { status: 409 });
}
