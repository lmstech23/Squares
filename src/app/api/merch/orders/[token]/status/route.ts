// GET /api/merch/orders/[token]/status — polled by "Confirming your payment…".
// Re-checks Stripe server-side; returns the after-order link ONLY once PAID.

import { NextResponse, after } from "next/server";
import { prisma } from "@/lib/prisma";
import { fulfillFromSession, recordStripeFee } from "@/domain/merch/orders";
import { processOutbox } from "@/domain/merch/notifications";
import { merchDeps, merchEnabled, outboxDeps } from "@/domain/merch/runtime";
import { notFound } from "@/domain/merch/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ token: string }> }) {
  if (!merchEnabled()) return notFound();
  const { token } = await ctx.params;
  const order = await prisma.daaliMerchOrder.findUnique({ where: { publicToken: token } });
  if (!order) return notFound();

  const paidLike = ["PAID", "PARTIALLY_REFUNDED", "REFUNDED", "CONFIRMED_FREE"];
  if (!paidLike.includes(order.status) && order.status === "PENDING_PAYMENT" && order.stripeSessionId && order.stripeAccountId) {
    try {
      const deps = merchDeps();
      const s = await deps.stripe.retrieveCheckoutSession(order.stripeSessionId, order.stripeAccountId);
      const r = await fulfillFromSession(s, order.stripeAccountId, deps);
      if (r.kind === "paid") {
        after(async () => {
          await processOutbox(outboxDeps(), { orderId: r.orderId }).catch(() => {});
          await recordStripeFee(r.orderId, deps);
        });
        return NextResponse.json({ status: "PAID", next: r.redirectUrl ?? `/merch/order/${token}` }, { headers: { "Cache-Control": "no-store" } });
      }
    } catch {
      /* keep polling */
    }
  }
  const fresh = await prisma.daaliMerchOrder.findUniqueOrThrow({ where: { id: order.id } });
  const done = paidLike.includes(fresh.status);
  return NextResponse.json(
    { status: fresh.status, next: done ? fresh.redirectSnapshotUrl ?? null : null },
    { headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } }
  );
}
