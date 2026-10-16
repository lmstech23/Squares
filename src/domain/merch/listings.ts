// Host-side listing setup — spec §5.6 and §6 (sales tax).
//
// Items, sizes and pickup options are never deleted once saved: a removed one
// is deactivated, so order history and the CSV keep their meaning.

import type { PrismaClient, Prisma } from "@prisma/client";
import { MerchError } from "./errors.ts";
import { requireText, slugify, validateAfterOrderUrl } from "./validate.ts";
import { priceForNet } from "./pricing.ts";
import type { Payee } from "./orders.ts";

export const TAX_CHOICES = {
  INCLUDED_ORGANIZER_REMITS: "My price includes any sales tax due, and my organization will report and pay it.",
  EXEMPT_CONFIRMED: "My organization has confirmed these sales are exempt from sales tax.",
  NOT_DUE_CONFIRMED: "My organization has confirmed no sales tax is due on these sales.",
} as const;
export type TaxChoice = keyof typeof TAX_CHOICES;

export type ListingInput = {
  title: unknown;
  description?: unknown;
  slug: unknown;
  closesAt?: unknown;
  redirectUrl?: unknown;
  redirectConfirmed?: unknown;
  questions?: { label: unknown; required?: unknown }[];
  items: {
    id?: string;
    name: unknown;
    description?: unknown;
    imageUrl?: unknown;
    priceMode: unknown;
    netCents?: unknown;
    perOrderLimit?: unknown;
    variants: { id?: string; label: unknown; stockLimit?: unknown }[];
  }[];
  fulfillmentOptions?: { id?: string; label: unknown; kind?: unknown }[];
  taxHandling?: unknown;
  taxConfirmed?: unknown;
};

function toInt(v: unknown, field: string, min: number, max: number, optional = false): number | null {
  if (v === null || v === undefined || v === "") {
    if (optional) return null;
    throw new MerchError("INVALID_INPUT", `${field} is required.`);
  }
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new MerchError("INVALID_INPUT", `${field} must be a whole number from ${min} to ${max}.`);
  return n;
}

