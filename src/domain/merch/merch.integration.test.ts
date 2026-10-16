// Merch — real-database integration tests (spec §9).
//
// Real Postgres, real concurrent transactions, schema built by replaying
// prisma/migrations. Stripe and email are in-memory fakes with real idempotency
// semantics, because the guarantees under test are Daali's, not theirs.
//
// Skipped without TEST_DATABASE_URL. Never point it at production: these tests
// create rows.
//
//   npm run test:db:up && npm run test:integration:merch

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import type { PrismaClient } from "@prisma/client";
import {
  applyRefund, cancelFreeOrder, createOrder, expireFromSession, fulfillFromSession, markHandedOut,
  recoverPendingWithoutSession, reconcileStalePending, remainingStock, startCheckout, HOLD_MINUTES,
} from "./orders.ts";
import { claim, hostResend, processOutbox, sendClaimed, idempotencyKeyFor, LEASE_MS, MAX_ATTEMPTS } from "./notifications.ts";
import { ordersCsv } from "./csv.ts";
import { isMerchError } from "./errors.ts";
import { ACCOUNT, FakeSender, FakeStripe, deps, orderInput, seedListing, testClient } from "./test-support.ts";

const url = process.env.TEST_DATABASE_URL;

test("merch real-database coverage (set TEST_DATABASE_URL to run)", { skip: url ? false : "TEST_DATABASE_URL not set — merch concurrency coverage did not run" }, () => {
  assert.ok(url);
});

async function rejectsCode(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => isMerchError(e) && (e as { code: string }).code === code);
}

