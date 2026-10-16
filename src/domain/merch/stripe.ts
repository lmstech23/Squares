// The only Stripe surface the merch domain uses. Real calls go through
// `stripeMerchGateway`; tests pass a stub with the same shape.
//
// Every call is made AS THE ORGANIZER'S CONNECTED ACCOUNT (direct charges),
// the same way Board checkout takes money today.

import Stripe from "stripe";

export type CheckoutParams = {
  currency: "usd";
  lines: { name: string; unitAmountCents: number; quantity: number }[];
  expiresAtUnix: number;
  successUrl: string;
  cancelUrl: string;
  customerEmail: string;
  orderId: string;
};

export type SessionView = {
  id: string;
  url: string | null;
  status: "open" | "complete" | "expired" | null;
  paymentStatus: "paid" | "unpaid" | "no_payment_required";
  amountTotal: number | null;
  currency: string | null;
  clientReferenceId: string | null;
  paymentIntentId: string | null;
  metadataOrderId: string | null;
};

/** How a Stripe failure must be handled (spec §5.7). */
export type StripeFailureKind = "definite" | "ambiguous";

export class MerchStripeError extends Error {
  readonly kind: StripeFailureKind;
  constructor(kind: StripeFailureKind, message: string) {
    super(message);
    this.name = "MerchStripeError";
    this.kind = kind;
  }
}

export interface MerchStripeGateway {
  createCheckoutSession(params: CheckoutParams, account: string, idempotencyKey: string): Promise<SessionView>;
  retrieveCheckoutSession(sessionId: string, account: string): Promise<SessionView>;
  expireCheckoutSession(sessionId: string, account: string): Promise<SessionView>;
  /** Actual Stripe fee on the payment, from its balance transaction, or null if not available yet. */
  paymentFeeCents(paymentIntentId: string, account: string): Promise<number | null>;
}

/**
 * Classify a thrown Stripe error. Stripe executed nothing on a 4xx other than
 * 409 (concurrent idempotent request) and 429 (rate limit), so those are
 * definite failures. Connection errors, timeouts, 5xx, 409 and 429 may or may
 * not have executed, or are worth retrying with the same key: ambiguous.
 */
export function classifyStripeError(e: unknown): StripeFailureKind {
  const err = e as { type?: string; statusCode?: number };
  if (err?.type === "StripeConnectionError") return "ambiguous";
  const code = err?.statusCode;
  if (typeof code === "number") {
    if (code === 409 || code === 429) return "ambiguous";
    if (code >= 400 && code < 500) return "definite";
    return "ambiguous";
  }
  return "ambiguous";
}

export function sessionView(s: Stripe.Checkout.Session): SessionView {
  const pi = s.payment_intent;
  return {
    id: s.id,
    url: s.url ?? null,
    status: (s.status as SessionView["status"]) ?? null,
    paymentStatus: s.payment_status as SessionView["paymentStatus"],
    amountTotal: s.amount_total ?? null,
    currency: s.currency ?? null,
    clientReferenceId: s.client_reference_id ?? null,
    paymentIntentId: typeof pi === "string" ? pi : pi?.id ?? null,
    metadataOrderId: s.metadata?.order_id ?? null,
  };
}

export function stripeMerchGateway(stripe: Stripe): MerchStripeGateway {
  const wrap = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      throw new MerchStripeError(classifyStripeError(e), (e as Error)?.message ?? "Stripe error");
    }
  };
  return {
    createCheckoutSession: (p, account, idempotencyKey) =>
      wrap(async () =>
        sessionView(
          await stripe.checkout.sessions.create(
            {
              mode: "payment",
              line_items: p.lines.map((l) => ({
                price_data: { currency: p.currency, unit_amount: l.unitAmountCents, product_data: { name: l.name } },
                quantity: l.quantity,
              })),
              payment_method_types: ["card"],
              customer_email: p.customerEmail,
              client_reference_id: p.orderId,
              // Never squareId / squareIds / type: the Board webhook keys on those.
              metadata: { daali_kind: "merch_order", order_id: p.orderId },
              payment_intent_data: { metadata: { daali_kind: "merch_order", order_id: p.orderId } },
              expires_at: p.expiresAtUnix,
              success_url: p.successUrl,
              cancel_url: p.cancelUrl,
            },
            { stripeAccount: account, idempotencyKey }
          )
        )
      ),
    retrieveCheckoutSession: (id, account) =>
      wrap(async () => sessionView(await stripe.checkout.sessions.retrieve(id, {}, { stripeAccount: account }))),
    expireCheckoutSession: (id, account) =>
      wrap(async () => {
        try {
          return sessionView(await stripe.checkout.sessions.expire(id, {}, { stripeAccount: account }));
        } catch (e) {
          // Already expired or completed: report the current state instead.
          if ((e as { statusCode?: number })?.statusCode === 400) {
            return sessionView(await stripe.checkout.sessions.retrieve(id, {}, { stripeAccount: account }));
          }
          throw e;
        }
      }),
    paymentFeeCents: (piId, account) =>
      wrap(async () => {
        const pi = await stripe.paymentIntents.retrieve(
          piId,
          { expand: ["latest_charge.balance_transaction"] },
          { stripeAccount: account }
        );
        const charge = pi.latest_charge as Stripe.Charge | null;
        const bt = charge?.balance_transaction as Stripe.BalanceTransaction | null | undefined;
        return bt && typeof bt === "object" ? bt.fee : null;
      }),
  };
}
