// Merch HTTP routes against the real database (spec §5.4, §7).
//
// The route handlers run unmodified. Two seams are replaced: `@/lib/stripe`
// (a fake SDK with the Checkout Session shape the gateway reads, plus the REAL
// Stripe webhook signer) and `after()` from next/server (queued, so the test
// can prove the response is complete before any email work starts).
//
//   npm run test:db:up && npm run test:integration:merch

import { test, describe, before, after as afterAll, mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import Stripe from "stripe";
import type { PrismaClient } from "@prisma/client";
import { testClient, seedListing, orderInput, deps, FakeStripe, ACCOUNT } from "./test-support.ts";
import { createOrder } from "./orders.ts";

const url = process.env.TEST_DATABASE_URL;
const WHSEC = "whsec_merch_routes_test";

describe("merch routes (integration)", { skip: !url && "TEST_DATABASE_URL not set" }, () => {
  let db: PrismaClient;
  const queued: (() => unknown)[] = [];
  const signer = new Stripe("sk_test_routes_dummy");
  // Sessions as Stripe returns them (snake_case), keyed by id.
  const sessions = new Map<string, Record<string, unknown> & { account: string }>();
  const sdk = {
    webhooks: signer.webhooks,
    checkout: {
      sessions: {
        retrieve: async (id: string, _p: unknown, opts: { stripeAccount: string }) => {
          const s = sessions.get(id);
          if (!s || s.account !== opts.stripeAccount) throw Object.assign(new Error("No such checkout.session"), { statusCode: 404 });
          return s;
        },
        create: async () => { throw new Error("not used"); },
        expire: async () => { throw new Error("not used"); },
      },
    },
    paymentIntents: { retrieve: async () => ({ latest_charge: { balance_transaction: { fee: 271 } } }) },
  };
  let returnGET: (r: Request) => Promise<Response>;
  let statusGET: (r: Request, c: { params: Promise<{ token: string }> }) => Promise<Response>;
  let webhookPOST: (r: Request) => Promise<Response>;

  before(async () => {
    db = await testClient(url!);
    Object.assign(process.env, { MERCH_ENABLED: "true", NEXT_PUBLIC_URL: "https://daali.test", MERCH_IP_HASH_SALT: "salt", STRIPE_MERCH_WEBHOOK_SECRET: WHSEC, STRIPE_SECRET_KEY: "sk_test_routes_dummy" });
    const realNext = await import("next/server");
    mock.module("next/server", { namedExports: { ...realNext, after: (fn: () => unknown) => void queued.push(fn) } });
    mock.module("@/lib/prisma", { namedExports: { prisma: db } });
    mock.module("@/lib/stripe", { namedExports: { stripe: sdk } });
    ({ GET: returnGET } = await import("../../app/merch/return/route.ts"));
    ({ GET: statusGET } = await import("../../app/api/merch/orders/[token]/status/route.ts"));
    ({ POST: webhookPOST } = await import("../../app/api/webhooks/merch/route.ts"));
  });
  afterAll(async () => {
    await db.$disconnect();
  });

  /** A pending paid order with a stored session, as startCheckout leaves it. */
  async function pendingWithSession(opts: { redirect?: string | null } = {}) {
    const clock = { t: new Date() };
    const f = await seedListing(db, { redirect: opts.redirect });
    const o = await createOrder(orderInput(f, [{ variantId: f.m, quantity: 2 }]), deps(db, new FakeStripe(() => new Date(clock.t)), clock));
    const id = "cs_test_" + randomUUID().replace(/-/g, "");
    await db.daaliMerchOrder.update({ where: { id: o.orderId }, data: { stripeSessionId: id, checkoutUrl: `https://checkout.stripe.test/${id}` } });
    const s = {
      id, object: "checkout.session", url: null, status: "open", payment_status: "unpaid", amount_total: 8300, currency: "usd",
      client_reference_id: o.orderId, payment_intent: null as string | null, metadata: { daali_kind: "merch_order", order_id: o.orderId }, account: ACCOUNT,
    };
    sessions.set(id, s);
    const pay = () => Object.assign(s, { status: "complete", payment_status: "paid", payment_intent: "pi_" + id.slice(8, 30) });
    return { o, f, id, s, pay };
  }

  const ret = (cs: string) => returnGET(new Request(`https://daali.test/merch/return?cs=${encodeURIComponent(cs)}`));

  test("return: verified paid → immediate 303 to the organizer's link, no referrer, email deferred", async () => {
    const { o, id, pay } = await pendingWithSession();
    pay();
    queued.length = 0;
    const res = await ret(id);
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), "https://www.nba.com/wizards/tickets");
    assert.equal(res.headers.get("referrer-policy"), "no-referrer");
    assert.equal(res.headers.get("cache-control"), "no-store");
    // Response is complete; the receipt has not been attempted yet.
    assert.equal(queued.length, 1);
    const n = await db.daaliMerchNotification.findFirstOrThrow({ where: { orderId: o.orderId } });
    assert.equal(n.status, "PENDING");
    assert.equal(n.attempts, 0);
    assert.equal((await db.daaliMerchOrder.findUniqueOrThrow({ where: { id: o.orderId } })).status, "PAID");
  });

  test("return: no after-order link → the order page", async () => {
    const { o, id, pay } = await pendingWithSession({ redirect: null });
    pay();
    const res = await ret(id);
    assert.equal(res.headers.get("location"), `https://daali.test/merch/order/${o.publicToken}`);
  });

  test("return: not yet paid → confirming page, never the organizer's link", async () => {
    const { o, id } = await pendingWithSession();
    const res = await ret(id);
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), `https://daali.test/merch/order/${o.publicToken}?confirming=1`);
  });

  test("return: forged, unknown or malformed cs → not-found page; nothing changes", async () => {
    for (const cs of ["", "abc", "cs_test_" + "x".repeat(30), "https://evil.example.com", "cs_test_<script>"]) {
      const res = await ret(cs);
      assert.equal(res.headers.get("location"), "https://daali.test/merch/order/not-found", cs);
    }
  });

  test("return: Stripe unreachable → confirming page", async () => {
    const { o, id } = await pendingWithSession();
    sessions.delete(id);
    const res = await ret(id);
    assert.equal(res.headers.get("location"), `https://daali.test/merch/order/${o.publicToken}?confirming=1`);
  });

  test("status: hands out the link only once paid", async () => {
    const { o, pay } = await pendingWithSession();
    const call = async () => (await statusGET(new Request("https://daali.test/x"), { params: Promise.resolve({ token: o.publicToken }) })).json();
    assert.deepEqual(await call(), { status: "PENDING_PAYMENT", next: null });
    pay();
    assert.deepEqual(await call(), { status: "PAID", next: "https://www.nba.com/wizards/tickets" });
  });

  async function deliver(type: string, object: unknown, account: string | null = ACCOUNT, secret = WHSEC) {
    const payload = JSON.stringify({ id: "evt_" + randomUUID(), object: "event", type, account, livemode: false, created: Math.floor(Date.now() / 1000), data: { object } });
    const sig = signer.webhooks.generateTestHeaderString({ payload, secret });
    return webhookPOST(new Request("https://daali.test/api/webhooks/merch", { method: "POST", body: payload, headers: { "stripe-signature": sig } }));
  }

  test("webhook: bad signature 400; platform event ignored; completed → PAID once; refund applied", async () => {
    const { o, s, pay } = await pendingWithSession();
    assert.equal((await deliver("checkout.session.completed", pay(), ACCOUNT, "whsec_wrong")).status, 400);
    assert.equal((await db.daaliMerchOrder.findUniqueOrThrow({ where: { id: o.orderId } })).status, "PENDING_PAYMENT");
    assert.deepEqual(await (await deliver("checkout.session.completed", s, null)).json(), { received: true, ignored: "platform event" });
    const a = await (await deliver("checkout.session.completed", s)).json();
    const b = await (await deliver("checkout.session.completed", s)).json();
    assert.deepEqual([a.result, b.result], ["paid", "paid"]);
    assert.equal(await db.daaliMerchNotification.count({ where: { orderId: o.orderId } }), 1);
    const r = await (await deliver("charge.refunded", { id: "ch_1", object: "charge", payment_intent: s.payment_intent, amount_refunded: 4150 })).json();
    assert.equal(r.result, "refund_applied");
    const row = await db.daaliMerchOrder.findUniqueOrThrow({ where: { id: o.orderId } });
    assert.deepEqual([row.status, row.refundedCents], ["PARTIALLY_REFUNDED", 4150]);
  });

  test("webhook: Board sessions arriving at the merch endpoint are acknowledged and ignored", async () => {
    const res = await deliver("checkout.session.completed", {
      id: "cs_test_board_" + randomUUID().replace(/-/g, ""), object: "checkout.session", status: "complete", payment_status: "paid",
      amount_total: 5000, currency: "usd", client_reference_id: null, payment_intent: "pi_board", metadata: { squareIds: "x" },
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).result, "unknown_session");
  });

  test("feature flag off: return route 404, webhook acknowledges without writing", async () => {
    const { o, s, id, pay } = await pendingWithSession();
    pay();
    process.env.MERCH_ENABLED = "false";
    try {
      assert.equal((await ret(id)).status, 404);
      assert.deepEqual(await (await deliver("checkout.session.completed", s)).json(), { received: true, ignored: "disabled" });
      assert.equal((await db.daaliMerchOrder.findUniqueOrThrow({ where: { id: o.orderId } })).status, "PENDING_PAYMENT");
    } finally {
      process.env.MERCH_ENABLED = "true";
    }
  });
});
