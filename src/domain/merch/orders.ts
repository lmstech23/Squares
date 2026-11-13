// Merch orders — spec §5. The ONLY code that changes an order's status.
//
//   createOrder          supporter submits sizes + details (free: confirmed; paid: pending + hold)
//   startCheckout        create / re-create the Checkout Session idempotently (§5.7)
//   fulfillFromSession   the only path to PAID (§5.3), called by return route, webhook, cron
//   expireFromSession    checkout.session.expired
//   applyRefund          charge.refunded (cumulative, order-independent)
//   recoverPendingWithoutSession / reconcileStalePending   cron (§5.7, §7.5)
//   cancelFreeOrder, markHandedOut   host actions
//
// Every transition is a conditional UPDATE: replaying any of them changes nothing.

import { randomBytes, randomUUID } from "node:crypto";
import type { PrismaClient, Prisma } from "@prisma/client";
import { MerchError } from "./errors.ts";
import { priceForNet, PROCESSING_ASSUMPTIONS } from "./pricing.ts";
import { normalizeEmail, requireText, hashIp } from "./validate.ts";
import type { CheckoutParams, MerchStripeGateway, SessionView } from "./stripe.ts";
import { MerchStripeError } from "./stripe.ts";

export const HOLD_MINUTES = 31; // Stripe requires expires_at ≥ 30 min after session creation
const STRIPE_MIN_EXPIRY_SECONDS = 30 * 60 + 30; // margin for clock skew
export const MAX_PENDING_PER_EMAIL = 2;
export const RATE = { perIp: 5, perIpWindowMin: 10, perEmail: 3, perEmailWindowMin: 60 };

export type Payee = { accountId: string; chargesEnabled: boolean };

export type MerchDeps = {
  db: PrismaClient;
  stripe: MerchStripeGateway;
  now: () => Date;
  resolvePayee: (ownerUserId: string) => Promise<Payee | null>;
  /** New-sale availability (MERCH_SALES_ENABLED). Gates createOrder and checkout creation only. */
  salesOpen: () => boolean;
  baseUrl: string;
  ipSalt: string;
};

export type OrderInput = {
  slug: string;
  idempotencyKey: string;
  buyerName: unknown;
  buyerEmail: unknown;
  buyerPhone: unknown;
  fulfillmentOptionId: unknown;
  answers: unknown;
  lines: { variantId: string; quantity: number }[];
  ip: string | null;
};

export type OrderOutcome =
  | { kind: "confirmed_free"; orderId: string; publicToken: string; redirectUrl: string | null }
  | { kind: "pending_payment"; orderId: string; publicToken: string };

type Tx = Prisma.TransactionClient;

// ------------------------------------------------------------- createOrder --

