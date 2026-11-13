// Legacy Board webhook isolation (spec §7.3, "complete isolation from legacy Board payment processing").
//
// Both webhook endpoints subscribe to connected-account events, so Stripe will
// deliver every merch Checkout event to the EXISTING Board handler too. This
// test sends real, signed merch events through the unmodified Board handler
// and proves it acknowledges them and changes nothing: every non-merch table
// is byte-identical before and after, with pending Board rows present that a
// wrong match would have flipped.
//
//   npm run test:db:up && npm run test:integration:merch

import { test, describe, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import Stripe from "stripe";
import type { PrismaClient } from "@prisma/client";
import { testClient, seedListing, orderInput, deps, FakeStripe, ACCOUNT } from "./test-support.ts";
import { createOrder, startCheckout, fulfillFromSession } from "./orders.ts";

const url = process.env.TEST_DATABASE_URL;
const WHSEC = "whsec_legacy_isolation_test";

describe("legacy Board webhook ignores merch events (integration)", { skip: !url && "TEST_DATABASE_URL not set" }, () => {
  let db: PrismaClient;
  let POST: (req: Request) => Promise<Response>;
  const signer = new Stripe("sk_test_isolation_dummy");
  let hostId = "";
  let boardId = "";

  before(async () => {
    db = await testClient(url!);
    process.env.STRIPE_SECRET_KEY ||= "sk_test_isolation_dummy";
    process.env.STRIPE_WEBHOOK_SECRET = WHSEC;
    mock.module("@/lib/prisma", { namedExports: { prisma: db } });
    ({ POST } = await import("../../app/api/webhooks/stripe/route.ts"));

    // Board-side rows a wrong match could touch: a host on the SAME connected
    // account, a fundraiser, and a PENDING card contribution.
    const host = await db.host.create({ data: { email: `iso-${randomUUID()}@example.com`, stripeAccountId: ACCOUNT, stripeChargesEnabled: true } });
    hostId = host.id;
    const board = await db.board.create({
      data: {
        hostId, gameName: "Isolation", slug: "iso-" + randomUUID().slice(0, 8), boardType: "fundraiser",
        acceptedPaymentMethods: ["card"], squarePrice: 5000, totalSquares: 0, timezone: "America/New_York",
        campaignEndsAt: new Date(Date.now() + 7 * 864e5),
      },
    });
    boardId = board.boardId;
    await db.contribution.create({
      data: {
        boardId, status: "pending" as never, settlement: "STRIPE" as never, tender: "CARD" as never,
        squareAmountCents: 0, donationAmountCents: 2500, totalPaidCents: 2500,
        contributorName: "Donor", contributorEmail: "donor@example.com",
        checkoutSessionId: "cs_test_board_" + randomUUID().replace(/-/g, ""),
      },
    });
  });

  after(async () => {
    await db.contribution.deleteMany({ where: { boardId } });
    await db.board.deleteMany({ where: { boardId } });
    await db.host.deleteMany({ where: { id: hostId } });
    await db.$disconnect();
  });

  /** md5 of every row of every non-merch table in public. */
  async function snapshot(): Promise<Record<string, string>> {
    const tables = await db.$queryRaw<{ t: string }[]>`
      SELECT tablename::text AS t FROM pg_tables
       WHERE schemaname = 'public' AND tablename NOT LIKE 'daali\\_merch\\_%' AND tablename <> '_prisma_migrations'
       ORDER BY 1`;
    const out: Record<string, string> = {};
    for (const { t } of tables) {
      const [r] = await db.$queryRawUnsafe<{ h: string | null }[]>(
        `SELECT md5(COALESCE(string_agg(x::text, '|' ORDER BY x::text), '')) AS h FROM "${t.replace(/"/g, '""')}" x`
      );
      out[t] = r.h ?? "";
    }
    return out;
  }

  async function deliver(event: Record<string, unknown>) {
    const payload = JSON.stringify(event);
    const sig = signer.webhooks.generateTestHeaderString({ payload, secret: WHSEC });
    return POST(new Request("http://localhost/api/webhooks/stripe", { method: "POST", body: payload, headers: { "stripe-signature": sig } }));
  }

  test("completed, expired and refunded merch events: 200 and zero Board-side changes", async () => {
    const clock = { t: new Date() };
    const stripe = new FakeStripe(() => new Date(clock.t));
    const f = await seedListing(db);
    const d = deps(db, stripe, clock);
    const o = await createOrder(orderInput(f, [{ variantId: f.m, quantity: 1 }]), d);
    await startCheckout(o.orderId, d);
    const sid = (await db.daaliMerchOrder.findUniqueOrThrow({ where: { id: o.orderId } })).stripeSessionId!;
    const paid = stripe.pay(sid);
    await fulfillFromSession(paid, ACCOUNT, d);

    const before = await snapshot();
    const session = {
      id: sid, object: "checkout.session", status: "complete", payment_status: "paid", amount_total: paid.amountTotal,
      currency: "usd", client_reference_id: o.orderId, payment_intent: paid.paymentIntentId,
      metadata: { daali_kind: "merch_order", order_id: o.orderId },
    };
    const base = { object: "event", api_version: "2025-01-27.acacia", account: ACCOUNT, livemode: false, created: Math.floor(Date.now() / 1000) };
    const responses = [
      await deliver({ ...base, id: "evt_" + randomUUID(), type: "checkout.session.completed", data: { object: session } }),
      await deliver({ ...base, id: "evt_" + randomUUID(), type: "checkout.session.completed", data: { object: session } }), // replay
      await deliver({ ...base, id: "evt_" + randomUUID(), type: "checkout.session.expired", data: { object: { ...session, status: "expired", payment_status: "unpaid" } } }),
      await deliver({ ...base, id: "evt_" + randomUUID(), type: "charge.refunded", data: { object: { id: "ch_x", object: "charge", payment_intent: paid.paymentIntentId, amount_refunded: 4150 } } }),
    ];
    assert.deepEqual(responses.map((r) => r.status), [200, 200, 200, 200]);
    const afterSnap = await snapshot();
    assert.ok(Object.keys(before).length > 20, "snapshot covers the Board schema");
    assert.deepEqual(afterSnap, before);

    // And the merch order the Board handler saw is untouched by it too.
    const row = await db.daaliMerchOrder.findUniqueOrThrow({ where: { id: o.orderId } });
    assert.equal(row.status, "PAID");
    assert.equal(row.refundedCents, 0);
  });
});
