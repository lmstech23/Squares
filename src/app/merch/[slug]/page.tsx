// Public merch sale page — https://beta.daali.app/merch/[slug] (spec D7) (mockups: "Supporter: pick
// sizes", "Supporter: your details").

import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { prisma } from "@/lib/prisma";
import { displayUnitPrice } from "@/domain/merch/listings";
import { remainingStock } from "@/domain/merch/orders";
import { merchSalesOpen } from "@/domain/merch/runtime";
import SaleClient, { type SaleView } from "./sale-client";

export const dynamic = "force-dynamic";

async function load(slug: string) {
  return prisma.daaliMerchListing.findUnique({
    where: { slug },
    include: {
      items: { where: { active: true }, orderBy: { sort: "asc" }, include: { variants: { where: { active: true }, orderBy: { sort: "asc" } } } },
      fulfillmentOptions: { where: { active: true }, orderBy: { sort: "asc" } },
    },
  });
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  if (!merchSalesOpen()) return {};
  const l = await load((await params).slug);
  return l && l.status !== "DRAFT" ? { title: l.title, description: l.description ?? undefined } : {};
}

export default async function MerchSalePage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ cancelled?: string }> }) {
  if (!merchSalesOpen()) notFound();
  const { slug } = await params;
  const { cancelled } = await searchParams;
  const listing = await load(slug);
  if (!listing || listing.status === "DRAFT") notFound();

  const now = new Date();
  const closed = listing.status === "CLOSED" || (!!listing.closesAt && listing.closesAt <= now);
  const variantIds = listing.items.flatMap((i) => i.variants.map((v) => v.id));
  const remaining = variantIds.length ? await remainingStock(prisma, variantIds, now) : new Map();

  const view: SaleView = {
    slug: listing.slug!,
    title: listing.title,
    description: listing.description,
    closesAt: listing.closesAt?.toISOString() ?? null,
    closed,
    cancelled: cancelled === "1",
    hasAfterLink: !!(listing.redirectUrl && listing.redirectVerifiedAt),
    afterHost: listing.redirectUrl && listing.redirectVerifiedAt ? new URL(listing.redirectUrl).hostname.replace(/^www\./, "") : null,
    questions: Array.isArray(listing.questions) ? (listing.questions as { key: string; label: string; required: boolean }[]) : [],
    fulfillmentOptions: listing.fulfillmentOptions.map((f) => ({ id: f.id, label: f.label })),
    items: listing.items
      .filter((i) => i.variants.length > 0)
      .map((i) => ({
        id: i.id,
        name: i.name,
        description: i.description,
        imageUrl: i.imageUrl,
        unitPriceCents: displayUnitPrice(i),
        perOrderLimit: i.perOrderLimit,
        variants: i.variants.map((v) => {
          const r = remaining.get(v.id);
          return { id: v.id, label: v.label, remaining: r === undefined ? null : r };
        }),
      })),
  };
  return <SaleClient view={view} />;
}
