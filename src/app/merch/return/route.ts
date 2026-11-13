// GET /merch/return?cs=… — the redirect gate (spec §5.4).
//
// The `cs` value is only a lookup key. Payment is verified by retrieving the
// session from Stripe on the order's own connected account. Only then is the
// browser sent — immediately, HTTP 303 — to the after-order link stored on the
// order row. Nothing in the request can choose or change the destination.

import { NextResponse, after } from "next/server";
import { prisma } from "@/lib/prisma";
import { fulfillFromSession, recordStripeFee } from "@/domain/merch/orders";
import { processOutbox } from "@/domain/merch/notifications";
import { merchBaseUrl, merchDeps, outboxDeps } from "@/domain/merch/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function go(url: string) {
  const res = NextResponse.redirect(url, 303);
  res.headers.set("Referrer-Policy", "no-referrer");
  res.headers.set("Cache-Control", "no-store");
  return res;
}

export async function GET(req: Request) {
  // Always on, whatever MERCH_SALES_ENABLED says: a supporter who paid must be confirmed.
  const base = merchBaseUrl();
  const cs = new URL(req.url).searchParams.get("cs") ?? "";
  if (!/^cs_(test|live)_[A-Za-z0-9]{10,200}$/.test(cs)) return go(`${base}/merch/order/not-found`);

  const order = await prisma.daaliMerchOrder.findUnique({
    where: { stripeSessionId: cs },
    select: { id: true, publicToken: true, stripeAccountId: true },
  });
  if (!order || !order.stripeAccountId) return go(`${base}/merch/order/not-found`);

  const deps = merchDeps();
  let result;
  try {
    const session = await deps.stripe.retrieveCheckoutSession(cs, order.stripeAccountId);
    result = await fulfillFromSession(session, order.stripeAccountId, deps);
  } catch {
    // Stripe unreachable: the order page keeps checking and navigates once paid.
    return go(`${base}/merch/order/${order.publicToken}?confirming=1`);
  }

  if (result.kind === "paid") {
    after(async () => {
      await processOutbox(outboxDeps(), { orderId: result.orderId }).catch(() => {});
      await recordStripeFee(result.orderId, deps);
    });
    return go(result.redirectUrl ?? `${base}/merch/order/${result.publicToken}`);
  }
  if (result.kind === "not_paid") return go(`${base}/merch/order/${result.publicToken}?confirming=1`);
  return go(`${base}/merch/order/${order.publicToken}`);
}
