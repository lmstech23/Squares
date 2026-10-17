import { notFound, redirect } from "next/navigation";
import { merchPublicPrefix, merchSalesOpen, resolveMerchPayee } from "@/domain/merch/runtime";
import { merchOwnerId } from "@/domain/merch/host-auth";
import ListingEditor from "../listing-editor";

export const dynamic = "force-dynamic";

export default async function NewMerchSalePage() {
  if (!merchSalesOpen()) notFound();
  const owner = await merchOwnerId();
  if (!owner) redirect("/login");
  const payee = await resolveMerchPayee(owner);
  return <ListingEditor initial={null} paymentsReady={!!payee?.chargesEnabled} publicBase={merchPublicPrefix()} />;
}
