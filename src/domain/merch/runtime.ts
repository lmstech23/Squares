// Production wiring for the merch domain: real Prisma, Stripe, Resend.
// Tests never import this file; they build MerchDeps / OutboxDeps from stubs.
//
// resolveMerchPayee is the ONLY merch code that reads `hosts` (decision D2).
// When the new payout architecture lands, only this function changes.

import { Resend } from "resend";
import { prisma } from "@/lib/prisma";
import { stripe } from "@/lib/stripe";
import { stripeMerchGateway } from "./stripe.ts";
import type { MerchDeps, Payee } from "./orders.ts";
import { EmailSendError, type EmailSender, type OutboxDeps } from "./notifications.ts";

export function merchEnabled(): boolean {
  return process.env.MERCH_ENABLED === "true";
}

export function merchBaseUrl(): string {
  const u = process.env.NEXT_PUBLIC_URL;
  if (!u) throw new Error("NEXT_PUBLIC_URL is not set");
  return u.replace(/\/+$/, "");
}

export async function resolveMerchPayee(ownerUserId: string): Promise<Payee | null> {
  const host = await prisma.host.findUnique({
    where: { supabaseUserId: ownerUserId },
    select: { stripeAccountId: true, stripeChargesEnabled: true },
  });
  if (!host?.stripeAccountId) return null;
  return { accountId: host.stripeAccountId, chargesEnabled: !!host.stripeChargesEnabled };
}

export function merchDeps(): MerchDeps {
  const salt = process.env.MERCH_IP_HASH_SALT;
  if (!salt) throw new Error("MERCH_IP_HASH_SALT is not set");
  return {
    db: prisma,
    stripe: stripeMerchGateway(stripe),
    now: () => new Date(),
    resolvePayee: resolveMerchPayee,
    baseUrl: merchBaseUrl(),
    ipSalt: salt,
  };
}

export function resendSender(): EmailSender {
  const key = process.env.RESEND_API_KEY;
  return {
    async send(email) {
      if (!key) throw new EmailSendError("RESEND_API_KEY is not configured", { retryable: true, ambiguous: false });
      const resend = new Resend(key);
      let res;
      try {
        res = await resend.emails.send(
          { from: "Daali <notifications@daali.app>", to: email.to, subject: email.subject, html: email.html },
          { idempotencyKey: email.idempotencyKey }
        );
      } catch (e) {
        // Network failure or timeout: Resend may have accepted it.
        throw new EmailSendError((e as Error)?.message ?? "network error", { retryable: true, ambiguous: true });
      }
      if (res.error) {
        const name = (res.error as { name?: string }).name ?? "";
        const status = (res.error as { statusCode?: number }).statusCode ?? 0;
        // 409 concurrent_idempotent_requests: another attempt is in flight — retry later.
        if (name === "concurrent_idempotent_requests" || status === 429 || status >= 500 || status === 0) {
          throw new EmailSendError(`${name || status}: ${res.error.message}`, { retryable: true, ambiguous: status === 0 || status >= 500 });
        }
        throw new EmailSendError(`${name || status}: ${res.error.message}`, { retryable: false, ambiguous: false });
      }
      return { id: res.data?.id ?? "unknown" };
    },
  };
}

export function outboxDeps(): OutboxDeps {
  return { db: prisma, sender: resendSender(), now: () => new Date(), baseUrl: merchBaseUrl() };
}