describe("merch (integration)", { skip: !url && "TEST_DATABASE_URL not set" }, () => {
  let db: PrismaClient;
  const clock = { t: new Date() };
  const outbox = (sender: FakeSender) => ({ db, sender, now: () => new Date(clock.t), baseUrl: "https://daali.test" });

  before(async () => {
    db = await testClient(url!);
  });
  after(async () => {
    await db.$disconnect();
  });

  async function paidOrder(stripe: FakeStripe, qty = 1, stock: number | null = null) {
    const f = await seedListing(db, { stock });
    const d = deps(db, stripe, clock);
    const o = await createOrder(orderInput(f, [{ variantId: f.m, quantity: qty }]), d);
    return { f, d, o };
  }

  // ----------------------------------------------------------- createOrder --

  describe("createOrder", () => {
    test("paid order: all-in price, organizer net, hold, frozen checkout params", async () => {
      clock.t = new Date();
      const stripe = new FakeStripe(() => new Date(clock.t));
      const { o } = await paidOrder(stripe, 2);
      const row = await db.daaliMerchOrder.findUniqueOrThrow({ where: { id: o.orderId }, include: { lines: true } });
      assert.equal(row.status, "PENDING_PAYMENT");
      assert.equal(row.totalCents, 8300); // 2 × $41.50
      assert.equal(row.organizerNetCents, 8000);
      assert.equal(row.lines[0].unitPriceCents, 4150);
      assert.equal(row.stripeAccountId, ACCOUNT);
      assert.equal(row.holdExpiresAt!.getTime() - clock.t.getTime(), HOLD_MINUTES * 60_000);
      const params = row.checkoutParams as { lines: { unitAmountCents: number }[]; orderId: string };
      assert.equal(params.lines[0].unitAmountCents, 4150);
      assert.equal(params.orderId, row.id);
      assert.equal(row.redirectSnapshotUrl, "https://www.nba.com/wizards/tickets");
    });

    test("same idempotency key, sequential and concurrent → one order", async () => {
      clock.t = new Date();
      const f = await seedListing(db);
      const d = deps(db, new FakeStripe(() => new Date(clock.t)), clock);
      const input = orderInput(f, [{ variantId: f.m, quantity: 1 }]);
      const results = await Promise.all(Array.from({ length: 6 }, () => createOrder(input, d)));
      assert.equal(new Set(results.map((r) => r.orderId)).size, 1);
      const again = await createOrder(input, d);
      assert.equal(again.orderId, results[0].orderId);
      assert.equal(await db.daaliMerchOrder.count({ where: { listingId: f.listing.id } }), 1);
    });

    test("last shirt: 8 concurrent buyers, stock 1 → exactly one hold", async () => {
      clock.t = new Date();
      const f = await seedListing(db, { stock: 1 });
      const d = deps(db, new FakeStripe(() => new Date(clock.t)), clock);
      const settled = await Promise.allSettled(Array.from({ length: 8 }, () => createOrder(orderInput(f, [{ variantId: f.m, quantity: 1 }]), d)));
      const ok = settled.filter((s) => s.status === "fulfilled");
      const soldOut = settled.filter((s) => s.status === "rejected" && isMerchError(s.reason) && s.reason.code === "OUT_OF_STOCK");
      assert.equal(ok.length, 1);
      assert.equal(soldOut.length, 7);
      const rem = await remainingStock(db, [f.m], clock.t);
      assert.equal(rem.get(f.m), 0);
    });

    test("a lapsed hold returns stock; an unlimited size is never short", async () => {
      clock.t = new Date();
      const f = await seedListing(db, { stock: 1 });
      const d = deps(db, new FakeStripe(() => new Date(clock.t)), clock);
      await createOrder(orderInput(f, [{ variantId: f.m, quantity: 1 }]), d);
      await rejectsCode(createOrder(orderInput(f, [{ variantId: f.m, quantity: 1 }]), d), "OUT_OF_STOCK");
      clock.t = new Date(clock.t.getTime() + (HOLD_MINUTES + 1) * 60_000);
      await createOrder(orderInput(f, [{ variantId: f.m, quantity: 1 }]), d);
      await createOrder(orderInput(f, [{ variantId: f.l, quantity: 10 }]), d);
      assert.equal((await remainingStock(db, [f.l], clock.t)).get(f.l), null);
    });

    test("per-order limit, unknown variant, zero quantity, missing pickup", async () => {
      clock.t = new Date();
      const f = await seedListing(db, { perOrderLimit: 3 });
      const other = await seedListing(db);
      const d = deps(db, new FakeStripe(() => new Date(clock.t)), clock);
      await rejectsCode(createOrder(orderInput(f, [{ variantId: f.m, quantity: 2 }, { variantId: f.l, quantity: 2 }]), d), "OVER_LIMIT");
      await rejectsCode(createOrder(orderInput(f, [{ variantId: other.m, quantity: 1 }]), d), "INVALID_INPUT");
      await rejectsCode(createOrder(orderInput(f, [{ variantId: f.m, quantity: 0 }]), d), "INVALID_INPUT");
      await rejectsCode(createOrder({ ...orderInput(f, [{ variantId: f.m, quantity: 1 }]), fulfillmentOptionId: null }, d), "INVALID_INPUT");
    });

    test("rate limits: pending checkouts per email, orders per IP", async () => {
      clock.t = new Date();
      const f = await seedListing(db);
      const d = deps(db, new FakeStripe(() => new Date(clock.t)), clock);
      const email = "same@example.com";
      await createOrder(orderInput(f, [{ variantId: f.m, quantity: 1 }], { email }), d);
      await createOrder(orderInput(f, [{ variantId: f.m, quantity: 1 }], { email }), d);
      await rejectsCode(createOrder(orderInput(f, [{ variantId: f.m, quantity: 1 }], { email }), d), "TOO_MANY_PENDING");

      const g = await seedListing(db);
      for (let i = 0; i < 5; i++) await createOrder(orderInput(g, [{ variantId: g.m, quantity: 1 }], { ip: "203.0.113.9" }), d);
      await rejectsCode(createOrder(orderInput(g, [{ variantId: g.m, quantity: 1 }], { ip: "203.0.113.9" }), d), "RATE_LIMITED");
      const stored = await db.daaliMerchOrder.findFirstOrThrow({ where: { listingId: g.listing.id } });
      assert.notEqual(stored.ipHash, "203.0.113.9");
      assert.match(stored.ipHash!, /^[0-9a-f]{64}$/);
    });

    test("paid items refuse orders when the payee can't take charges", async () => {
      clock.t = new Date();
      const f = await seedListing(db);
      await rejectsCode(createOrder(orderInput(f, [{ variantId: f.m, quantity: 1 }]), deps(db, new FakeStripe(() => new Date(clock.t)), clock, { chargesEnabled: false })), "PAYMENTS_NOT_READY");
    });

    test("free: confirmed with a notification row; one per email; cancel frees the email", async () => {
      clock.t = new Date();
      const f = await seedListing(db, { paid: false });
      const d = deps(db, new FakeStripe(() => new Date(clock.t)), clock);
      const email = "free@example.com";
      const r = await createOrder(orderInput(f, [{ variantId: f.m, quantity: 2 }], { email }), d);
      assert.equal(r.kind, "confirmed_free");
      assert.equal(r.kind === "confirmed_free" && r.redirectUrl, "https://www.nba.com/wizards/tickets");
      const n = await db.daaliMerchNotification.findMany({ where: { orderId: r.orderId } });
      assert.deepEqual(n.map((x) => [x.kind, x.status]), [["FREE_CONFIRMATION", "PENDING"]]);
      await rejectsCode(createOrder(orderInput(f, [{ variantId: f.m, quantity: 1 }], { email: "FREE@example.com " }), d), "DUPLICATE_FREE_ORDER");
      assert.equal(await cancelFreeOrder(r.orderId, "someone-else", db, clock.t), false);
      assert.equal(await cancelFreeOrder(r.orderId, f.owner, db, clock.t), true);
      const again = await createOrder(orderInput(f, [{ variantId: f.m, quantity: 1 }], { email }), d);
      assert.equal(again.kind, "confirmed_free");
    });

    test("redirect is snapshotted at order time; unverified link is never used", async () => {
      clock.t = new Date();
      const stripe = new FakeStripe(() => new Date(clock.t));
      const { f, o } = await paidOrder(stripe);
      await db.daaliMerchListing.update({ where: { id: f.listing.id }, data: { redirectUrl: "https://evil.example.com" } });
      assert.equal((await db.daaliMerchOrder.findUniqueOrThrow({ where: { id: o.orderId } })).redirectSnapshotUrl, "https://www.nba.com/wizards/tickets");

      const g = await seedListing(db, { redirect: null });
      await db.daaliMerchListing.update({ where: { id: g.listing.id }, data: { redirectUrl: "https://unchecked.example.com" } });
      const o2 = await createOrder(orderInput(g, [{ variantId: g.m, quantity: 1 }]), deps(db, stripe, clock));
      assert.equal((await db.daaliMerchOrder.findUniqueOrThrow({ where: { id: o2.orderId } })).redirectSnapshotUrl, null);
    });

    test("draft and closed sales take no orders", async () => {
      clock.t = new Date();
      const f = await seedListing(db);
      const d = deps(db, new FakeStripe(() => new Date(clock.t)), clock);
      await db.daaliMerchListing.update({ where: { id: f.listing.id }, data: { status: "DRAFT" } });
      await rejectsCode(createOrder(orderInput(f, [{ variantId: f.m, quantity: 1 }]), d), "NOT_FOUND");
      await db.daaliMerchListing.update({ where: { id: f.listing.id }, data: { status: "OPEN", closesAt: new Date(clock.t.getTime() - 1000) } });
      await rejectsCode(createOrder(orderInput(f, [{ variantId: f.m, quantity: 1 }]), d), "CLOSED");
    });
  });

  // --------------------------------------------------------- startCheckout --

  describe("startCheckout (§5.7)", () => {
    test("creates once and stores the session; repeated calls return the same URL", async () => {
      clock.t = new Date();
      const stripe = new FakeStripe(() => new Date(clock.t));
      const { d, o } = await paidOrder(stripe);
      const a = await startCheckout(o.orderId, d);
      const b = await startCheckout(o.orderId, d);
      assert.equal(a.kind, "redirect");
      assert.deepEqual(a, b);
      assert.equal(stripe.sessions.size, 1);
      assert.equal(stripe.creates, 1);
      const row = await db.daaliMerchOrder.findUniqueOrThrow({ where: { id: o.orderId } });
      assert.ok(row.stripeSessionId?.startsWith("cs_test_"));
    });

    test("lost response (executed at Stripe) → retry → same session, never two", async () => {
      clock.t = new Date();
      const stripe = new FakeStripe(() => new Date(clock.t));
      const { d, o } = await paidOrder(stripe);
      stripe.failNext = { kind: "ambiguous", executeAnyway: true };
      assert.equal((await startCheckout(o.orderId, d)).kind, "retry");
      const r = await startCheckout(o.orderId, d);
      assert.equal(r.kind, "redirect");
      assert.equal(stripe.sessions.size, 1);
      assert.equal(stripe.byKey.size, 1);
    });

    test("ambiguous failure keeps the order pending; definite failure cancels and releases stock", async () => {
      clock.t = new Date();
      const stripe = new FakeStripe(() => new Date(clock.t));
      const { f, d, o } = await paidOrder(stripe, 1, 1);
      stripe.failNext = { kind: "ambiguous" };
      assert.equal((await startCheckout(o.orderId, d)).kind, "retry");
      assert.equal((await db.daaliMerchOrder.findUniqueOrThrow({ where: { id: o.orderId } })).status, "PENDING_PAYMENT");
      stripe.failNext = { kind: "definite" };
      assert.equal((await startCheckout(o.orderId, d)).kind, "failed");
      const row = await db.daaliMerchOrder.findUniqueOrThrow({ where: { id: o.orderId } });
      assert.equal(row.status, "CANCELLED");
      assert.equal((await remainingStock(db, [f.m], clock.t)).get(f.m), 1);
    });

    test("too late to create (hold nearly over) → EXPIRED, nothing sent to Stripe", async () => {
      clock.t = new Date();
      const stripe = new FakeStripe(() => new Date(clock.t));
      const { d, o } = await paidOrder(stripe);
      clock.t = new Date(clock.t.getTime() + 2 * 60_000);
      assert.equal((await startCheckout(o.orderId, d)).kind, "expired");
      assert.equal(stripe.creates, 0);
      assert.equal((await db.daaliMerchOrder.findUniqueOrThrow({ where: { id: o.orderId } })).status, "EXPIRED");
    });

    test("five concurrent starts → one session, one URL", async () => {
      clock.t = new Date();
      const stripe = new FakeStripe(() => new Date(clock.t));
      const { d, o } = await paidOrder(stripe);
      const rs = await Promise.all(Array.from({ length: 5 }, () => startCheckout(o.orderId, d)));
      const urls = new Set(rs.filter((r) => r.kind === "redirect").map((r) => (r as { url: string }).url));
      assert.equal(urls.size, 1);
      assert.equal(stripe.sessions.size, 1);
    });
  });

  // ---------------------------------------------------- fulfillFromSession --

  describe("fulfillFromSession (§5.3)", () => {
    async function checkedOut() {
      clock.t = new Date();
      const stripe = new FakeStripe(() => new Date(clock.t));
      const { f, d, o } = await paidOrder(stripe, 2, 5);
      const r = await startCheckout(o.orderId, d);
      assert.equal(r.kind, "redirect");
      const row = await db.daaliMerchOrder.findUniqueOrThrow({ where: { id: o.orderId } });
      return { f, d, o, stripe, sessionId: row.stripeSessionId! };
    }

    test("return route + webhook racing: PAID once, one receipt row", async () => {
      const { d, o, stripe, sessionId } = await checkedOut();
      const s = stripe.pay(sessionId);
      const rs = await Promise.all(Array.from({ length: 5 }, () => fulfillFromSession(s, ACCOUNT, d)));
      assert.ok(rs.every((r) => r.kind === "paid"));
      assert.equal(rs.filter((r) => r.kind === "paid" && r.changed).length, 1);
      assert.ok(rs.every((r) => r.kind === "paid" && r.redirectUrl === "https://www.nba.com/wizards/tickets"));
      const n = await db.daaliMerchNotification.findMany({ where: { orderId: o.orderId } });
      assert.deepEqual(n.map((x) => x.kind), ["RECEIPT"]);
      const row = await db.daaliMerchOrder.findUniqueOrThrow({ where: { id: o.orderId } });
      assert.equal(row.status, "PAID");
      assert.ok(row.stripePaymentIntentId);
      assert.equal(row.oversellFlag, false);
    });

    test("paid redirect never waits on email: no send happens during fulfillment", async () => {
      const { d, o, stripe, sessionId } = await checkedOut();
      const sender = new FakeSender();
      sender.gate = new Promise(() => {}); // a provider that never answers
      const r = await fulfillFromSession(stripe.pay(sessionId), ACCOUNT, d);
      assert.equal(r.kind, "paid");
      assert.equal(sender.sent.length, 0);
      assert.equal((await db.daaliMerchNotification.findFirstOrThrow({ where: { orderId: o.orderId } })).status, "PENDING");
    });

    test("amount mismatch, wrong account, unpaid session → no change", async () => {
      const { d, o, stripe, sessionId } = await checkedOut();
      assert.equal((await fulfillFromSession(await stripe.retrieveCheckoutSession(sessionId, ACCOUNT), ACCOUNT, d)).kind, "not_paid");
      const paid = stripe.pay(sessionId);
      assert.deepEqual(await fulfillFromSession({ ...paid, amountTotal: 100 }, ACCOUNT, d), { kind: "mismatch", reason: "amount" });
      assert.deepEqual(await fulfillFromSession(paid, "acct_someone_else", d), { kind: "mismatch", reason: "account" });
      assert.equal((await db.daaliMerchOrder.findUniqueOrThrow({ where: { id: o.orderId } })).status, "PENDING_PAYMENT");
      assert.equal(await db.daaliMerchNotification.count({ where: { orderId: o.orderId } }), 0);
    });

    test("unknown session id → unknown_session, nothing written", async () => {
      const { d, stripe, sessionId } = await checkedOut();
      const paid = stripe.pay(sessionId);
      assert.deepEqual(await fulfillFromSession({ ...paid, id: "cs_test_unknown", clientReferenceId: null, metadataOrderId: null }, ACCOUNT, d), { kind: "unknown_session" });
    });

    test("paid after the hold expired → PAID with oversell flag (money is never dropped)", async () => {
      const { d, o, stripe, sessionId } = await checkedOut();
      assert.equal(await expireFromSession(sessionId, ACCOUNT, d), true);
      const r = await fulfillFromSession(stripe.pay(sessionId), ACCOUNT, d);
      assert.equal(r.kind, "paid");
      const row = await db.daaliMerchOrder.findUniqueOrThrow({ where: { id: o.orderId } });
      assert.equal(row.status, "PAID");
      assert.equal(row.oversellFlag, true);
    });

    test("expired event after paid → ignored", async () => {
      const { d, o, stripe, sessionId } = await checkedOut();
      await fulfillFromSession(stripe.pay(sessionId), ACCOUNT, d);
      assert.equal(await expireFromSession(sessionId, ACCOUNT, d), false);
      assert.equal((await db.daaliMerchOrder.findUniqueOrThrow({ where: { id: o.orderId } })).status, "PAID");
    });

    test("session Daali never stored is matched by client_reference_id", async () => {
      clock.t = new Date();
      const stripe = new FakeStripe(() => new Date(clock.t));
      const { d, o } = await paidOrder(stripe);
      stripe.failNext = { kind: "ambiguous", executeAnyway: true };
      await startCheckout(o.orderId, d); // Stripe created it; Daali never stored it
      const [s] = [...stripe.sessions.values()];
      const r = await fulfillFromSession(stripe.pay(s.id), ACCOUNT, d);
      assert.equal(r.kind, "paid");
      assert.equal((await db.daaliMerchOrder.findUniqueOrThrow({ where: { id: o.orderId } })).stripeSessionId, s.id);
    });
  });

  // --------------------------------------------------------------- refunds --

  describe("refunds (D6)", () => {
    test("partial, full, replayed and out-of-order refund events converge", async () => {
      clock.t = new Date();
      const stripe = new FakeStripe(() => new Date(clock.t));
      const { f, d, o } = await paidOrder(stripe, 2, 5);
      await startCheckout(o.orderId, d);
      const row0 = await db.daaliMerchOrder.findUniqueOrThrow({ where: { id: o.orderId } });
      const paid = stripe.pay(row0.stripeSessionId!);
      await fulfillFromSession(paid, ACCOUNT, d);
      const pi = paid.paymentIntentId!;
      const state = async () => {
        const r = await db.daaliMerchOrder.findUniqueOrThrow({ where: { id: o.orderId } });
        return [r.status, r.refundedCents];
      };
      assert.equal(await applyRefund(pi, "acct_other", 4150, d), 0);
      await applyRefund(pi, ACCOUNT, 4150, d);
      assert.deepEqual(await state(), ["PARTIALLY_REFUNDED", 4150]);
      assert.equal((await remainingStock(db, [f.m], clock.t)).get(f.m), 3); // partial refund keeps the shirts sold
      await applyRefund(pi, ACCOUNT, 4150, d); // replay
      assert.deepEqual(await state(), ["PARTIALLY_REFUNDED", 4150]);
      await applyRefund(pi, ACCOUNT, 8300, d);
      assert.deepEqual(await state(), ["REFUNDED", 8300]);
      assert.equal((await remainingStock(db, [f.m], clock.t)).get(f.m), 5); // full refund releases them
      await applyRefund(pi, ACCOUNT, 4150, d); // late, older event
      assert.deepEqual(await state(), ["REFUNDED", 8300]);
      await applyRefund(pi, ACCOUNT, 99999, d); // never above total
      assert.deepEqual(await state(), ["REFUNDED", 8300]);
    });
  });

  // ------------------------------------------------------------- cron work --

  describe("reconciliation cron", () => {
    test("pending order whose session was never stored: recreate (same key), expire, release", async () => {
      clock.t = new Date();
      const stripe = new FakeStripe(() => new Date(clock.t));
      const { f, d, o } = await paidOrder(stripe, 1, 1);
      stripe.failNext = { kind: "ambiguous", executeAnyway: true };
      await startCheckout(o.orderId, d);
      clock.t = new Date(clock.t.getTime() + 3 * 60_000);
      const out = await recoverPendingWithoutSession(d);
      assert.deepEqual(out.filter((x) => x.orderId === o.orderId).map((x) => x.outcome), ["expired"]);
      // Same key → the same session, not a second one (other tests' orders share this fake).
      const mine = [...stripe.sessions.values()].filter((x) => x.clientReferenceId === o.orderId);
      assert.equal(mine.length, 1);
      assert.equal(mine[0].status, "expired");
      assert.equal((await db.daaliMerchOrder.findUniqueOrThrow({ where: { id: o.orderId } })).status, "EXPIRED");
      assert.equal((await remainingStock(db, [f.m], clock.t)).get(f.m), 1);
    });

    test("…and if the supporter had paid it, recovery marks it PAID", async () => {
      clock.t = new Date();
      const stripe = new FakeStripe(() => new Date(clock.t));
      const { d, o } = await paidOrder(stripe);
      stripe.failNext = { kind: "ambiguous", executeAnyway: true };
      await startCheckout(o.orderId, d);
      stripe.pay([...stripe.sessions.values()].find((x) => x.clientReferenceId === o.orderId)!.id);
      clock.t = new Date(clock.t.getTime() + 3 * 60_000);
      const out = await recoverPendingWithoutSession(d);
      assert.deepEqual(out.filter((x) => x.orderId === o.orderId).map((x) => x.outcome), ["paid"]);
      assert.equal((await db.daaliMerchOrder.findUniqueOrThrow({ where: { id: o.orderId } })).status, "PAID");
    });

    test("first request never reached Stripe: replay is rejected as too late → CANCELLED, nothing exists", async () => {
      clock.t = new Date();
      const stripe = new FakeStripe(() => new Date(clock.t));
      const { d, o } = await paidOrder(stripe);
      stripe.failNext = { kind: "ambiguous" }; // connection failed before Stripe saw it
      assert.equal((await startCheckout(o.orderId, d)).kind, "retry");
      clock.t = new Date(clock.t.getTime() + 3 * 60_000);
      const out = await recoverPendingWithoutSession(d, 500);
      assert.deepEqual(out.filter((x) => x.orderId === o.orderId).map((x) => x.outcome), ["cancelled"]);
      assert.equal([...stripe.sessions.values()].filter((x) => x.clientReferenceId === o.orderId).length, 0);
    });

    test("supporter left before checkout was ever attempted → EXPIRED without calling Stripe", async () => {
      clock.t = new Date();
      const stripe = new FakeStripe(() => new Date(clock.t));
      const { d, o } = await paidOrder(stripe);
      clock.t = new Date(clock.t.getTime() + 3 * 60_000);
      const before = stripe.creates;
      const out = await recoverPendingWithoutSession(d, 500);
      assert.deepEqual(out.filter((x) => x.orderId === o.orderId).map((x) => x.outcome), ["expired"]);
      assert.equal(stripe.creates, before);
    });

    test("lost webhook: stale pending with a paid session is fulfilled by reconcile", async () => {
      clock.t = new Date();
      const stripe = new FakeStripe(() => new Date(clock.t));
      const { d, o } = await paidOrder(stripe);
      await startCheckout(o.orderId, d);
      const sid = (await db.daaliMerchOrder.findUniqueOrThrow({ where: { id: o.orderId } })).stripeSessionId!;
      stripe.pay(sid);
      clock.t = new Date(clock.t.getTime() + (HOLD_MINUTES + 6) * 60_000);
      const out = await reconcileStalePending(d, 500);
      assert.deepEqual(out.filter((x) => x.orderId === o.orderId).map((x) => x.outcome), ["paid"]);
      assert.equal((await db.daaliMerchOrder.findUniqueOrThrow({ where: { id: o.orderId } })).status, "PAID");
    });
  });

  // ---------------------------------------------------------------- outbox --

  describe("receipt outbox (§5.8)", () => {
    async function paidWithReceipt() {
      clock.t = new Date();
      const stripe = new FakeStripe(() => new Date(clock.t));
      const { f, d, o } = await paidOrder(stripe, 2);
      await startCheckout(o.orderId, d);
      const sid = (await db.daaliMerchOrder.findUniqueOrThrow({ where: { id: o.orderId } })).stripeSessionId!;
      await fulfillFromSession(stripe.pay(sid), ACCOUNT, d);
      const n = await db.daaliMerchNotification.findFirstOrThrow({ where: { orderId: o.orderId } });
      return { f, o, n };
    }

    test("sends once with the documented key; escaped content; continue button", async () => {
      const { o, n } = await paidWithReceipt();
      await db.daaliMerchOrder.update({ where: { id: o.orderId }, data: { buyerName: "<b>Pat</b> Supporter" } });
      const sender = new FakeSender();
      await processOutbox(outbox(sender), { orderId: o.orderId });
      assert.equal(sender.sent.length, 1);
      assert.equal(sender.sent[0].idempotencyKey, `merch-receipt-${o.orderId}-0`);
      assert.ok(!sender.sent[0].html.includes("<b>Pat</b>"));
      assert.ok(sender.sent[0].html.includes("&lt;b&gt;Pat&lt;/b&gt;"));
      assert.ok(sender.sent[0].html.includes("Continue to nba.com"));
      const row = await db.daaliMerchNotification.findUniqueOrThrow({ where: { id: n.id } });
      assert.equal(row.status, "SENT");
      assert.ok(row.providerMessageId);
      await processOutbox(outbox(sender), { orderId: o.orderId });
      assert.equal(sender.sent.length, 1);
    });

    test("two workers at once → one email", async () => {
      const { o } = await paidWithReceipt();
      const sender = new FakeSender();
      await Promise.all(Array.from({ length: 4 }, () => processOutbox(outbox(sender), { orderId: o.orderId })));
      assert.equal(sender.sent.length, 1);
    });

    test("timeout after the provider accepted it → retry reuses the key → still one email", async () => {
      const { o, n } = await paidWithReceipt();
      const sender = new FakeSender();
      sender.script = ["ambiguous_delivered"];
      await processOutbox(outbox(sender), { orderId: o.orderId });
      let row = await db.daaliMerchNotification.findUniqueOrThrow({ where: { id: n.id } });
      assert.equal(row.status, "FAILED");
      assert.equal(row.nextAttemptAt.getTime() - clock.t.getTime(), 60_000);
      clock.t = new Date(clock.t.getTime() + 61_000);
      await processOutbox(outbox(sender), { orderId: o.orderId });
      row = await db.daaliMerchNotification.findUniqueOrThrow({ where: { id: n.id } });
      assert.equal(row.status, "SENT");
      assert.equal(sender.sent.length, 1);
      assert.equal(sender.delivered.size, 1);
    });

    test("fencing: a worker whose lease was taken over cannot overwrite the new owner", async () => {
      const { n } = await paidWithReceipt();
      const first = await claim(db, n.id, clock.t);
      assert.ok(first);
      assert.equal(await claim(db, n.id, clock.t), null); // leased
      clock.t = new Date(clock.t.getTime() + LEASE_MS + 1000);
      const second = await claim(db, n.id, clock.t);
      assert.ok(second);
      const sender = new FakeSender();
      assert.equal(await sendClaimed(first!, outbox(sender)), "lost_lease");
      assert.equal(await sendClaimed(second!, outbox(sender)), "sent");
      assert.equal(sender.sent.length, 1); // provider idempotency: same key on both
      assert.equal(idempotencyKeyFor(first!), idempotencyKeyFor(second!));
    });

    test("retries exhaust → final; after an ambiguous attempt the host sees 'may not have been delivered'", async () => {
      const { o, n } = await paidWithReceipt();
      const sender = new FakeSender();
      sender.script = ["ambiguous", "retryable", "retryable", "retryable", "retryable", "retryable"];
      for (let i = 0; i < MAX_ATTEMPTS + 2; i++) {
        await processOutbox(outbox(sender), { orderId: o.orderId });
        clock.t = new Date(clock.t.getTime() + 5 * 60 * 60_000);
      }
      const row = await db.daaliMerchNotification.findUniqueOrThrow({ where: { id: n.id } });
      assert.equal(row.status, "FAILED");
      assert.equal(row.attempts, MAX_ATTEMPTS);
      assert.equal(row.lastError, "delivery_unknown");
      assert.equal(sender.sent.length, 0);
    });

    test("definite provider rejection without ambiguity → final, plain error", async () => {
      const { o, n } = await paidWithReceipt();
      const sender = new FakeSender();
      sender.script = ["definite"];
      await processOutbox(outbox(sender), { orderId: o.orderId });
      const row = await db.daaliMerchNotification.findUniqueOrThrow({ where: { id: n.id } });
      assert.equal(row.attempts, MAX_ATTEMPTS);
      assert.equal(row.lastError, "422 invalid");
    });

    test("outside the 23h window nothing is auto-sent (no exactly-once claim)", async () => {
      const { o, n } = await paidWithReceipt();
      const sender = new FakeSender();
      sender.script = ["retryable"];
      await processOutbox(outbox(sender), { orderId: o.orderId });
      clock.t = new Date(clock.t.getTime() + 24 * 60 * 60_000);
      await processOutbox(outbox(sender), { orderId: o.orderId });
      const row = await db.daaliMerchNotification.findUniqueOrThrow({ where: { id: n.id } });
      assert.equal(row.lastError, "delivery_unknown");
      assert.equal(sender.sent.length, 0);
    });

    test("host resend is a deliberate second email with a new key", async () => {
      const { f, o } = await paidWithReceipt();
      const sender = new FakeSender();
      await processOutbox(outbox(sender), { orderId: o.orderId });
      assert.equal(await hostResend(o.orderId, "not-the-owner", db, clock.t), false);
      assert.equal(await hostResend(o.orderId, f.owner, db, clock.t), true);
      await processOutbox(outbox(sender), { orderId: o.orderId });
      assert.deepEqual(sender.sent.map((e) => e.idempotencyKey), [`merch-receipt-${o.orderId}-0`, `merch-receipt-${o.orderId}-1`]);
    });
  });

  // ---------------------------------------------------------- host actions --

  describe("host", () => {
    test("handed out: owner only, once, never on unpaid orders", async () => {
      clock.t = new Date();
      const stripe = new FakeStripe(() => new Date(clock.t));
      const { f, d, o } = await paidOrder(stripe);
      assert.equal(await markHandedOut(o.orderId, f.owner, db, clock.t), false); // pending
      await startCheckout(o.orderId, d);
      const sid = (await db.daaliMerchOrder.findUniqueOrThrow({ where: { id: o.orderId } })).stripeSessionId!;
      await fulfillFromSession(stripe.pay(sid), ACCOUNT, d);
      assert.equal(await markHandedOut(o.orderId, "intruder", db, clock.t), false);
      assert.equal(await markHandedOut(o.orderId, f.owner, db, clock.t), true);
      assert.equal(await markHandedOut(o.orderId, f.owner, db, clock.t), false);
    });

    test("CSV: owner only, confirmed orders only, formulas neutralized, tax line present", async () => {
      clock.t = new Date();
      const f = await seedListing(db, { paid: false });
      const d = deps(db, new FakeStripe(() => new Date(clock.t)), clock);
      await createOrder({ ...orderInput(f, [{ variantId: f.m, quantity: 1 }]), buyerName: "=HYPERLINK(\"http://x\")" }, d);
      assert.equal(await ordersCsv(f.listing.id, "intruder", db), null);
      const csv = (await ordersCsv(f.listing.id, f.owner, db))!;
      assert.ok(csv.includes(`"'=HYPERLINK(""http://x"")"`));
      assert.ok(csv.split("\r\n")[0].includes("Sales tax"));
      assert.ok(csv.includes("Team T-shirt · M"));
    });
  });

  // ------------------------------------------------- database constraints --

  describe("constraints in migration SQL", () => {
    test("CHECKs and partial unique reject bad rows the app would never write", async () => {
      clock.t = new Date();
      const f = await seedListing(db);
      await assert.rejects(db.$executeRaw`UPDATE daali_merch_variants SET stock_limit = -1 WHERE id = ${f.m}::uuid`);
      await assert.rejects(db.$executeRaw`UPDATE daali_merch_items SET net_cents = NULL WHERE listing_id = ${f.listing.id}::uuid`);
      await assert.rejects(db.$executeRaw`UPDATE daali_merch_listings SET redirect_url = 'http://plain.example.com' WHERE id = ${f.listing.id}::uuid`);
      const o = await createOrder(orderInput(f, [{ variantId: f.m, quantity: 1 }]), deps(db, new FakeStripe(() => new Date(clock.t)), clock));
      await assert.rejects(db.$executeRaw`UPDATE daali_merch_order_lines SET quantity = 0 WHERE order_id = ${o.orderId}::uuid`);
      await assert.rejects(db.$executeRaw`UPDATE daali_merch_orders SET refunded_cents = total_cents + 1 WHERE id = ${o.orderId}::uuid`);
    });
  });
});
