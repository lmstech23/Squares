// Receipt outbox — spec §5.8 and §5.8.1.
//
// PENDING → SENDING → SENT, or → FAILED (retryable with backoff) → … → FAILED (final).
// One worker per row (conditional claim + fencing token). Every attempt for a
// row sends the same payload with the same provider idempotency key, so retries
// inside the provider's 24-hour window cannot produce a second email. Outside
// that window nothing is sent automatically (§5.8.1): exactly-once is NOT claimed.

import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { formatCents } from "./pricing.ts";

export const BACKOFF_MINUTES = [1, 5, 15, 60, 240];
export const MAX_ATTEMPTS = 6;
export const LEASE_MS = 2 * 60_000;
export const AUTO_SEND_WINDOW_MS = 23 * 60 * 60_000; // stay inside Resend's 24h idempotency window

export type OutgoingEmail = { to: string; subject: string; html: string; idempotencyKey: string };

/** Thrown by a sender. `ambiguous`: the provider may have accepted it (timeout, dropped connection). */
export class EmailSendError extends Error {
  readonly retryable: boolean;
  readonly ambiguous: boolean;
  constructor(message: string, opts: { retryable: boolean; ambiguous: boolean }) {
    super(message);
    this.name = "EmailSendError";
    this.retryable = opts.retryable;
    this.ambiguous = opts.ambiguous;
  }
}

export interface EmailSender {
  send(email: OutgoingEmail): Promise<{ id: string }>;
}

export type OutboxDeps = { db: PrismaClient; sender: EmailSender; now: () => Date; baseUrl: string };

type Claimed = { id: string; order_id: string; kind: string; attempts: number; lock_token: string; idempotency_suffix: number; first_attempt_at: Date | null; last_error: string | null };

/** Prefix kept on last_error once any attempt for the row was ambiguous; sticky until a host resend. */
const AMBIGUOUS_PREFIX = "ambiguous: ";

/** Atomically take one due row. Returns null if another worker has it or it isn't due. */
export async function claim(db: PrismaClient, id: string, now: Date): Promise<Claimed | null> {
  const token = randomUUID();
  const staleBefore = new Date(now.getTime() - LEASE_MS);
  const rows = await db.$queryRaw<Claimed[]>`
    UPDATE daali_merch_notifications
       SET status = 'SENDING', attempts = attempts + 1, locked_at = ${now}, lock_token = ${token},
           first_attempt_at = COALESCE(first_attempt_at, ${now})
     WHERE id = ${id}::uuid
       AND attempts < ${MAX_ATTEMPTS}
       AND (
             status = 'PENDING'
          OR (status = 'FAILED'  AND next_attempt_at <= ${now})
          OR (status = 'SENDING' AND locked_at < ${staleBefore})
       )
    RETURNING id, order_id, kind, attempts, lock_token, idempotency_suffix, first_attempt_at, last_error`;
  return rows[0] ?? null;
}

export function idempotencyKeyFor(row: { kind: string; order_id: string; idempotency_suffix: number }) {
  return `merch-${row.kind.toLowerCase()}-${row.order_id}-${row.idempotency_suffix}`;
}

/** Send one claimed row and settle it, fenced on its lock token. */
export async function sendClaimed(row: Claimed, deps: OutboxDeps): Promise<"sent" | "failed" | "final" | "lost_lease"> {
  const { db } = deps;
  const now = deps.now();

  // §5.8.1: never auto-send outside the provider's idempotency window.
  if (row.first_attempt_at && now.getTime() - row.first_attempt_at.getTime() > AUTO_SEND_WINDOW_MS) {
    const r = await db.$executeRaw`
      UPDATE daali_merch_notifications
         SET status = 'FAILED', attempts = ${MAX_ATTEMPTS}, locked_at = NULL, lock_token = NULL,
             last_error = 'delivery_unknown'
       WHERE id = ${row.id}::uuid AND lock_token = ${row.lock_token}`;
    return r === 1 ? "final" : "lost_lease";
  }

  const email = await buildEmail(db, row, deps.baseUrl);
  try {
    const { id: providerId } = await deps.sender.send({ ...email, idempotencyKey: idempotencyKeyFor(row) });
    const r = await db.$executeRaw`
      UPDATE daali_merch_notifications
         SET status = 'SENT', sent_at = ${deps.now()}, provider_message_id = ${providerId},
             locked_at = NULL, lock_token = NULL, last_error = NULL
       WHERE id = ${row.id}::uuid AND lock_token = ${row.lock_token}`;
    return r === 1 ? "sent" : "lost_lease";
  } catch (e) {
    const err = e instanceof EmailSendError ? e : new EmailSendError((e as Error)?.message ?? "send failed", { retryable: true, ambiguous: true });
    const final = !err.retryable || row.attempts >= MAX_ATTEMPTS;
    const delay = BACKOFF_MINUTES[Math.min(row.attempts - 1, BACKOFF_MINUTES.length - 1)] * 60_000;
    const next = new Date(deps.now().getTime() + delay);
    // A final failure after ANY ambiguous attempt may still have been delivered: say so (§5.8.1).
    const everAmbiguous = err.ambiguous || !!row.last_error?.startsWith(AMBIGUOUS_PREFIX);
    const lastError = final && everAmbiguous
      ? "delivery_unknown"
      : (everAmbiguous ? AMBIGUOUS_PREFIX : "") + err.message.slice(0, 480);
    const r = await db.$executeRaw`
      UPDATE daali_merch_notifications
         SET status = 'FAILED', next_attempt_at = ${next}, locked_at = NULL, lock_token = NULL,
             last_error = ${lastError},
             attempts = CASE WHEN ${final} THEN ${MAX_ATTEMPTS} ELSE attempts END
       WHERE id = ${row.id}::uuid AND lock_token = ${row.lock_token}`;
    if (r !== 1) return "lost_lease";
    return final ? "final" : "failed";
  }
}

