// Test-only helpers for the merch integration suite. Imported by *.test.ts only.
//
// The client is built the repo's usual way (datasource URL). MERCH_TEST_PRISMA_ADAPTER=pg
// switches to the pg driver adapter, for machines where Prisma's native engine
// cannot be downloaded; it changes how queries reach Postgres, not what they do.

import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import type { MerchDeps } from "./orders.ts";
import type { CheckoutParams, MerchStripeGateway, SessionView } from "./stripe.ts";
import { MerchStripeError } from "./stripe.ts";
import type { EmailSender, OutgoingEmail } from "./notifications.ts";
import { EmailSendError } from "./notifications.ts";

export async function testClient(url: string): Promise<PrismaClient> {
  if (process.env.MERCH_TEST_PRISMA_ADAPTER === "pg") {
    const mod = "@prisma/adapter-pg";
    const { PrismaPg } = (await import(mod)) as { PrismaPg: new (cfg: { connectionString: string }) => unknown };
    return new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) } as never);
  }
  return new PrismaClient({ datasources: { db: { url } } });
}

// ----------------------------------------------------------- fake Stripe --

type FakeSession = SessionView & { account: string; params: CheckoutParams; key: string };

/**
 * In-memory Stripe with real idempotency semantics: the same key returns the
 * same session. `failNext` injects a failure on the next create.
 */
export class FakeStripe implements MerchStripeGateway {
  sessions = new Map<string, FakeSession>();
  byKey = new Map<string, string>();
  creates = 0;
  expires = 0;
  failNext: null | { kind: "definite" | "ambiguous"; executeAnyway?: boolean } = null;
  fee = 150;
  private clock: () => Date;
  constructor(clock: () => Date = () => new Date()) {
    this.clock = clock;
  }

  async createCheckoutSession(params: CheckoutParams, account: string, key: string): Promise<SessionView> {
    this.creates++;
    const fail = this.failNext;
    this.failNext = null;
    const existing = this.byKey.get(key);
    if (fail && !fail.executeAnyway) throw new MerchStripeError(fail.kind, `injected ${fail.kind}`);
    let s: FakeSession;
    if (existing) s = this.sessions.get(existing)!; // idempotent replay: original result, not re-validated
    else {
      if (params.expiresAtUnix - Math.floor(this.clock().getTime() / 1000) < 30 * 60) {
        throw new MerchStripeError("definite", "expires_at must be at least 30 minutes in the future");
      }
      const id = "cs_test_" + randomUUID().replace(/-/g, "");
      s = {
        id,
        url: `https://checkout.stripe.test/${id}`,
        status: "open",
        paymentStatus: "unpaid",
        amountTotal: params.lines.reduce((a, l) => a + l.unitAmountCents * l.quantity, 0),
        currency: "usd",
        clientReferenceId: params.orderId,
        paymentIntentId: null,
        metadataOrderId: params.orderId,
        account,
        params,
        key,
      };
      this.sessions.set(id, s);
      this.byKey.set(key, id);
    }
    // Executed at Stripe, but the response was lost.
    if (fail?.executeAnyway) throw new MerchStripeError("ambiguous", "injected lost response");
    return view(s);
  }

  async retrieveCheckoutSession(id: string, account: string): Promise<SessionView> {
    const s = this.sessions.get(id);
    if (!s || s.account !== account) throw new MerchStripeError("definite", "No such checkout session");
    return view(s);
  }

  async expireCheckoutSession(id: string, account: string): Promise<SessionView> {
    this.expires++;
    const s = this.sessions.get(id);
    if (!s || s.account !== account) throw new MerchStripeError("definite", "No such checkout session");
    if (s.status === "open") s.status = "expired";
    return view(s);
  }

  async paymentFeeCents(): Promise<number | null> {
    return this.fee;
  }

  /** Simulate the supporter paying. */
  pay(id: string, amount?: number): SessionView {
    const s = this.sessions.get(id)!;
    s.status = "complete";
    s.paymentStatus = "paid";
    s.paymentIntentId = "pi_test_" + id.slice(8, 30);
    if (amount !== undefined) s.amountTotal = amount;
    return view(s);
  }
}

function view(s: FakeSession): SessionView {
  return {
    id: s.id, url: s.url, status: s.status, paymentStatus: s.paymentStatus, amountTotal: s.amountTotal,
    currency: s.currency, clientReferenceId: s.clientReferenceId, paymentIntentId: s.paymentIntentId, metadataOrderId: s.metadataOrderId,
  };
}

