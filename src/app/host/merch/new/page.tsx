import { notFound, redirect } from "next/navigation";
import { merchEnabled, resolveMerchPayee } from "@/domain/merch/runtime";
import { merchOwnerId } from "@/domain/merch/host-auth";
import ListingEditor from "../listing-editor";

export const dynamic = "force-dynamic";

export default async function NewMerchSalePage() {
  if (!merchEnabled()) notFound();
  const owner = await merchOwnerId();
  if (!owner) redirect("/login");
  const payee = await resolveMerchPayee(owner);
  return <ListingEditor initial={null} paymentsReady={!!payee?.chargesEnabled} />;
}
