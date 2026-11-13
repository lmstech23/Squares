// GET /api/cron/merch-reconcile — every 10 minutes (spec §7.5).
//
//   1. Pending orders with no stored session (§5.7): recover and end them.
//   2. Pending orders whose hold lapsed: ask Stripe what happened.
//   3. Due receipt deliveries (§5.8).
//   4. Backfill Stripe's actual fee on recent paid orders.
// Each step is bounded so one slow provider can't starve the rest.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { reconcileStalePending, recordStripeFee, recoverPendingWithoutSession } from "@/domain/merch/orders";
import { processOutbox } from "@/domain/merch/notifications";
import { merchDeps, outboxDeps } from "@/domain/merch/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  // Runs whatever MERCH_SALES_ENABLED says: pending payments, refunds and receipts
  // must keep settling after new sales are switched off.

  const deps = merchDeps();
  const recovered = await recoverPendingWithoutSession(deps, 25);
  const reconciled = await reconcileStalePending(deps, 25);
  const receipts = await processOutbox(outboxDeps(), { limit: 50 });

  const since = new Date(Date.now() - 7 * 24 * 60 * 60_000);
  const needFee = await prisma.daaliMerchOrder.findMany({
    where: { status: { in: ["PAID", "PARTIALLY_REFUNDED", "REFUNDED"] }, stripeFeeCents: null, paidAt: { gte: since } },
    select: { id: true },
    take: 25,
  });
  for (const o of needFee) await recordStripeFee(o.id, deps);

  return NextResponse.json({ recovered, reconciled, receipts, feesChecked: needFee.length });
}
