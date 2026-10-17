// POST /api/webhooks/merch — the SEPARATE Connect endpoint for merch (spec §7).
//
// Stripe delivers every subscribed connected-account event to each endpoint
// independently, so this endpoint also receives Board events: anything that
// doesn't match a merch order is acknowledged and ignored. The existing
// /api/webhooks/stripe endpoint is not edited and ignores merch events.
//
// Routing (§7.3): verify signature with STRIPE_MERCH_WEBHOOK_SECRET → require
// event.account → subscribed types only → find the merch order → act with a
// conditional state change, so duplicates and reordering change nothing (§7.4).
// 500 only on transient failure, so Stripe retries.

import { NextResponse, after } from "next/server";
import type Stripe from "stripe";
import { stripe } from "@/lib/stripe";
import { applyRefund, expireFromSession, fulfillFromSession, recordStripeFee } from "@/domain/merch/orders";
import { processOutbox } from "@/domain/merch/notifications";
import { sessionView } from "@/domain/merch/stripe";
import { merchDeps, outboxDeps } from "@/domain/merch/runtime";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const secret = process.env.STRIPE_MERCH_WEBHOOK_SECRET;
  if (!secret) return NextResponse.json({ error: "not configured" }, { status: 500 });
  const sig = req.headers.get("stripe-signature");
  if (!sig) return NextResponse.json({ error: "Missing stripe-signature header" }, { status: 400 });

  const body = await req.text();
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, sig, secret);
  } catch {
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  // No feature-flag check here, on purpose: switching off new sales must never
  // turn this endpoint into one that acknowledges payment or refund events
  // without processing them (spec §13).

  const account = event.account;
  if (!account) return NextResponse.json({ received: true, ignored: "platform event" });

  try {
    const deps = merchDeps();
    switch (event.type) {
      case "checkout.session.completed": {
        const r = await fulfillFromSession(sessionView(event.data.object as Stripe.Checkout.Session), account, deps);
        if (r.kind === "paid") {
          const orderId = r.orderId;
          after(async () => {
            await processOutbox(outboxDeps(), { orderId }).catch(() => {});
            await recordStripeFee(orderId, deps);
          });
        }
        if (r.kind === "mismatch") console.error(`merch webhook: ${r.reason} mismatch on event ${event.id}`);
        return NextResponse.json({ received: true, result: r.kind });
      }
      case "checkout.session.expired": {
        const s = event.data.object as Stripe.Checkout.Session;
        const changed = await expireFromSession(s.id, account, deps);
        return NextResponse.json({ received: true, result: changed ? "expired" : "ignored" });
      }
      case "charge.refunded": {
        const c = event.data.object as Stripe.Charge;
        const pi = typeof c.payment_intent === "string" ? c.payment_intent : c.payment_intent?.id;
        if (!pi) return NextResponse.json({ received: true, result: "ignored" });
        const n = await applyRefund(pi, account, c.amount_refunded, deps);
        return NextResponse.json({ received: true, result: n === 1 ? "refund_applied" : "ignored" });
      }
      default:
        return NextResponse.json({ received: true, ignored: event.type });
    }
  } catch (e) {
    console.error(`merch webhook ${event.type} ${event.id} failed:`, e);
    return NextResponse.json({ error: "handler failed" }, { status: 500 });
  }
}