export async function saveListing(
  ownerUserId: string,
  listingId: string | null,
  input: ListingInput,
  db: PrismaClient,
  now: Date
): Promise<string> {
  const title = requireText(input.title, "Name", 120)!;
  const description = requireText(input.description, "Description", 2000, true);
  const slug = slugify(input.slug);
  let closesAt: Date | null = null;
  if (input.closesAt) {
    const d = new Date(String(input.closesAt));
    if (Number.isNaN(d.getTime())) throw new MerchError("INVALID_INPUT", "Orders-close date isn't valid.");
    closesAt = d;
  }
  const redirectUrl = input.redirectUrl ? validateAfterOrderUrl(input.redirectUrl) : null;

  const questions = (input.questions ?? []).slice(0, 3).map((q, i) => ({
    key: `q${i + 1}`,
    label: requireText(q.label, "Question", 120)!,
    required: q.required === true,
  }));
  if (questions.length > 2) throw new MerchError("INVALID_INPUT", "Up to 2 extra questions.");

  if (!Array.isArray(input.items) || input.items.length === 0) throw new MerchError("INVALID_INPUT", "Add at least one item.");
  if (input.items.length > 10) throw new MerchError("INVALID_INPUT", "Up to 10 items.");
  const items = input.items.map((it, idx) => {
    const priceMode = it.priceMode === "PAID" ? "PAID" : it.priceMode === "FREE" ? "FREE" : null;
    if (!priceMode) throw new MerchError("INVALID_INPUT", "Choose Free or Paid for each item.");
    const netCents = priceMode === "PAID" ? toInt(it.netCents, "Amount you receive", 50, 100000) : null;
    const perOrderLimit = toInt(it.perOrderLimit ?? 10, "Most per order", 1, 100)!;
    if (!Array.isArray(it.variants) || it.variants.length === 0) throw new MerchError("INVALID_INPUT", "Add at least one size or option for each item.");
    if (it.variants.length > 20) throw new MerchError("INVALID_INPUT", "Up to 20 sizes per item.");
    const labels = new Set<string>();
    const variants = it.variants.map((v, vi) => {
      const label = requireText(v.label, "Size", 40)!;
      if (labels.has(label.toLowerCase())) throw new MerchError("INVALID_INPUT", `Size "${label}" is listed twice.`);
      labels.add(label.toLowerCase());
      return { id: v.id, label, sort: vi, stockLimit: toInt(v.stockLimit, "Limit", 0, 100000, true) };
    });
    return {
      id: it.id,
      name: requireText(it.name, "Item name", 120)!,
      description: requireText(it.description, "Item description", 1000, true),
      imageUrl: it.imageUrl ? validateImageUrl(it.imageUrl) : null,
      priceMode,
      netCents,
      perOrderLimit,
      sort: idx,
      variants,
    } as const;
  });
  const fulfillment = (input.fulfillmentOptions ?? []).slice(0, 10).map((f, i) => ({
    id: f.id,
    label: requireText(f.label, "Pickup option", 120)!,
    kind: f.kind === "SHIP" ? ("SHIP" as const) : ("PICKUP" as const),
    sort: i,
  }));

  const tax = input.taxHandling && (input.taxHandling as string) in TAX_CHOICES ? (input.taxHandling as TaxChoice) : null;

  try {
    return await db.$transaction(async (tx) => {
      let current: { id: string; redirectUrl: string | null; redirectVerifiedAt: Date | null; taxHandling: string | null; status: string } | null = null;
      if (listingId) {
        current = await tx.daaliMerchListing.findFirst({ where: { id: listingId, ownerUserId } });
        if (!current) throw new MerchError("NOT_FOUND", "Sale not found.");
      }

      // Any change to the link clears its verification; confirming re-stamps it.
      const linkChanged = !current || current.redirectUrl !== redirectUrl;
      const confirmed = input.redirectConfirmed === true && !!redirectUrl;
      const redirectVerifiedAt = redirectUrl ? (confirmed ? now : linkChanged ? null : current!.redirectVerifiedAt) : null;

      // Tax: recorded only together with the confirmation box (§6).
      const taxData =
        tax && input.taxConfirmed === true
          ? { taxHandling: tax, taxConfirmedAt: now, taxConfirmedBy: ownerUserId }
          : tax && current?.taxHandling === tax
            ? {}
            : { taxHandling: null, taxConfirmedAt: null, taxConfirmedBy: null };

      const data = {
        title,
        description,
        slug,
        closesAt,
        redirectUrl,
        redirectVerifiedAt,
        redirectVerifiedBy: redirectVerifiedAt ? ownerUserId : null,
        questions: questions as Prisma.InputJsonValue,
        updatedAt: now,
        ...taxData,
      };
      const listing = current
        ? await tx.daaliMerchListing.update({ where: { id: current.id }, data })
        : await tx.daaliMerchListing.create({ data: { ...data, ownerUserId } });

      // Items and variants: update by id, create new, deactivate the rest.
      const existingItems = await tx.daaliMerchItem.findMany({ where: { listingId: listing.id }, include: { variants: true } });
      const keptItemIds = new Set<string>();
      for (const it of items) {
        const found = it.id ? existingItems.find((e) => e.id === it.id) : undefined;
        const itemData = {
          name: it.name, description: it.description, imageUrl: it.imageUrl, priceMode: it.priceMode,
          netCents: it.netCents, perOrderLimit: it.perOrderLimit, sort: it.sort, active: true,
        };
        const saved = found
          ? await tx.daaliMerchItem.update({ where: { id: found.id }, data: itemData })
          : await tx.daaliMerchItem.create({ data: { ...itemData, listingId: listing.id } });
        keptItemIds.add(saved.id);
        const existingVariants = found?.variants ?? [];
        const keptVariantIds = new Set<string>();
        for (const v of it.variants) {
          const fv = (v.id && existingVariants.find((e) => e.id === v.id)) || existingVariants.find((e) => e.label === v.label);
          const vData = { label: v.label, sort: v.sort, stockLimit: v.stockLimit, active: true };
          const sv = fv
            ? await tx.daaliMerchVariant.update({ where: { id: fv.id }, data: vData })
            : await tx.daaliMerchVariant.create({ data: { ...vData, itemId: saved.id } });
          keptVariantIds.add(sv.id);
        }
        await tx.daaliMerchVariant.updateMany({ where: { itemId: saved.id, id: { notIn: [...keptVariantIds] } }, data: { active: false } });
      }
      await tx.daaliMerchItem.updateMany({ where: { listingId: listing.id, id: { notIn: [...keptItemIds] } }, data: { active: false } });

      const existingF = await tx.daaliMerchFulfillmentOption.findMany({ where: { listingId: listing.id } });
      const keptF = new Set<string>();
      for (const f of fulfillment) {
        const found = (f.id && existingF.find((e) => e.id === f.id)) || existingF.find((e) => e.label === f.label);
        const fData = { label: f.label, kind: f.kind, sort: f.sort, active: true };
        const s = found
          ? await tx.daaliMerchFulfillmentOption.update({ where: { id: found.id }, data: fData })
          : await tx.daaliMerchFulfillmentOption.create({ data: { ...fData, listingId: listing.id } });
        keptF.add(s.id);
      }
      await tx.daaliMerchFulfillmentOption.updateMany({ where: { listingId: listing.id, id: { notIn: [...keptF] } }, data: { active: false } });

      return listing.id;
    });
  } catch (e) {
    if ((e as { code?: string })?.code === "P2002") throw new MerchError("CONFLICT", "That link is already taken. Choose another.");
    throw e;
  }
}