export async function createOrder(input: OrderInput, deps: MerchDeps): Promise<OrderOutcome> {
  const { db } = deps;
  const now = deps.now();

  const idem = String(input.idempotencyKey ?? "").trim();
  if (!/^[A-Za-z0-9_-]{16,80}$/.test(idem)) throw new MerchError("INVALID_INPUT", "Refresh the page and try again.");

  // Double submit / reload: the same key returns the same order.
  const existing = await db.daaliMerchOrder.findUnique({ where: { idempotencyKey: idem } });
  if (existing) return outcomeOf(existing);

  // New sales switched off: no new orders. (A replayed key above still returns its order.)
  if (!deps.salesOpen()) throw new MerchError("CLOSED", "This sale isn't taking orders right now.");

  const listing = await db.daaliMerchListing.findUnique({
    where: { slug: input.slug },
    include: {
      items: { where: { active: true }, include: { variants: { where: { active: true } } } },
      fulfillmentOptions: { where: { active: true } },
    },
  });
  if (!listing || listing.status === "DRAFT") throw new MerchError("NOT_FOUND", "This sale isn't available.");
  if (listing.status === "CLOSED" || (listing.closesAt && listing.closesAt <= now)) {
    throw new MerchError("CLOSED", "Orders for this sale are closed.");
  }

  const buyerName = requireText(input.buyerName, "Name", 120)!;
  const buyerEmail = normalizeEmail(input.buyerEmail);
  const buyerPhone = requireText(input.buyerPhone, "Phone", 40, true);

  let fulfillmentOptionId: string | null = null;
  if (listing.fulfillmentOptions.length > 0) {
    const f = listing.fulfillmentOptions.find((o) => o.id === input.fulfillmentOptionId);
    if (!f) throw new MerchError("INVALID_INPUT", "Choose how you'll get your items.");
    fulfillmentOptionId = f.id;
  }

  const answers = collectAnswers(listing.questions, input.answers);

  // Lines → variants of this listing, quantities within each item's limit.
  if (!Array.isArray(input.lines) || input.lines.length === 0) {
    throw new MerchError("INVALID_INPUT", "Choose at least one item.");
  }
  const variantIndex = new Map<string, { item: (typeof listing.items)[number]; variant: (typeof listing.items)[number]["variants"][number] }>();
  for (const item of listing.items) for (const v of item.variants) variantIndex.set(v.id, { item, variant: v });

  const merged = new Map<string, number>();
  for (const l of input.lines) {
    const q = Number(l?.quantity);
    if (!variantIndex.has(l?.variantId) || !Number.isInteger(q) || q < 0 || q > 100) {
      throw new MerchError("INVALID_INPUT", "One of the items isn't available. Refresh and try again.");
    }
    if (q > 0) merged.set(l.variantId, (merged.get(l.variantId) ?? 0) + q);
  }
  if (merged.size === 0) throw new MerchError("INVALID_INPUT", "Choose at least one item.");

  const perItem = new Map<string, number>();
  for (const [vid, q] of merged) {
    const { item } = variantIndex.get(vid)!;
    perItem.set(item.id, (perItem.get(item.id) ?? 0) + q);
  }
  for (const [itemId, q] of perItem) {
    const item = listing.items.find((i) => i.id === itemId)!;
    if (q > item.perOrderLimit) {
      throw new MerchError("OVER_LIMIT", `You can order up to ${item.perOrderLimit} of ${item.name} at a time.`);
    }
  }

  const lines = [...merged].map(([vid, quantity]) => {
    const { item, variant } = variantIndex.get(vid)!;
    const unitNet = item.priceMode === "PAID" ? item.netCents! : 0;
    const unitPrice = item.priceMode === "PAID" ? priceForNet(unitNet, item.perOrderLimit) : 0;
    return { item, variant, quantity, unitPrice, unitNet };
  });
  const totalCents = lines.reduce((a, l) => a + l.quantity * l.unitPrice, 0);
  const organizerNetCents = lines.reduce((a, l) => a + l.quantity * l.unitNet, 0);

  // D10 rate limits, counted from orders already created.
  const ipHash = hashIp(input.ip, deps.ipSalt);
  await enforceRateLimits(db, listing.id, buyerEmail, ipHash, now);

  let payee: Payee | null = null;
  if (totalCents > 0) {
    if (!listing.taxHandling) throw new MerchError("CLOSED", "This sale isn't ready for payments yet.");
    payee = await deps.resolvePayee(listing.ownerUserId);
    if (!payee || !payee.chargesEnabled) {
      throw new MerchError("PAYMENTS_NOT_READY", "This sale can't take card payments right now. Please contact the organizer.");
    }
    const pending = await db.daaliMerchOrder.count({
      where: { listingId: listing.id, buyerEmail, status: "PENDING_PAYMENT", holdExpiresAt: { gt: now } },
    });
    if (pending >= MAX_PENDING_PER_EMAIL) {
      throw new MerchError("TOO_MANY_PENDING", "You already have checkouts in progress. Finish one or wait a few minutes.");
    }
  }

  const publicToken = randomBytes(24).toString("base64url");
  const orderId = randomUUID();
  const holdExpiresAt = new Date(now.getTime() + HOLD_MINUTES * 60_000);

  try {
    await db.$transaction(async (tx) => {
      // Lock the variants, in a stable order, then check stock inside the lock.
      const ids = lines.map((l) => l.variant.id).sort();
      await tx.$queryRaw`SELECT id FROM daali_merch_variants WHERE id = ANY(${ids}::uuid[]) ORDER BY id FOR UPDATE`;
      const remaining = await remainingStock(tx, ids, now);
      for (const l of lines) {
        const r = remaining.get(l.variant.id);
        if (r !== null && r !== undefined && r < l.quantity) {
          throw new MerchError(
            "OUT_OF_STOCK",
            r <= 0 ? `${l.item.name} in ${l.variant.label} is sold out.` : `Only ${r} left of ${l.item.name} in ${l.variant.label}.`
          );
        }
      }

      const base = {
        id: orderId,
        listingId: listing.id,
        publicToken,
        idempotencyKey: idem,
        buyerName,
        buyerEmail,
        buyerPhone,
        fulfillmentOptionId,
        answers: answers as Prisma.InputJsonValue,
        totalCents,
        organizerNetCents,
        pricingVersion: PROCESSING_ASSUMPTIONS.version,
        redirectSnapshotUrl: listing.redirectVerifiedAt ? listing.redirectUrl : null,
        ipHash,
      };

      if (totalCents === 0) {
        await tx.daaliMerchOrder.create({ data: { ...base, status: "CONFIRMED_FREE", confirmedAt: now } });
      } else {
        const params: CheckoutParams = {
          currency: "usd",
          lines: lines.map((l) => ({ name: `${l.item.name} · ${l.variant.label}`, unitAmountCents: l.unitPrice, quantity: l.quantity })),
          expiresAtUnix: Math.floor(holdExpiresAt.getTime() / 1000),
          successUrl: `${deps.baseUrl}/merch/return?cs={CHECKOUT_SESSION_ID}`,
          cancelUrl: `${deps.baseUrl}/merch/${listing.slug}?cancelled=1`,
          customerEmail: buyerEmail,
          orderId,
        };
        await tx.daaliMerchOrder.create({
          data: {
            ...base,
            status: "PENDING_PAYMENT",
            holdExpiresAt,
            stripeAccountId: payee!.accountId,
            checkoutParams: params as unknown as Prisma.InputJsonValue,
          },
        });
      }

      await tx.daaliMerchOrderLine.createMany({
        data: lines.map((l) => ({
          orderId,
          itemId: l.item.id,
          variantId: l.variant.id,
          quantity: l.quantity,
          unitPriceCents: l.unitPrice,
          unitNetCents: l.unitNet,
          itemName: l.item.name,
          variantLabel: l.variant.label,
        })),
      });

      if (totalCents === 0) {
        await tx.daaliMerchNotification.create({ data: { orderId, kind: "FREE_CONFIRMATION", nextAttemptAt: now } });
      }
    });
  } catch (e) {
    const code = (e as { code?: string; meta?: { target?: unknown } })?.code;
    if (code === "P2002") {
      // Either the same idempotency key raced in, or a second free reservation.
      const raced = await db.daaliMerchOrder.findUnique({ where: { idempotencyKey: idem } });
      if (raced) return outcomeOf(raced);
      throw new MerchError("DUPLICATE_FREE_ORDER", "You've already reserved with this email. Check your inbox for the confirmation.");
    }
    throw e;
  }

  const created = await db.daaliMerchOrder.findUniqueOrThrow({ where: { id: orderId } });
  return outcomeOf(created);
}

