// Host orders CSV — one row per confirmed order, one column per size.

import type { PrismaClient } from "@prisma/client";
import { TAX_CHOICES, type TaxChoice } from "./listings.ts";

const SHOWN = ["PAID", "CONFIRMED_FREE", "PARTIALLY_REFUNDED", "REFUNDED"] as const;

function cell(v: unknown): string {
  let s = v === null || v === undefined ? "" : String(v);
  // Neutralize spreadsheet formulas (CSV injection).
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return `"${s.replace(/"/g, '""')}"`;
}

export async function ordersCsv(listingId: string, ownerUserId: string, db: PrismaClient): Promise<string | null> {
  const listing = await db.daaliMerchListing.findFirst({ where: { id: listingId, ownerUserId } });
  if (!listing) return null;
  const orders = await db.daaliMerchOrder.findMany({
    where: { listingId, status: { in: [...SHOWN] } },
    include: { lines: true, fulfillmentOption: true, notifications: true },
    orderBy: { createdAt: "asc" },
  });
  const questions = Array.isArray(listing.questions) ? (listing.questions as { key: string; label: string }[]) : [];

  const sizeCols: string[] = [];
  for (const o of orders) for (const l of o.lines) {
    const k = `${l.itemName} · ${l.variantLabel}`;
    if (!sizeCols.includes(k)) sizeCols.push(k);
  }

  const header = [
    "Order date", "Status", "Name", "Email", "Phone", "Pickup / delivery",
    ...questions.map((q) => q.label),
    ...sizeCols, "Total items", "Paid", "Stripe fee", "You receive", "Refunded", "Handed out", "Receipt",
  ];
  const rows = orders.map((o) => {
    const qty = new Map<string, number>();
    for (const l of o.lines) qty.set(`${l.itemName} · ${l.variantLabel}`, (qty.get(`${l.itemName} · ${l.variantLabel}`) ?? 0) + l.quantity);
    const answers = (o.answers ?? {}) as Record<string, string>;
    const n = o.notifications[0];
    const receipt = !n ? "" : n.status === "SENT" ? "Sent" : n.lastError === "delivery_unknown" ? "May not have been delivered" : n.status === "FAILED" && n.attempts >= 6 ? "Failed" : "Sending";
    return [
      o.createdAt.toISOString(), o.status, o.buyerName, o.buyerEmail, o.buyerPhone ?? "", o.fulfillmentOption?.label ?? "",
      ...questions.map((q) => answers[q.key] ?? ""),
      ...sizeCols.map((c) => qty.get(c) ?? 0),
      o.lines.reduce((a, l) => a + l.quantity, 0),
      (o.totalCents / 100).toFixed(2),
      o.stripeFeeCents === null ? "" : (o.stripeFeeCents / 100).toFixed(2),
      o.stripeFeeCents === null ? "" : ((o.totalCents - o.stripeFeeCents) / 100).toFixed(2),
      (o.refundedCents / 100).toFixed(2),
      o.handedOutAt ? o.handedOutAt.toISOString() : "",
      receipt,
    ];
  });
  const taxLine = listing.taxHandling ? `Sales tax: ${TAX_CHOICES[listing.taxHandling as TaxChoice]}` : "Sales tax: not applicable (free items only)";
  return [cell(listing.title) + "," + cell(taxLine), header.map(cell).join(","), ...rows.map((r) => r.map(cell).join(","))].join("\r\n") + "\r\n";
}