/** Claim and send every due row, bounded. Used right after a response (`after()`) and by the cron. */
export async function processOutbox(deps: OutboxDeps, opts: { limit?: number; orderId?: string } = {}) {
  const now = deps.now();
  const staleBefore = new Date(now.getTime() - LEASE_MS);
  const due = await deps.db.daaliMerchNotification.findMany({
    where: {
      ...(opts.orderId ? { orderId: opts.orderId } : {}),
      attempts: { lt: MAX_ATTEMPTS },
      OR: [
        { status: "PENDING" },
        { status: "FAILED", nextAttemptAt: { lte: now } },
        { status: "SENDING", lockedAt: { lt: staleBefore } },
      ],
    },
    select: { id: true },
    take: opts.limit ?? 25,
    orderBy: { nextAttemptAt: "asc" },
  });
  const results: string[] = [];
  for (const { id } of due) {
    const row = await claim(deps.db, id, deps.now());
    if (!row) continue;
    results.push(await sendClaimed(row, deps));
  }
  return results;
}

/** Host "Resend receipt": a deliberate, visible second email with a new idempotency suffix. */
export async function hostResend(orderId: string, ownerUserId: string, db: PrismaClient, now: Date): Promise<boolean> {
  const r = await db.$executeRaw`
    UPDATE daali_merch_notifications n
       SET status = 'PENDING', attempts = 0, first_attempt_at = NULL, next_attempt_at = ${now},
           idempotency_suffix = idempotency_suffix + 1, locked_at = NULL, lock_token = NULL, last_error = NULL,
           sent_at = NULL
      FROM daali_merch_orders o JOIN daali_merch_listings l ON l.id = o.listing_id
     WHERE n.order_id = o.id AND o.id = ${orderId}::uuid AND l.owner_user_id = ${ownerUserId}
       AND n.status IN ('FAILED', 'SENT')`;
  return r >= 1;
}

// ------------------------------------------------------------------ email --

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

async function buildEmail(db: PrismaClient, row: Claimed, baseUrl: string): Promise<Omit<OutgoingEmail, "idempotencyKey">> {
  const order = await db.daaliMerchOrder.findUniqueOrThrow({
    where: { id: row.order_id },
    include: { lines: true, listing: true, fulfillmentOption: true },
  });
  const free = row.kind === "FREE_CONFIRMATION";
  const first = order.buyerName.split(/\s+/)[0] ?? order.buyerName;
  const lines = order.lines
    .map((l) => `<tr><td style="padding:4px 0">${esc(l.itemName)} · ${esc(l.variantLabel)}</td><td style="padding:4px 0;text-align:right">× ${l.quantity}</td></tr>`)
    .join("");
  const orderUrl = `${baseUrl}/merch/order/${order.publicToken}`;
  const after = order.redirectSnapshotUrl
    ? `<p style="margin:16px 0"><a href="${esc(order.redirectSnapshotUrl)}" style="display:inline-block;background:#111827;color:#fff;padding:12px 18px;border-radius:8px;text-decoration:none">Continue to ${esc(new URL(order.redirectSnapshotUrl).hostname.replace(/^www\./, ""))}</a></p>
       <p style="color:#4b5563;font-size:12px">That page is run by someone else, not by Daali or the organizer.</p>`
    : "";
  const pickup = order.fulfillmentOption ? `<p><strong>${order.fulfillmentOption.kind === "SHIP" ? "Delivery" : "Pickup"}:</strong> ${esc(order.fulfillmentOption.label)}</p>` : "";
  const html = `<div style="font-family:system-ui,sans-serif;max-width:520px;margin:auto;color:#111827">
  <p style="color:#4b5563">${esc(order.listing.title)}</p>
  <h1 style="font-size:20px">Thanks, ${esc(first)}. ${free ? "Your reservation is confirmed." : "Your order is confirmed."}</h1>
  <table style="width:100%;border-top:1px solid #e5e7eb;border-bottom:1px solid #e5e7eb;margin:12px 0">${lines}
  <tr><td style="padding:6px 0;font-weight:600">${free ? "Total" : "Paid"}</td><td style="padding:6px 0;text-align:right;font-weight:600">${free ? "Free" : formatCents(order.totalCents)}</td></tr></table>
  ${pickup}
  ${after}
  <p><a href="${esc(orderUrl)}">View your order</a></p>
  <p style="color:#4b5563;font-size:12px">Questions about your order? Contact the organizer.</p></div>`;
  return { to: order.buyerEmail, subject: `${free ? "Reservation" : "Receipt"}: ${order.listing.title}`, html };
}