function outcomeOf(o: { id: string; publicToken: string; status: string; redirectSnapshotUrl: string | null }): OrderOutcome {
  if (o.status === "CONFIRMED_FREE") {
    return { kind: "confirmed_free", orderId: o.id, publicToken: o.publicToken, redirectUrl: o.redirectSnapshotUrl };
  }
  return { kind: "pending_payment", orderId: o.id, publicToken: o.publicToken };
}

function collectAnswers(questionsJson: unknown, raw: unknown): Record<string, string> {
  const questions = Array.isArray(questionsJson) ? (questionsJson as { key: string; label: string; required?: boolean }[]) : [];
  const given = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const out: Record<string, string> = {};
  for (const q of questions) {
    const v = String(given[q.key] ?? "").trim().slice(0, 200);
    if (!v && q.required) throw new MerchError("INVALID_INPUT", `Please answer: ${q.label}`);
    if (v) out[q.key] = v;
  }
  return out;
}

async function enforceRateLimits(db: PrismaClient, listingId: string, email: string, ipHash: string | null, now: Date) {
  const sinceEmail = new Date(now.getTime() - RATE.perEmailWindowMin * 60_000);
  const byEmail = await db.daaliMerchOrder.count({ where: { listingId, buyerEmail: email, createdAt: { gte: sinceEmail } } });
  if (byEmail >= RATE.perEmail) throw new MerchError("RATE_LIMITED", "Too many tries. Try again in a few minutes.");
  if (ipHash) {
    const sinceIp = new Date(now.getTime() - RATE.perIpWindowMin * 60_000);
    const byIp = await db.daaliMerchOrder.count({ where: { listingId, ipHash, createdAt: { gte: sinceIp } } });
    if (byIp >= RATE.perIp) throw new MerchError("RATE_LIMITED", "Too many tries. Try again in a few minutes.");
  }
}

