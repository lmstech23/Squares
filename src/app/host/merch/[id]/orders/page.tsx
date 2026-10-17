// Host orders — /host/merch/[id]/orders (mockup "Host: orders").

import { notFound, redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { merchOwnerId } from "@/domain/merch/host-auth";
import OrderActions from "./order-actions";

export const dynamic = "force-dynamic";

const money = (c: number) => "$" + (c / 100).toFixed(2);
const COUNTED = ["PAID", "PARTIALLY_REFUNDED", "CONFIRMED_FREE"] as const;

function receiptLabel(n: { status: string; lastError: string | null } | undefined): { text: string; warn: boolean } {
  if (!n) return { text: "—", warn: false };
  if (n.status === "SENT") return { text: "Sent", warn: false };
  if (n.status === "PENDING" || n.status === "SENDING") return { text: "Sending", warn: false };
  if (n.lastError?.startsWith("delivery_unknown")) return { text: "May not have been delivered", warn: true };
  return { text: "Not delivered yet", warn: true };
}

export default async function MerchOrdersPage({ params }: { params: Promise<{ id: string }> }) {
  const owner = await merchOwnerId();
  if (!owner) redirect("/login");
  const { id } = await params;
  const listing = await prisma.daaliMerchListing.findFirst({ where: { id, ownerUserId: owner } });
  if (!listing) notFound();

  const orders = await prisma.daaliMerchOrder.findMany({
    where: { listingId: id, status: { in: ["PAID", "PARTIALLY_REFUNDED", "REFUNDED", "CONFIRMED_FREE", "CANCELLED"] } },
    include: { lines: true, fulfillmentOption: true, notifications: true },
    orderBy: { createdAt: "desc" },
  });
  // CANCELLED orders that never confirmed (checkout failures) are not shown.
  const shown = orders.filter((o) => o.status !== "CANCELLED" || o.confirmedAt);
  const counted = shown.filter((o) => (COUNTED as readonly string[]).includes(o.status));

  const bySize = new Map<string, number>();
  for (const o of counted) for (const l of o.lines) bySize.set(`${l.itemName} · ${l.variantLabel}`, (bySize.get(`${l.itemName} · ${l.variantLabel}`) ?? 0) + l.quantity);
  const units = [...bySize.values()].reduce((a, b) => a + b, 0);
  const collected = shown.reduce((a, o) => a + (o.status === "CONFIRMED_FREE" || o.status === "CANCELLED" ? 0 : o.totalCents - o.refundedCents), 0);
  const fees = shown.reduce((a, o) => a + (o.stripeFeeCents ?? 0), 0);
  const flagged = shown.filter((o) => o.oversellFlag).length;

  return (
    <main className="min-h-screen bg-gray-950 text-white">
      <div className="mx-auto max-w-5xl px-5 py-8 flex flex-col gap-6">
        <div className="flex flex-wrap justify-between items-center gap-3">
          <div>
            <a href={`/host/merch/${id}`} className="text-sm text-gray-400">← {listing.title}</a>
            <h1 className="text-2xl font-bold">Orders</h1>
          </div>
          <a href={`/api/host/merch/${id}/orders.csv`} className="h-11 px-4 rounded-lg border border-gray-700 flex items-center text-sm">Download CSV</a>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Stat label="Orders" value={String(counted.length)} />
          <Stat label="Items" value={String(units)} />
          <Stat label="Collected" value={money(collected)} />
          <Stat label="Stripe fees" value={money(fees)} />
        </div>

        {flagged ? (
          <div className="rounded-lg border border-yellow-900/50 bg-yellow-950/20 p-3 text-sm text-yellow-200">
            {flagged} order{flagged === 1 ? " was" : "s were"} paid after the hold ran out and may be over your size limit. Check stock before handing out.
          </div>
        ) : null}

        {bySize.size ? (
          <section className="rounded-2xl border border-gray-800 bg-gray-900 p-5">
            <h2 className="text-lg font-semibold mb-3">By size</h2>
            <div className="flex flex-wrap gap-2">
              {[...bySize.entries()].map(([k, v]) => <span key={k} className="rounded-lg border border-gray-700 px-3 py-1.5 text-sm">{k} <strong>{v}</strong></span>)}
            </div>
          </section>
        ) : null}

        <section className="rounded-2xl border border-gray-800 bg-gray-900 overflow-x-auto">
          {shown.length === 0 ? <p className="p-5 text-sm text-gray-400">No orders yet.</p> : (
            <table className="w-full text-sm">
              <thead className="text-left text-gray-400">
                <tr><th className="p-3">Buyer</th><th className="p-3">Items</th><th className="p-3">Pickup</th><th className="p-3">Paid</th><th className="p-3">Receipt</th><th className="p-3">Status</th><th className="p-3"></th></tr>
              </thead>
              <tbody>
                {shown.map((o) => {
                  const r = receiptLabel(o.notifications[0]);
                  const status = o.status === "CANCELLED" ? "Cancelled" : o.status === "REFUNDED" ? "Refunded" : o.status === "PARTIALLY_REFUNDED" ? "Partly refunded" : o.fulfillmentStatus === "HANDED_OUT" ? "Handed out" : "Not handed out";
                  return (
                    <tr key={o.id} className="border-t border-gray-800 align-top">
                      <td className="p-3"><div className="font-medium">{o.buyerName}</div><div className="text-gray-400">{o.buyerEmail}</div>{o.buyerPhone ? <div className="text-gray-400">{o.buyerPhone}</div> : null}</td>
                      <td className="p-3">{o.lines.map((l) => <div key={l.id}>{l.variantLabel} × {l.quantity} <span className="text-gray-400">{l.itemName}</span></div>)}</td>
                      <td className="p-3 text-gray-300">{o.fulfillmentOption?.label ?? "—"}</td>
                      <td className="p-3">{o.status === "CONFIRMED_FREE" ? "Free" : money(o.totalCents)}{o.refundedCents ? <div className="text-gray-400">−{money(o.refundedCents)} refunded</div> : null}</td>
                      <td className={`p-3 ${r.warn ? "text-yellow-200" : "text-gray-300"}`}>{r.text}</td>
                      <td className="p-3 text-gray-300">{status}{o.oversellFlag ? <div className="text-yellow-200">Check stock</div> : null}</td>
                      <td className="p-3">
                        <OrderActions
                          listingId={id}
                          orderId={o.id}
                          canHandOut={o.fulfillmentStatus === "UNFULFILLED" && ["PAID", "PARTIALLY_REFUNDED", "CONFIRMED_FREE"].includes(o.status)}
                          canCancelFree={o.status === "CONFIRMED_FREE"}
                          canResend={!!o.notifications[0] && ["SENT", "FAILED"].includes(o.notifications[0].status)}
                          receiptWasSent={o.notifications[0]?.status === "SENT"}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </section>
        <p className="text-xs text-gray-400">Refunds are made in your Stripe dashboard. Daali updates the order here once Stripe reports them.</p>
      </div>
    </main>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900 p-4">
      <div className="text-xs text-gray-400">{label}</div>
      <div className="text-xl font-semibold">{value}</div>
    </div>
  );
}
