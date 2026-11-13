"use client";

import { useMemo, useRef, useState } from "react";

export type SaleView = {
  slug: string;
  title: string;
  description: string | null;
  closesAt: string | null;
  closed: boolean;
  cancelled: boolean;
  hasAfterLink: boolean;
  afterHost: string | null;
  questions: { key: string; label: string; required: boolean }[];
  fulfillmentOptions: { id: string; label: string }[];
  items: {
    id: string;
    name: string;
    description: string | null;
    imageUrl: string | null;
    unitPriceCents: number;
    perOrderLimit: number;
    variants: { id: string; label: string; remaining: number | null }[];
  }[];
};

const money = (c: number) => (c === 0 ? "Free" : "$" + (c / 100).toFixed(2));
const newKey = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(36).slice(2)).replace(/[^A-Za-z0-9_-]/g, "");

export default function SaleClient({ view }: { view: SaleView }) {
  const [step, setStep] = useState<"pick" | "details" | "working">("pick");
  const [qty, setQty] = useState<Record<string, number>>({});
  const [form, setForm] = useState({ name: "", email: "", phone: "", fulfillmentOptionId: view.fulfillmentOptions[0]?.id ?? "", answers: {} as Record<string, string> });
  const [error, setError] = useState<string | null>(view.cancelled ? "Payment was cancelled. Nothing was charged." : null);
  const [status, setStatus] = useState<string | null>(null);
  const keyRef = useRef(newKey());

  const chosen = useMemo(() => {
    const rows: { itemName: string; label: string; variantId: string; quantity: number; unit: number }[] = [];
    for (const i of view.items) for (const v of i.variants) {
      const q = qty[v.id] ?? 0;
      if (q > 0) rows.push({ itemName: i.name, label: v.label, variantId: v.id, quantity: q, unit: i.unitPriceCents });
    }
    return rows;
  }, [qty, view.items]);
  const count = chosen.reduce((a, r) => a + r.quantity, 0);
  const total = chosen.reduce((a, r) => a + r.quantity * r.unit, 0);

  function bump(itemId: string, variantId: string, d: number) {
    const item = view.items.find((i) => i.id === itemId)!;
    const v = item.variants.find((x) => x.id === variantId)!;
    setQty((q) => {
      const itemTotal = item.variants.reduce((a, x) => a + (q[x.id] ?? 0), 0);
      const cur = q[variantId] ?? 0;
      let next = Math.max(0, cur + d);
      if (d > 0 && itemTotal >= item.perOrderLimit) next = cur;
      if (v.remaining !== null && next > v.remaining) next = cur;
      return { ...q, [variantId]: next };
    });
  }

  async function retryCheckout(token: string) {
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      const res = await fetch(`/api/merch/orders/${token}/checkout`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (data.kind === "checkout" || data.kind === "done") return window.location.assign(data.next);
      if (data.kind === "failed") return fail(data.error);
    }
    fail("Payment couldn't start. If you were charged, you'll get a receipt by email. Otherwise, please try again.");
  }

  function fail(msg: string) {
    keyRef.current = newKey();
    setStatus(null);
    setError(msg);
    setStep("details");
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    for (const q of view.questions) if (q.required && !form.answers[q.key]?.trim()) return setError(`Please answer: ${q.label}`);
    setStep("working");
    setStatus(total > 0 ? "Starting secure payment…" : "Confirming your reservation…");
    try {
      const res = await fetch(`/api/merch/${view.slug}/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idempotencyKey: keyRef.current, ...form, lines: chosen.map((c) => ({ variantId: c.variantId, quantity: c.quantity })) }),
      });
      const data = await res.json().catch(() => ({}));
      if (data.kind === "checkout" || data.kind === "confirmed" || data.kind === "done") return window.location.assign(data.next);
      if (data.kind === "retry") {
        setStatus("Still setting up payment…");
        return retryCheckout(data.token);
      }
      fail(data.error ?? "Something went wrong. Please try again.");
    } catch {
      // Network failure: retrying with the SAME key finds the same order, never a second one.
      fail("Connection problem. Tap the button again — you won't be charged twice.");
    }
  }

  const closesText = view.closesAt ? `Orders close ${new Date(view.closesAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}.` : "";

  return (
    <main className="min-h-screen bg-gray-950 text-white">
      <div className="mx-auto max-w-md px-5 py-6 flex flex-col gap-5">
        {view.items[0]?.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={view.items[0].imageUrl} alt="" className="w-full h-52 object-cover rounded-2xl border border-gray-800" />
        ) : null}
        <div>
          <h1 className="text-2xl font-bold">{view.title}</h1>
          {view.description ? <p className="text-sm text-gray-300 mt-1 whitespace-pre-line">{view.description}</p> : null}
        </div>

        {error ? <div role="alert" className="rounded-lg border border-red-900/60 bg-red-950/40 p-3 text-sm text-red-200">{error}</div> : null}

        {view.closed ? (
          <p className="rounded-lg border border-gray-800 bg-gray-900 p-4 text-sm text-gray-300">Orders for this sale are closed.</p>
        ) : step === "pick" ? (
          <>
            {view.items.map((item) => (
              <section key={item.id} className="flex flex-col gap-2">
                <div className="flex justify-between items-baseline">
                  <h2 className="text-base font-semibold">{item.name}</h2>
                  <span>{item.unitPriceCents === 0 ? "Free" : `${money(item.unitPriceCents)} each`}</span>
                </div>
                {item.description ? <p className="text-sm text-gray-400">{item.description}</p> : null}
                {item.variants.map((v) => {
                  const q = qty[v.id] ?? 0;
                  const soldOut = v.remaining !== null && v.remaining <= 0;
                  return (
                    <div key={v.id} className="flex justify-between items-center h-[52px] px-3.5 rounded-xl border border-gray-800 bg-gray-900">
                      <span className="font-semibold">
                        {v.label}
                        {soldOut ? <span className="ml-2 text-xs font-normal text-gray-400">Sold out</span> : v.remaining !== null && v.remaining <= 5 ? <span className="ml-2 text-xs font-normal text-gray-400">{v.remaining} left</span> : null}
                      </span>
                      <div className="flex items-center gap-3.5">
                        <button type="button" aria-label={`Fewer ${v.label}`} onClick={() => bump(item.id, v.id, -1)} disabled={q === 0} className="w-10 h-10 rounded-lg border border-gray-700 text-xl disabled:opacity-40">−</button>
                        <span className="w-5 text-center" aria-live="polite">{q}</span>
                        <button type="button" aria-label={`More ${v.label}`} onClick={() => bump(item.id, v.id, 1)} disabled={soldOut} className="w-10 h-10 rounded-lg border border-gray-700 text-xl disabled:opacity-40">+</button>
                      </div>
                    </div>
                  );
                })}
              </section>
            ))}
            <div className="sticky bottom-0 -mx-5 px-5 pt-3 pb-5 bg-gray-950 border-t border-gray-800 flex flex-col gap-2.5">
              <div className="flex justify-between text-sm"><span className="text-gray-300">{count} {count === 1 ? "item" : "items"}</span><span className="font-semibold">{total === 0 && count > 0 ? "Free" : money(total)}</span></div>
              <button type="button" disabled={count === 0} onClick={() => { setError(null); setStep("details"); }} className="h-[52px] rounded-xl bg-white text-gray-950 font-semibold disabled:opacity-40">Continue</button>
              <p className="text-xs text-gray-400 text-center">{closesText} {total > 0 ? "Price includes card processing." : ""}</p>
            </div>
          </>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-4">
            <button type="button" onClick={() => setStep("pick")} className="self-start text-sm text-gray-400" disabled={step === "working"}>← Change items</button>
            <h2 className="text-xl font-bold">Your details</h2>
            <div className="rounded-xl border border-gray-800 bg-gray-900 p-3.5 text-sm flex flex-col gap-1.5">
              {chosen.map((c) => (
                <div key={c.variantId} className="flex justify-between"><span>{c.itemName} · {c.label}</span><span>× {c.quantity}</span></div>
              ))}
              <div className="flex justify-between border-t border-gray-800 pt-2 mt-1 font-semibold"><span>Total</span><span>{total === 0 ? "Free" : money(total)}</span></div>
            </div>
            <Field label="Name" value={form.name} onChange={(v) => setForm({ ...form, name: v })} autoComplete="name" required />
            <Field label="Email" type="email" value={form.email} onChange={(v) => setForm({ ...form, email: v })} autoComplete="email" required />
            <Field label="Phone" type="tel" value={form.phone} onChange={(v) => setForm({ ...form, phone: v })} autoComplete="tel" />
            {view.fulfillmentOptions.length > 0 ? (
              <label className="flex flex-col gap-1.5 text-sm text-gray-300">How will you get your items?
                <select value={form.fulfillmentOptionId} onChange={(e) => setForm({ ...form, fulfillmentOptionId: e.target.value })} className="h-[46px] rounded-xl border border-gray-700 bg-gray-900 px-3 text-base text-white">
                  {view.fulfillmentOptions.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
                </select>
              </label>
            ) : null}
            {view.questions.map((q) => (
              <Field key={q.key} label={q.required ? q.label : `${q.label} (optional)`} value={form.answers[q.key] ?? ""} onChange={(v) => setForm({ ...form, answers: { ...form.answers, [q.key]: v } })} required={q.required} />
            ))}
            <div className="flex flex-col gap-2.5 pt-1">
              <button type="submit" disabled={step === "working"} className="h-[52px] rounded-xl bg-white text-gray-950 font-semibold disabled:opacity-60">
                {step === "working" ? status : total > 0 ? `Pay ${money(total)}` : "Reserve"}
              </button>
              <p className="text-xs text-gray-400 text-center leading-relaxed">
                {total > 0 ? "Card payment is handled securely by Stripe. " : ""}
                {view.hasAfterLink ? `After ${total > 0 ? "payment" : "reserving"} you'll go straight to ${view.afterHost}.` : ""}
              </p>
            </div>
          </form>
        )}
      </div>
    </main>
  );
}

function Field(props: { label: string; value: string; onChange: (v: string) => void; type?: string; autoComplete?: string; required?: boolean }) {
  return (
    <label className="flex flex-col gap-1.5 text-sm text-gray-300">
      {props.label}
      <input type={props.type ?? "text"} value={props.value} required={props.required} autoComplete={props.autoComplete} onChange={(e) => props.onChange(e.target.value)} className="h-[46px] rounded-xl border border-gray-700 bg-gray-900 px-3 text-base text-white" />
    </label>
  );
}