/** variantId → remaining units (null = unlimited). Derived, never stored. */
export async function remainingStock(tx: Tx | PrismaClient, variantIds: string[], now: Date): Promise<Map<string, number | null>> {
  const rows = await tx.$queryRaw<{ id: string; stock_limit: number | null; used: bigint }[]>`
    SELECT v.id, v.stock_limit,
           COALESCE(SUM(l.quantity) FILTER (
             WHERE o.status IN ('PAID', 'CONFIRMED_FREE', 'PARTIALLY_REFUNDED')
                OR (o.status = 'PENDING_PAYMENT' AND o.hold_expires_at > ${now})
           ), 0) AS used
      FROM daali_merch_variants v
      LEFT JOIN daali_merch_order_lines l ON l.variant_id = v.id
      LEFT JOIN daali_merch_orders o ON o.id = l.order_id
     WHERE v.id = ANY(${variantIds}::uuid[])
     GROUP BY v.id, v.stock_limit`;
  const out = new Map<string, number | null>();
  for (const r of rows) out.set(r.id, r.stock_limit === null ? null : r.stock_limit - Number(r.used));
  return out;
}

// ----------------------------------------------------------- startCheckout --

export type CheckoutResult =
  | { kind: "redirect"; url: string }
  | { kind: "retry" } // ambiguous: try again with the same key
  | { kind: "failed"; message: string } // definite: order cancelled, nothing charged
  | { kind: "expired" }
  | { kind: "not_pending"; status: string }
  | { kind: "sales_closed" }; // new sales switched off before a session was created

/**
 * Create the Checkout Session for a pending order, or recover the one Stripe
 * already created. Always the same idempotency key and the same frozen params.
 */
export async function startCheckout(orderId: string, deps: MerchDeps): Promise<CheckoutResult> {
  const { db } = deps;
  const now = deps.now();
  const order = await db.daaliMerchOrder.findUnique({ where: { id: orderId } });
  if (!order) throw new MerchError("NOT_FOUND", "Order not found.");
  if (order.status !== "PENDING_PAYMENT") return { kind: "not_pending", status: order.status };
  if (order.stripeSessionId && order.checkoutUrl) return { kind: "redirect", url: order.checkoutUrl };

  // New sales switched off: create nothing. A never-attempted order releases its
  // hold now; one with an earlier attempt is left for recoverPendingWithoutSession,
  // which replays the key and ends any session Stripe did create.
  if (!deps.salesOpen()) {
    if (order.checkoutAttempts === 0) await expireOrder(db, order.id, now, "sales_closed");
    return { kind: "sales_closed" };
  }

  const params = order.checkoutParams as unknown as CheckoutParams;
  if (order.checkoutAttempts === 0 && params.expiresAtUnix - Math.floor(now.getTime() / 1000) < STRIPE_MIN_EXPIRY_SECONDS) {
    // Never sent to Stripe, and now too late: Stripe would reject expires_at. Release the hold.
    // After an earlier attempt we always replay instead: Stripe answers a replayed
    // idempotency key with the original result, so a session it already created comes back.
    await expireOrder(db, order.id, now, "too_late_to_create_checkout");
    return { kind: "expired" };
  }

  await db.daaliMerchOrder.update({ where: { id: order.id }, data: { checkoutAttempts: { increment: 1 } } });

  let session: SessionView;
  try {
    session = await deps.stripe.createCheckoutSession(params, order.stripeAccountId!, checkoutIdempotencyKey(order.id));
  } catch (e) {
    const kind = e instanceof MerchStripeError ? e.kind : "ambiguous";
    const message = (e as Error)?.message?.slice(0, 500) ?? "unknown";
    if (kind === "definite") {
      await db.daaliMerchOrder.updateMany({
        where: { id: order.id, status: "PENDING_PAYMENT", stripeSessionId: null },
        data: { status: "CANCELLED", cancelledAt: now, checkoutError: message },
      });
      return { kind: "failed", message: "Payment couldn't start. Nothing was charged. Please try again." };
    }
    await db.daaliMerchOrder.update({ where: { id: order.id }, data: { checkoutError: message } });
    return { kind: "retry" };
  }

  if (!session.url) return { kind: "retry" };
  const stored = await db.daaliMerchOrder.updateMany({
    where: { id: order.id, status: "PENDING_PAYMENT", stripeSessionId: null },
    data: { stripeSessionId: session.id, checkoutUrl: session.url, checkoutError: null },
  });
  if (stored.count === 0) {
    const fresh = await db.daaliMerchOrder.findUniqueOrThrow({ where: { id: order.id } });
    if (fresh.stripeSessionId === session.id && fresh.checkoutUrl) return { kind: "redirect", url: fresh.checkoutUrl };
    if (fresh.status !== "PENDING_PAYMENT") return { kind: "not_pending", status: fresh.status };
    // A different session is already stored (cannot happen with one idempotency key); never hand out two.
    await safeExpire(deps, session.id, order.stripeAccountId!);
    return fresh.checkoutUrl ? { kind: "redirect", url: fresh.checkoutUrl } : { kind: "retry" };
  }
  return { kind: "redirect", url: session.url };
}

