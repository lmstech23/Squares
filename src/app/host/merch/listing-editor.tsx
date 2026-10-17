"use client";

// Host merch setup (mockup "Host: new merch sale"). One component for create
// and edit. Prices shown use the same pricing function the order uses.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { priceForNet } from "@/domain/merch/pricing";

type Variant = { id?: string; label: string; stockLimit: string };
type Item = { id?: string; name: string; description: string; imageUrl: string; priceMode: "FREE" | "PAID"; net: string; perOrderLimit: string; variants: Variant[] };
type Fulfillment = { id?: string; label: string; kind: "PICKUP" | "SHIP" };
type Question = { label: string; required: boolean };

export type EditorInitial = {
  id: string;
  status: "DRAFT" | "OPEN" | "CLOSED";
  title: string;
  description: string;
  slug: string;
  closesAt: string;
  redirectUrl: string;
  redirectVerified: boolean;
  questions: Question[];
  items: Item[];
  fulfillmentOptions: Fulfillment[];
  taxHandling: string;
  taxConfirmed: boolean;
};

const TAX = [
  ["INCLUDED_ORGANIZER_REMITS", "My price includes any sales tax due, and my organization will report and pay it."],
  ["EXEMPT_CONFIRMED", "My organization has confirmed these sales are exempt from sales tax."],
  ["NOT_DUE_CONFIRMED", "My organization has confirmed no sales tax is due on these sales."],
] as const;

function toLocalInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const blankItem = (): Item => ({ name: "", description: "", imageUrl: "", priceMode: "PAID", net: "", perOrderLimit: "10", variants: ["S", "M", "L", "XL", "2XL"].map((label) => ({ label, stockLimit: "" })) });
const input = "h-[42px] rounded-lg border border-gray-700 bg-gray-950 px-3 text-[15px] text-white";
const card = "rounded-2xl border border-gray-800 bg-gray-900 p-5 flex flex-col gap-3.5";