function validateImageUrl(raw: unknown): string {
  const s = String(raw).trim();
  try {
    const u = new URL(s);
    if (u.protocol !== "https:") throw new Error();
    return u.toString();
  } catch {
    throw new MerchError("INVALID_INPUT", "Item photo must be an https link.");
  }
}

/** Publish: every rule a supporter-facing sale must satisfy. */
export async function publishListing(
  ownerUserId: string,
  listingId: string,
  db: PrismaClient,
  resolvePayee: (ownerUserId: string) => Promise<Payee | null>,
  now: Date
): Promise<void> {
  const l = await db.daaliMerchListing.findFirst({
    where: { id: listingId, ownerUserId },
    include: { items: { where: { active: true }, include: { variants: { where: { active: true } } } } },
  });
  if (!l) throw new MerchError("NOT_FOUND", "Sale not found.");
  const sellable = l.items.filter((i) => i.variants.length > 0);
  if (sellable.length === 0) throw new MerchError("INVALID_INPUT", "Add at least one item with a size before publishing.");
  if (l.redirectUrl && !l.redirectVerifiedAt) {
    throw new MerchError("INVALID_INPUT", "Open the after-order link and confirm it's the right page before publishing.");
  }
  if (l.closesAt && l.closesAt <= now) throw new MerchError("INVALID_INPUT", "The orders-close date is in the past.");
  if (sellable.some((i) => i.priceMode === "PAID")) {
    if (!l.taxHandling || !l.taxConfirmedAt) {
      throw new MerchError("INVALID_INPUT", "Choose how sales tax will be handled and confirm it before publishing paid items.");
    }
    const payee = await resolvePayee(ownerUserId);
    if (!payee || !payee.chargesEnabled) {
      throw new MerchError("PAYMENTS_NOT_READY", "Finish Stripe setup before publishing paid items. Free items don't need it.");
    }
  }
  await db.daaliMerchListing.update({ where: { id: l.id }, data: { status: "OPEN", updatedAt: now } });
}

export async function closeListing(ownerUserId: string, listingId: string, db: PrismaClient, now: Date) {
  const r = await db.daaliMerchListing.updateMany({ where: { id: listingId, ownerUserId }, data: { status: "CLOSED", updatedAt: now } });
  if (r.count !== 1) throw new MerchError("NOT_FOUND", "Sale not found.");
}

/** What a supporter pays per unit, for display (same function the order uses). */
export function displayUnitPrice(item: { priceMode: string; netCents: number | null; perOrderLimit: number }): number {
  return item.priceMode === "PAID" && item.netCents ? priceForNet(item.netCents, item.perOrderLimit) : 0;
}