export function checkoutIdempotencyKey(orderId: string) {
  return `merch-checkout-${orderId}`;
}

async function safeExpire(deps: MerchDeps, sessionId: string, account: string) {
  try {
    await deps.stripe.expireCheckoutSession(sessionId, account);
  } catch {
    /* the reconciliation cron retries */
  }
}

async function expireOrder(db: PrismaClient, orderId: string, now: Date, reason: string) {
  await db.daaliMerchOrder.updateMany({
    where: { id: orderId, status: "PENDING_PAYMENT" },
    data: { status: "EXPIRED", checkoutError: reason },
  });
}

// ------------------------------------------------------ fulfillFromSession --

export type FulfillResult =
  | { kind: "paid"; orderId: string; changed: boolean; redirectUrl: string | null; publicToken: string }
  | { kind: "not_paid"; orderId: string; publicToken: string }
  | { kind: "mismatch"; reason: string }
  | { kind: "unknown_session" };

/**
 * The only path to PAID. `session` must come from Stripe (webhook payload whose
 * signature was verified, or a server-side retrieve) and `account` is the
 * connected account it belongs to.
 */
export async function fulfillFromSession(session: SessionView, account: string, deps: MerchDeps): Promise<FulfillResult> {
  const { db } = deps;
  const now = deps.now();

  let order = await db.daaliMerchOrder.findUnique({ where: { stripeSessionId: session.id } });
  if (!order) {
    // A session Daali never stored (lost response, spec §5.7): match by the
    // order id it carries, then prove it with payee and amount below.
    const ref = session.clientReferenceId ?? session.metadataOrderId;
    if (ref && /^[0-9a-f-]{36}$/i.test(ref)) {
      const byRef = await db.daaliMerchOrder.findUnique({ where: { id: ref } });
      if (byRef && (byRef.stripeSessionId === null || byRef.stripeSessionId === session.id)) order = byRef;
    }
  }
  if (!order) return { kind: "unknown_session" };

  if (order.stripeAccountId !== account) return { kind: "mismatch", reason: "account" };
  if (session.status !== "complete" || session.paymentStatus !== "paid") {
    return { kind: "not_paid", orderId: order.id, publicToken: order.publicToken };
  }
  if (session.amountTotal !== order.totalCents || (session.currency ?? "usd") !== "usd") {
    console.error(`merch: amount mismatch on order ${order.id}: session ${session.amountTotal} vs order ${order.totalCents}`);
    return { kind: "mismatch", reason: "amount" };
  }

  const changed = await db.$transaction(async (tx) => {
    const rows = await tx.$executeRaw`
      UPDATE daali_merch_orders
         SET oversell_flag = (status = 'EXPIRED'),
             status = 'PAID',
             paid_at = ${now},
             stripe_session_id = COALESCE(stripe_session_id, ${session.id}),
             stripe_payment_intent_id = COALESCE(stripe_payment_intent_id, ${session.paymentIntentId}),
             checkout_url = COALESCE(checkout_url, ${session.url ?? ""})
       WHERE id = ${order!.id}::uuid
         AND status IN ('PENDING_PAYMENT', 'EXPIRED')
         AND (stripe_session_id IS NULL OR stripe_session_id = ${session.id})`;
    if (rows !== 1) return false;
    // Created in the same transaction as PAID: no paid order without a receipt.
    await tx.$executeRaw`
      INSERT INTO daali_merch_notifications (order_id, kind, next_attempt_at)
      VALUES (${order!.id}::uuid, 'RECEIPT', ${now})
      ON CONFLICT (order_id, kind) DO NOTHING`;
    return true;
  });

  const fresh = await db.daaliMerchOrder.findUniqueOrThrow({ where: { id: order.id } });
  if (!["PAID", "REFUNDED", "PARTIALLY_REFUNDED"].includes(fresh.status)) {
    return { kind: "not_paid", orderId: fresh.id, publicToken: fresh.publicToken };
  }
  return { kind: "paid", orderId: fresh.id, changed, redirectUrl: fresh.redirectSnapshotUrl, publicToken: fresh.publicToken };
}