export default function ListingEditor({ initial, paymentsReady, publicBase }: { initial: EditorInitial | null; paymentsReady: boolean; publicBase: string }) {
  const router = useRouter();
  const [s, setS] = useState<EditorInitial>(
    initial ?? { id: "", status: "DRAFT", title: "", description: "", slug: "", closesAt: "", redirectUrl: "", redirectVerified: false, questions: [], items: [blankItem()], fulfillmentOptions: [{ label: "Pick up at the event", kind: "PICKUP" }], taxHandling: "", taxConfirmed: false }
  );
  // closesAt arrives as ISO from the server; show it in the host's own time zone.
  useEffect(() => {
    if (initial?.closesAt) setS((x) => ({ ...x, closesAt: toLocalInput(initial.closesAt) }));
  }, [initial?.closesAt]);
  const [linkConfirmed, setLinkConfirmed] = useState(initial?.redirectVerified ?? false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const hasPaid = s.items.some((i) => i.priceMode === "PAID");

  const set = (patch: Partial<EditorInitial>) => setS((x) => ({ ...x, ...patch }));
  const setItem = (idx: number, patch: Partial<Item>) => setS((x) => ({ ...x, items: x.items.map((it, i) => (i === idx ? { ...it, ...patch } : it)) }));

  function payload() {
    return {
      title: s.title, description: s.description, slug: s.slug,
      closesAt: s.closesAt ? new Date(s.closesAt).toISOString() : null,
      redirectUrl: s.redirectUrl.trim() || null,
      redirectConfirmed: linkConfirmed,
      questions: s.questions,
      items: s.items.map((it) => ({
        id: it.id, name: it.name, description: it.description, imageUrl: it.imageUrl || null, priceMode: it.priceMode,
        netCents: it.priceMode === "PAID" ? Math.round(parseFloat(it.net || "0") * 100) : null,
        perOrderLimit: Number(it.perOrderLimit || 10),
        variants: it.variants.map((v) => ({ id: v.id, label: v.label, stockLimit: v.stockLimit === "" ? null : Number(v.stockLimit) })),
      })),
      fulfillmentOptions: s.fulfillmentOptions,
      taxHandling: s.taxHandling || null,
      taxConfirmed: s.taxConfirmed,
    };
  }

  async function save(publish: boolean) {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(s.id ? `/api/host/merch/${s.id}` : "/api/host/merch", {
        method: s.id ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload()),
      });
      const data = await res.json();
      if (!res.ok) return setMsg({ ok: false, text: data.error ?? "Couldn't save." });
      const id = data.id as string;
      if (publish) {
        const p = await fetch(`/api/host/merch/${id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "publish" }) });
        const pd = await p.json();
        if (!p.ok) {
          setMsg({ ok: false, text: pd.error ?? "Couldn't publish." });
          if (!s.id) router.replace(`/host/merch/${id}`);
          return;
        }
      }
      setMsg({ ok: true, text: publish ? "Published." : "Saved." });
      if (!s.id) router.replace(`/host/merch/${id}`);
      else router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function upload(idx: number, file: File) {
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch("/api/host/merch/upload", { method: "POST", body: fd });
    const data = await res.json();
    if (!res.ok) return setMsg({ ok: false, text: data.error ?? "Upload failed." });
    setItem(idx, { imageUrl: data.url });
  }

  async function closeSale() {
    if (!s.id || !confirm("Close this sale? Supporters won't be able to order.")) return;
    await fetch(`/api/host/merch/${s.id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "close" }) });
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap justify-between items-center gap-3">
        <div>
          <Link href="/host/boards" className="text-sm text-gray-400">← Your boards</Link>
          <h1 className="text-2xl font-bold">{s.id ? s.title || "Merch sale" : "New merch sale"}</h1>
          <p className="text-sm text-gray-400">Shirts and other items on a Daali page. Free items need no Stripe account.{s.id ? ` Status: ${s.status.toLowerCase()}.` : ""}</p>
        </div>
        <div className="flex gap-2">
          {s.id ? <a href={`/host/merch/${s.id}/orders`} className="h-11 px-4 rounded-lg border border-gray-700 flex items-center text-sm">Orders</a> : null}
          {s.status === "OPEN" ? <button onClick={closeSale} className="h-11 px-4 rounded-lg border border-gray-700 text-sm">Close sale</button> : null}
          <button disabled={busy} onClick={() => save(false)} className="h-11 px-4 rounded-lg border border-gray-700 text-sm">Save draft</button>
          {s.status !== "CLOSED" ? <button disabled={busy} onClick={() => save(true)} className="h-11 px-5 rounded-lg bg-white text-gray-950 text-sm font-semibold">{s.status === "OPEN" ? "Save and keep open" : "Publish"}</button> : null}
        </div>
      </div>
      {msg ? <div role="status" className={`rounded-lg p-3 text-sm ${msg.ok ? "bg-green-950/40 border border-green-900 text-green-200" : "bg-red-950/40 border border-red-900 text-red-200"}`}>{msg.text}</div> : null}
      {hasPaid && !paymentsReady ? (
        <div className="rounded-lg border border-yellow-900/50 bg-yellow-950/20 p-3 text-sm text-yellow-200">
          Paid items need Stripe set up before you can publish. <a href="/host/stripe" className="underline">Connect Stripe</a>
        </div>
      ) : null}

      <div className="grid gap-6 md:grid-cols-2">
        <div className="flex flex-col gap-6">
          <section className={card}>
            <h2 className="text-lg font-semibold">Sale page</h2>
            <label className="flex flex-col gap-1.5 text-sm text-gray-300">Name<input className={input} value={s.title} onChange={(e) => set({ title: e.target.value })} /></label>
            <label className="flex flex-col gap-1.5 text-sm text-gray-300">About this sale<textarea className={input + " h-20 py-2"} value={s.description} onChange={(e) => set({ description: e.target.value })} /></label>
            <label className="flex flex-col gap-1.5 text-sm text-gray-300">Link
              <div className="flex items-center rounded-lg border border-gray-700 bg-gray-950 px-3 h-[42px]"><span className="text-gray-400">{publicBase}</span>
                <input className="bg-transparent flex-1 outline-none" value={s.slug} onChange={(e) => set({ slug: e.target.value.toLowerCase() })} placeholder="your-sale" /></div>
            </label>
          </section>

          {s.items.map((it, idx) => {
            const net = Math.round(parseFloat(it.net || "0") * 100);
            const price = it.priceMode === "PAID" && net >= 50 ? priceForNet(net, Number(it.perOrderLimit) || 10) : null;
            return (
              <section key={idx} className={card}>
                <div className="flex justify-between items-center"><h2 className="text-lg font-semibold">Item</h2>
                  {s.items.length > 1 ? <button className="text-sm text-gray-400" onClick={() => set({ items: s.items.filter((_, i) => i !== idx) })}>Remove item</button> : null}</div>
                <div className="flex gap-3.5 items-center">
                  <label className="w-[88px] h-[88px] rounded-xl border border-dashed border-gray-600 flex items-center justify-center text-xs text-gray-400 text-center cursor-pointer overflow-hidden">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    {it.imageUrl ? <img src={it.imageUrl} alt="" className="w-full h-full object-cover" /> : "Add photo"}
                    <input type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" onChange={(e) => e.target.files?.[0] && upload(idx, e.target.files[0])} />
                  </label>
                  <label className="flex-1 flex flex-col gap-1.5 text-sm text-gray-300">Item name<input className={input} value={it.name} onChange={(e) => setItem(idx, { name: e.target.value })} /></label>
                </div>
                <div className="flex flex-col gap-1.5"><span className="text-sm text-gray-300">Price</span>
                  <div role="radiogroup" aria-label="Price" className="grid grid-cols-2 border border-gray-700 rounded-lg overflow-hidden">
                    {(["FREE", "PAID"] as const).map((m) => (
                      <button key={m} role="radio" aria-checked={it.priceMode === m} onClick={() => setItem(idx, { priceMode: m })} className={`h-[42px] text-sm ${it.priceMode === m ? "bg-white text-gray-950 font-semibold" : "text-gray-300"}`}>{m === "FREE" ? "Free" : "Paid"}</button>
                    ))}
                  </div>
                </div>
                {it.priceMode === "PAID" ? (
                  <>
                    <label className="flex flex-col gap-1.5 text-sm text-gray-300">You receive per item
                      <div className="flex items-center rounded-lg border border-gray-700 bg-gray-950 px-3 h-[42px] gap-1"><span className="text-gray-400">$</span>
                        <input inputMode="decimal" className="bg-transparent flex-1 outline-none" value={it.net} onChange={(e) => setItem(idx, { net: e.target.value })} placeholder="40.00" /></div>
                    </label>
                    {price ? (
                      <div className="rounded-lg border border-green-800 bg-green-950 px-3.5 py-3 text-sm text-green-100 flex justify-between"><span>Supporters pay</span><span className="font-semibold">${(price / 100).toFixed(2)} each</span></div>
                    ) : null}
                    <p className="text-xs text-gray-400">Includes standard card processing, so you keep at least what you entered per item. International cards, refunds and disputes can cost you extra.</p>
                  </>
                ) : null}
                <label className="flex flex-col gap-1.5 text-sm text-gray-300">Most per order<input className={input + " w-28"} inputMode="numeric" value={it.perOrderLimit} onChange={(e) => setItem(idx, { perOrderLimit: e.target.value })} /></label>
                <div className="flex flex-col gap-2">
                  <div className="flex justify-between text-sm"><span className="font-semibold">Sizes</span><span className="text-xs text-gray-400">Limit is optional</span></div>
                  {it.variants.map((v, vi) => (
                    <div key={vi} className="grid grid-cols-[1fr_1fr_auto] gap-2 items-center">
                      <input aria-label="Size" className={input} value={v.label} onChange={(e) => setItem(idx, { variants: it.variants.map((x, j) => (j === vi ? { ...x, label: e.target.value } : x)) })} />
                      <input aria-label={`Limit for ${v.label}`} className={input} inputMode="numeric" placeholder="No limit" value={v.stockLimit} onChange={(e) => setItem(idx, { variants: it.variants.map((x, j) => (j === vi ? { ...x, stockLimit: e.target.value.replace(/\D/g, "") } : x)) })} />
                      <button aria-label={`Remove size ${v.label}`} className="w-9 h-9 rounded-lg border border-gray-700 text-gray-400" onClick={() => setItem(idx, { variants: it.variants.filter((_, j) => j !== vi) })}>×</button>
                    </div>
                  ))}
                  <button className="h-10 rounded-lg border border-dashed border-gray-600 text-sm text-gray-300" onClick={() => setItem(idx, { variants: [...it.variants, { label: "", stockLimit: "" }] })}>+ Add size</button>
                </div>
              </section>
            );
          })}
          <button className="h-11 rounded-lg border border-dashed border-gray-600 text-sm text-gray-300" onClick={() => set({ items: [...s.items, blankItem()] })}>+ Add another item</button>
        </div>

        <div className="flex flex-col gap-6">
          <section className={card}>
            <h2 className="text-lg font-semibold">Getting items to supporters</h2>
            {s.fulfillmentOptions.map((f, i) => (
              <div key={i} className="flex gap-2">
                <input aria-label="Pickup option" className={input + " flex-1"} value={f.label} onChange={(e) => set({ fulfillmentOptions: s.fulfillmentOptions.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })} />
                <button aria-label="Remove option" className="w-[42px] rounded-lg border border-gray-700 text-gray-400" onClick={() => set({ fulfillmentOptions: s.fulfillmentOptions.filter((_, j) => j !== i) })}>×</button>
              </div>
            ))}
            <button className="h-10 rounded-lg border border-dashed border-gray-600 text-sm text-gray-300" onClick={() => set({ fulfillmentOptions: [...s.fulfillmentOptions, { label: "", kind: "PICKUP" }] })}>+ Add pickup option</button>
            <label className="flex flex-col gap-1.5 text-sm text-gray-300">Orders close<input type="datetime-local" className={input} value={s.closesAt} onChange={(e) => set({ closesAt: e.target.value })} /></label>
          </section>

          <section className={card}>
            <h2 className="text-lg font-semibold">Extra question <span className="text-sm font-normal text-gray-400">(up to 2)</span></h2>
            {s.questions.map((q, i) => (
              <div key={i} className="flex gap-2 items-center">
                <input aria-label="Question" className={input + " flex-1"} value={q.label} onChange={(e) => set({ questions: s.questions.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })} />
                <label className="text-xs text-gray-300 flex items-center gap-1"><input type="checkbox" checked={q.required} onChange={(e) => set({ questions: s.questions.map((x, j) => (j === i ? { ...x, required: e.target.checked } : x)) })} />Required</label>
                <button aria-label="Remove question" className="w-9 h-9 rounded-lg border border-gray-700 text-gray-400" onClick={() => set({ questions: s.questions.filter((_, j) => j !== i) })}>×</button>
              </div>
            ))}
            {s.questions.length < 2 ? <button className="h-10 rounded-lg border border-dashed border-gray-600 text-sm text-gray-300" onClick={() => set({ questions: [...s.questions, { label: "", required: false }] })}>+ Add question</button> : null}
          </section>

          <section className={card}>
            <h2 className="text-lg font-semibold">After the order</h2>
            <p className="text-sm text-gray-300">Send supporters straight to another page once their order is confirmed, like your game ticket page.</p>
            <label className="flex flex-col gap-1.5 text-sm text-gray-300">After-order link (optional)
              <input className={input} value={s.redirectUrl} onChange={(e) => { set({ redirectUrl: e.target.value }); setLinkConfirmed(false); }} placeholder="https://…" /></label>
            {s.redirectUrl.startsWith("https://") ? <a href={s.redirectUrl} target="_blank" rel="noreferrer noopener" className="text-sm text-green-300">Open link to check it</a> : null}
            <label className="flex gap-2.5 items-start text-sm"><input type="checkbox" className="mt-0.5 w-[18px] h-[18px]" checked={linkConfirmed} onChange={(e) => setLinkConfirmed(e.target.checked)} disabled={!s.redirectUrl} />I opened it. This is the right page for my supporters.</label>
            <p className="text-xs text-gray-400">Paid orders go there only after Stripe confirms payment. Daali doesn&apos;t sell or track anything on that site.</p>
          </section>

          {hasPaid ? (
            <section className={card + " border-yellow-800"}>
              <div className="flex justify-between items-baseline"><h2 className="text-lg font-semibold">Sales tax</h2><span className="text-xs text-yellow-200">Required to publish paid items</span></div>
              <p className="text-sm text-gray-300">Daali doesn&apos;t calculate, collect separately or pay sales tax. Fundraiser merchandise isn&apos;t automatically tax-exempt. Check your state&apos;s rules.</p>
              <fieldset className="flex flex-col gap-2.5">
                <legend className="text-sm text-gray-300 mb-2">How will sales tax be handled?</legend>
                {TAX.map(([v, text]) => (
                  <label key={v} className="flex gap-2.5 items-start text-sm"><input type="radio" name="tax" className="mt-0.5 w-[18px] h-[18px]" checked={s.taxHandling === v} onChange={() => set({ taxHandling: v, taxConfirmed: false })} />{text}</label>
                ))}
              </fieldset>
              <label className="flex gap-2.5 items-start text-sm border-t border-gray-800 pt-3"><input type="checkbox" className="mt-0.5 w-[18px] h-[18px]" checked={s.taxConfirmed} disabled={!s.taxHandling} onChange={(e) => set({ taxConfirmed: e.target.checked })} />I confirm this is accurate and that sales tax is my organization&apos;s responsibility.</label>
            </section>
          ) : null}
        </div>
      </div>
    </div>
  );
}
