// Order page — /merch/order/[token]. The supporter's record of the order and
// the backup after-order link (spec §5.5). With ?confirming=1 it polls until
// Stripe confirms payment, then navigates automatically (spec §5.4 step 4).

import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { merchEnabled } from "@/domain/merch/runtime";
import Confirming from "./confirming";

export const dynamic = "force-dynamic";
export const metadata = { referrer: "no-referrer" as const };

const money = (c: number) => "$" + (c / 100).toFixed(2);

export default async function OrderPage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ confirming?: string }> }) {
  if (!merchEnabled()) notFound();
  const { token } = await params;
  const { confirming } = await searchParams;
  if (token === "not-found") return <Shell><h1 className="text-xl font-bold">Order not found</h1><p className="text-sm text-gray-300">If you paid, your receipt email has a link to your order.</p></Shell>;

  const order = await prisma.daaliMerchOrder.findUnique({
    where: { publicToken: token },
    include: { lines: true, listing: true, fulfillmentOption: true },
  });
  if (!order) notFound();

  if (order.status === "PENDING_PAYMENT" && confirming === "1") {
    return <Shell><Confirming token={token} /></Shell>;
  }

  const paid = ["PAID", "PARTIALLY_REFUNDED", "REFUNDED"].includes(order.status);
  const free = order.status === "CONFIRMED_FREE";
  const heading = paid ? "Your order is confirmed" : free ? "Your reservation is confirmed" : order.status === "PENDING_PAYMENT" ? "Payment not finished" : "This order wasn't completed";

  return (
    <Shell>
      <p className="text-sm text-gray-400">{order.listing.title}</p>
      <h1 className="text-2xl font-bold">{heading}</h1>
      {paid || free ? <p className="text-sm text-gray-300">A receipt is on its way to {order.buyerEmail}.</p> : <p className="text-sm text-gray-300">Nothing was charged for this order.</p>}
      <div className="rounded-xl border border-gray-800 bg-gray-900 p-3.5 text-sm flex flex-col gap-1.5">
        {order.lines.map((l) => <div key={l.id} className="flex justify-between"><span>{l.itemName} · {l.variantLabel}</span><span>× {l.quantity}</span></div>)}
        <div className="flex justify-between border-t border-gray-800 pt-2 mt-1 font-semibold"><span>{paid ? "Paid" : "Total"}</span><span>{order.totalCents === 0 ? "Free" : money(order.totalCents)}</span></div>
        {order.refundedCents > 0 ? <div className="flex justify-between text-gray-400"><span>Refunded</span><span>{money(order.refundedCents)}</span></div> : null}
        {order.fulfillmentOption ? <div className="text-gray-400 mt-1">{order.fulfillmentOption.kind === "SHIP" ? "Delivery" : "Pickup"}: {order.fulfillmentOption.label}</div> : null}
      </div>
      {(paid || free) && order.redirectSnapshotUrl ? (
        <a href={order.redirectSnapshotUrl} rel="noreferrer noopener" className="h-12 rounded-xl bg-white text-gray-950 font-semibold flex items-center justify-center">
          Continue to {new URL(order.redirectSnapshotUrl).hostname.replace(/^www\./, "")}
        </a>
      ) : null}
      {order.status !== "PENDING_PAYMENT" && !paid && !free && order.listing.slug ? <a href={`/merch/${order.listing.slug}`} className="text-sm text-green-300">Start a new order</a> : null}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen bg-gray-950 text-white">
      <div className="mx-auto max-w-md px-5 py-10 flex flex-col gap-4">{children}</div>
    </main>
  );
}