/** Best-effort: store Stripe's actual fee for the host report. */
export async function recordStripeFee(orderId: string, deps: MerchDeps): Promise<void> {
  const o = await deps.db.daaliMerchOrder.findUnique({ where: { id: orderId } });
  if (!o || o.stripeFeeCents !== null || !o.stripePaymentIntentId || !o.stripeAccountId) return;
  try {
    const feeCents = await deps.stripe.paymentFeeCents(o.stripePaymentIntentId, o.stripeAccountId);
    if (feeCents !== null) {
      await deps.db.daaliMerchOrder.updateMany({ where: { id: o.id, stripeFeeCents: null }, data: { stripeFeeCents: feeCents } });
    }
  } catch {
    /* retried by the cron */
  }
}

// ----------------------------------------------------- expire / refund ----

export async function expireFromSession(sessionId: string, account: string, deps: MerchDeps): Promise<boolean> {
  const r = await deps.db.daaliMerchOrder.updateMany({
    where: { stripeSessionId: sessionId, stripeAccountId: account, status: "PENDING_PAYMENT" },
    data: { status: "EXPIRED" },
  });
  return r.count === 1;
}

/** charge.refunded: `amountRefunded` is Stripe's cumulative total, so replays and reordering are harmless. */
export async function applyRefund(paymentIntentId: string, account: string, amountRefunded: number, deps: MerchDeps) {
  return deps.db.$executeRaw`
    UPDATE daali_merch_orders
       SET refunded_cents = GREATEST(refunded_cents, LEAST(${amountRefunded}::int, total_cents)),
           status = CASE
             WHEN GREATEST(refunded_cents, LEAST(${amountRefunded}::int, total_cents)) >= total_cents THEN 'REFUNDED'::daali_merch_order_status
             ELSE 'PARTIALLY_REFUNDED'::daali_merch_order_status
           END
     WHERE stripe_payment_intent_id = ${paymentIntentId}
       AND stripe_account_id = ${account}
       AND status IN ('PAID', 'PARTIALLY_REFUNDED', 'REFUNDED')
       AND ${amountRefunded}::int > 0`;
}

// -------------------------------------------------------------- cron work --