// ------------------------------------------------------------- fake email --

export class FakeSender implements EmailSender {
  sent: OutgoingEmail[] = [];
  /** Provider-side idempotency: same key within the window → same id, one delivery. */
  delivered = new Map<string, string>();
  script: ("ok" | "ambiguous" | "retryable" | "definite" | "ambiguous_delivered")[] = [];
  gate: Promise<void> | null = null;

  async send(email: OutgoingEmail): Promise<{ id: string }> {
    if (this.gate) await this.gate;
    const step = this.script.shift() ?? "ok";
    if (step === "ambiguous_delivered") {
      this.record(email);
      throw new EmailSendError("timeout", { retryable: true, ambiguous: true });
    }
    if (step === "ambiguous") throw new EmailSendError("timeout", { retryable: true, ambiguous: true });
    if (step === "retryable") throw new EmailSendError("429", { retryable: true, ambiguous: false });
    if (step === "definite") throw new EmailSendError("422 invalid", { retryable: false, ambiguous: false });
    return { id: this.record(email) };
  }

  private record(email: OutgoingEmail): string {
    const prior = this.delivered.get(email.idempotencyKey);
    if (prior) return prior;
    const id = "em_" + randomUUID();
    this.delivered.set(email.idempotencyKey, id);
    this.sent.push(email);
    return id;
  }
}

// ---------------------------------------------------------------- fixtures --

export const ACCOUNT = "acct_test_merch";

/** `sales.open` is read on every call, so a test can switch new sales off mid-flow. */
export function deps(
  db: PrismaClient,
  stripe: FakeStripe,
  clock: { t: Date },
  payee: { chargesEnabled: boolean } = { chargesEnabled: true },
  sales: { open: boolean } = { open: true }
): MerchDeps {
  return {
    db,
    stripe,
    now: () => new Date(clock.t),
    resolvePayee: async () => ({ accountId: ACCOUNT, chargesEnabled: payee.chargesEnabled }),
    baseUrl: "https://daali.test",
    ipSalt: "test-salt",
    salesOpen: () => sales.open,
  };
}

export async function seedListing(
  db: PrismaClient,
  opts: { owner?: string; paid?: boolean; stock?: number | null; redirect?: string | null; perOrderLimit?: number } = {}
) {
  const owner = opts.owner ?? "user-" + randomUUID();
  const paid = opts.paid ?? true;
  const listing = await db.daaliMerchListing.create({
    data: {
      ownerUserId: owner,
      slug: "t-" + randomUUID().slice(0, 12),
      title: "Wizards Dance Team",
      status: "OPEN",
      closesAt: new Date(Date.now() + 30 * 864e5),
      redirectUrl: opts.redirect === undefined ? "https://www.nba.com/wizards/tickets" : opts.redirect,
      redirectVerifiedAt: opts.redirect === null ? null : new Date(),
      taxHandling: paid ? "INCLUDED_ORGANIZER_REMITS" : null,
      taxConfirmedAt: paid ? new Date() : null,
      items: {
        create: {
          name: "Team T-shirt",
          priceMode: paid ? "PAID" : "FREE",
          netCents: paid ? 4000 : null,
          perOrderLimit: opts.perOrderLimit ?? 10,
          variants: { create: [{ label: "M", sort: 0, stockLimit: opts.stock === undefined ? null : opts.stock }, { label: "L", sort: 1 }] },
        },
      },
      fulfillmentOptions: { create: { label: "Pick up at the game" } },
    },
    include: { items: { include: { variants: { orderBy: { sort: "asc" } } } }, fulfillmentOptions: true },
  });
  return {
    owner,
    listing,
    slug: listing.slug!,
    m: listing.items[0].variants[0].id,
    l: listing.items[0].variants[1].id,
    pickup: listing.fulfillmentOptions[0].id,
  };
}

let seq = 0;
export function orderInput(f: { slug: string; pickup: string }, lines: { variantId: string; quantity: number }[], over: Partial<{ email: string; ip: string; key: string }> = {}) {
  seq++;
  return {
    slug: f.slug,
    idempotencyKey: over.key ?? "k" + randomUUID().replace(/-/g, ""),
    buyerName: "Pat Supporter",
    buyerEmail: over.email ?? `buyer${seq}-${randomUUID().slice(0, 6)}@example.com`,
    buyerPhone: "555-0100",
    fulfillmentOptionId: f.pickup,
    answers: {},
    lines,
    ip: over.ip ?? `10.0.${seq % 250}.${(seq * 7) % 250}`,
  };
}
