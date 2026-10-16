import { notFound, redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { merchEnabled, resolveMerchPayee } from "@/domain/merch/runtime";
import { merchOwnerId } from "@/domain/merch/host-auth";
import ListingEditor, { type EditorInitial } from "../listing-editor";

export const dynamic = "force-dynamic";

export default async function EditMerchSalePage({ params }: { params: Promise<{ id: string }> }) {
  if (!merchEnabled()) notFound();
  const owner = await merchOwnerId();
  if (!owner) redirect("/login");
  const { id } = await params;
  const l = await prisma.daaliMerchListing.findFirst({
    where: { id, ownerUserId: owner },
    include: {
      items: { where: { active: true }, orderBy: { sort: "asc" }, include: { variants: { where: { active: true }, orderBy: { sort: "asc" } } } },
      fulfillmentOptions: { where: { active: true }, orderBy: { sort: "asc" } },
    },
  });
  if (!l) notFound();
  const payee = await resolveMerchPayee(owner);

  const initial: EditorInitial = {
    id: l.id,
    status: l.status,
    title: l.title,
    description: l.description ?? "",
    slug: l.slug ?? "",
    // ISO; the editor converts to the host's own wall clock in the browser (the server runs in UTC).
    closesAt: l.closesAt ? l.closesAt.toISOString() : "",
    redirectUrl: l.redirectUrl ?? "",
    redirectVerified: !!l.redirectVerifiedAt,
    questions: (Array.isArray(l.questions) ? (l.questions as { label: string; required: boolean }[]) : []).map((q) => ({ label: q.label, required: !!q.required })),
    items: l.items.map((i) => ({
      id: i.id,
      name: i.name,
      description: i.description ?? "",
      imageUrl: i.imageUrl ?? "",
      priceMode: i.priceMode,
      net: i.netCents ? (i.netCents / 100).toFixed(2) : "",
      perOrderLimit: String(i.perOrderLimit),
      variants: i.variants.map((v) => ({ id: v.id, label: v.label, stockLimit: v.stockLimit === null ? "" : String(v.stockLimit) })),
    })),
    fulfillmentOptions: l.fulfillmentOptions.map((f) => ({ id: f.id, label: f.label, kind: f.kind })),
    taxHandling: l.taxHandling ?? "",
    taxConfirmed: !!l.taxConfirmedAt,
  };
  return <ListingEditor initial={initial} paymentsReady={!!payee?.chargesEnabled} />;
}