/** Pending orders whose session Daali never stored (spec §5.7). */
export async function recoverPendingWithoutSession(deps: MerchDeps, limit = 25) {
  const { db } = deps;
  const now = deps.now();
  const cutoff = new Date(now.getTime() - 2 * 60_000);
  const stuck = await db.daaliMerchOrder.findMany({
    where: { status: "PENDING_PAYMENT", stripeSessionId: null, createdAt: { lt: cutoff } },
    take: limit,
    orderBy: { createdAt: "asc" },
  });
  const results: { orderId: string; outcome: string }[] = [];
  for (const o of stuck) {
    const params = o.checkoutParams as unknown as CheckoutParams;
    if (o.checkoutAttempts === 0) {
      // Never sent to Stripe, so no session can exist. Release the hold.
      await expireOrder(db, o.id, now, "abandoned_before_checkout");
      results.push({ orderId: o.id, outcome: "expired" });
      continue;
    }
    try {
      // Replay with the same key and the same frozen params. If Stripe created a
      // session, the replay returns that session (Stripe replays the original
      // result for 24h without re-validating expires_at). If the original never
      // reached Stripe, this is a new request and Stripe rejects the now-short
      // expiry: a definite failure, handled below, and nothing was ever created.
      const s = await deps.stripe.createCheckoutSession(params, o.stripeAccountId!, checkoutIdempotencyKey(o.id));
      // The supporter has left and never received this URL: end it now.
      const ended = await deps.stripe.expireCheckoutSession(s.id, o.stripeAccountId!);
      if (ended.status === "complete" && ended.paymentStatus === "paid") {
        await db.daaliMerchOrder.updateMany({ where: { id: o.id, stripeSessionId: null }, data: { stripeSessionId: s.id } });
        await fulfillFromSession(ended, o.stripeAccountId!, deps);
        results.push({ orderId: o.id, outcome: "paid" });
        continue;
      }
      await db.daaliMerchOrder.updateMany({
        where: { id: o.id, status: "PENDING_PAYMENT", stripeSessionId: null },
        data: { status: "EXPIRED", stripeSessionId: s.id, checkoutError: "recovered_lost_session" },
      });
      results.push({ orderId: o.id, outcome: "expired" });
    } catch (e) {
      if (e instanceof MerchStripeError && e.kind === "definite") {
        await db.daaliMerchOrder.updateMany({
          where: { id: o.id, status: "PENDING_PAYMENT", stripeSessionId: null },
          data: { status: "CANCELLED", cancelledAt: now, checkoutError: e.message.slice(0, 500) },
        });
        results.push({ orderId: o.id, outcome: "cancelled" });
      } else {
        results.push({ orderId: o.id, outcome: "retry_later" });
      }
    }
  }
  return results;
}

/** Pending orders with a session whose hold has lapsed: ask Stripe what happened (spec §7.5). */
export async function reconcileStalePending(deps: MerchDeps, limit = 25) {
  const { db } = deps;
  const now = deps.now();
  const cutoff = new Date(now.getTime() - 5 * 60_000);
  const stale = await db.daaliMerchOrder.findMany({
    where: { status: "PENDING_PAYMENT", stripeSessionId: { not: null }, holdExpiresAt: { lt: cutoff } },
    take: limit,
    orderBy: { holdExpiresAt: "asc" },
  });
  const results: { orderId: string; outcome: string }[] = [];
  for (const o of stale) {
    try {
      const s = await deps.stripe.retrieveCheckoutSession(o.stripeSessionId!, o.stripeAccountId!);
      if (s.status === "complete" && s.paymentStatus === "paid") {
        const r = await fulfillFromSession(s, o.stripeAccountId!, deps);
        results.push({ orderId: o.id, outcome: r.kind });
      } else if (s.status === "expired") {
        await expireFromSession(s.id, o.stripeAccountId!, deps);
        results.push({ orderId: o.id, outcome: "expired" });
      } else {
        results.push({ orderId: o.id, outcome: "still_open" });
      }
    } catch {
      results.push({ orderId: o.id, outcome: "retry_later" });
    }
  }
  return results;
}

// ------------------------------------------------------------ host actions --

export async function cancelFreeOrder(orderId: string, ownerUserId: string, db: PrismaClient, now: Date) {
  const r = await db.$executeRaw`
    UPDATE daali_merch_orders o SET status = 'CANCELLED', cancelled_at = ${now}
      FROM daali_merch_listings l
     WHERE o.id = ${orderId}::uuid AND l.id = o.listing_id AND l.owner_user_id = ${ownerUserId}
       AND o.status = 'CONFIRMED_FREE'`;
  return r === 1;
}

export async function markHandedOut(orderId: string, ownerUserId: string, db: PrismaClient, now: Date) {
  const r = await db.$executeRaw`
    UPDATE daali_merch_orders o SET fulfillment_status = 'HANDED_OUT', handed_out_at = ${now}, handed_out_by = ${ownerUserId}
      FROM daali_merch_listings l
     WHERE o.id = ${orderId}::uuid AND l.id = o.listing_id AND l.owner_user_id = ${ownerUserId}
       AND o.status IN ('PAID', 'CONFIRMED_FREE', 'PARTIALLY_REFUNDED')
       AND o.fulfillment_status = 'UNFULFILLED'`;
  return r === 1;
}
