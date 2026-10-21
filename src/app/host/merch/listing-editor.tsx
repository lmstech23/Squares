"use client";

// Host merch setup — spec §5.6.1 (Revision 3.6, UX-2). One short screen, optional
// settings collapsed, a review step before publishing, and a "live" panel only
// after the server confirms. UI only: the payload and the server rules are the
// same as before; prices come from the same pricing function the order uses.

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

type Msg = { ok: boolean; text: string };

const TAX = [
  ["INCLUDED_ORGANIZER_REMITS", "My price includes any sales tax due, and my organization will report and pay it."],
  ["EXEMPT_CONFIRMED", "My organization has confirmed these sales are exempt from sales tax."],
  ["NOT_DUE_CONFIRMED", "My organization has confirmed no sales tax is due on these sales."],
] as const;

// "No limit" stores the system maximum (§5.6.1 step 4). Same price as the old
// default of 10 for every net from $0.50 to $1,000, checked Oct 21.
const NO_LIMIT = "100";
// An item saved with no sizes is stored as one option (§5.6.1 step 3).
const ONE_SIZE = "One size";

function toLocalInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Client-side preview of the server's slugify (src/domain/merch/validate.ts);
// the server still validates and stores its own result.
function linkFromName(name: string): string {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48).replace(/-+$/g, "");
}

const blankItem = (): Item => ({ name: "", description: "", imageUrl: "", priceMode: "PAID", net: "", perOrderLimit: NO_LIMIT, variants: ["S", "M", "L", "XL", "2XL"].map((label) => ({ label, stockLimit: "" })) });
const input = "h-[42px] rounded-lg border border-gray-700 bg-gray-950 px-3 text-[15px] text-white";
const card = "rounded-2xl border border-gray-800 bg-gray-900 p-5 flex flex-col gap-3.5";
const dashed = "h-10 rounded-lg border border-dashed border-gray-600 text-sm text-gray-300";
const NOTICE_KEY = "daali-merch-editor-notice";

// The reply may not be JSON (an expired sign-in can come back as a login page),
// so never let parsing throw and swallow the outcome.
async function readJson(res: Response): Promise<{ id?: unknown; url?: unknown; error?: unknown } | null> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function failureText(res: Response, data: { error?: unknown } | null, fallback: string): string {
  if (res.status === 401 || res.redirected) return "You've been signed out. Sign in again, then save.";
  if (typeof data?.error === "string" && data.error) return data.error;
  return `${fallback} Please try again.`;
}

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

export default function ListingEditor({ initial, paymentsReady, publicBase }: { initial: EditorInitial | null; paymentsReady: boolean; publicBase: string }) {
  const router = useRouter();
  const [s, setS] = useState<EditorInitial>(
    initial ?? { id: "", status: "DRAFT", title: "", description: "", slug: "", closesAt: "", redirectUrl: "", redirectVerified: false, questions: [], items: [blankItem()], fulfillmentOptions: [], taxHandling: "", taxConfirmed: false }
  );
  // closesAt arrives as ISO from the server; show it in the host's own time zone.
  useEffect(() => {
    if (initial?.closesAt) setS((x) => ({ ...x, closesAt: toLocalInput(initial.closesAt) }));
  }, [initial?.closesAt]);
  // The sale link follows the sale name until the organizer edits it (§5.6.1).
  const [linkEdited, setLinkEdited] = useState(!!initial?.slug);
  // Per item: is there a purchase limit? Existing items below the maximum have one.
  const [limited, setLimited] = useState<boolean[]>(() => (initial?.items ?? [blankItem()]).map((it) => Number(it.perOrderLimit) > 0 && Number(it.perOrderLimit) < Number(NO_LIMIT)));
  const [showMore, setShowMore] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [reviewMsg, setReviewMsg] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg | null>(null);
  const hasPaid = s.items.some((i) => i.priceMode === "PAID");

  // Pick up the result carried from the first save of a new sale (see goToSale).
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(NOTICE_KEY);
      if (!raw) return;
      sessionStorage.removeItem(NOTICE_KEY);
      const m = JSON.parse(raw);
      if (m?.live === true) setLive(true);
      else if (m && typeof m.text === "string") setMsg({ ok: !!m.ok, text: m.text });
    } catch {}
  }, []);

  const set = (patch: Partial<EditorInitial>) => setS((x) => ({ ...x, ...patch }));
  const setItem = (idx: number, patch: Partial<Item>) => setS((x) => ({ ...x, items: x.items.map((it, i) => (i === idx ? { ...it, ...patch } : it)) }));
  const setTitle = (title: string) => setS((x) => ({ ...x, title, slug: linkEdited ? x.slug : linkFromName(title) }));
  const saleUrl = `https://${publicBase}${s.slug || linkFromName(s.title) || "your-sale"}`;

  function variantsFor(it: Item) {
    const named = it.variants.filter((v) => v.label.trim() !== "");
    const list = named.length > 0 ? named : [{ id: it.variants.find((v) => v.label.trim() === ONE_SIZE)?.id, label: ONE_SIZE, stockLimit: "" }];
    return list.map((v) => ({ id: v.id, label: v.label.trim(), stockLimit: v.stockLimit === "" ? null : Number(v.stockLimit) }));
  }

  function payload(tax?: { handling: string; confirmed: boolean }) {
    const redirectUrl = s.redirectUrl.trim() || null;
    return {
      title: s.title, description: s.description, slug: s.slug || linkFromName(s.title),
      closesAt: s.closesAt ? new Date(s.closesAt).toISOString() : null,
      redirectUrl,
      // LV-1: saving a link is the organizer's confirmation; no separate checkbox.
      redirectConfirmed: !!redirectUrl,
      questions: s.questions,
      items: s.items.map((it, i) => ({
        id: it.id, name: it.name, description: it.description, imageUrl: it.imageUrl || null, priceMode: it.priceMode,
        netCents: it.priceMode === "PAID" ? Math.round(parseFloat(it.net || "0") * 100) : null,
        perOrderLimit: limited[i] ? Number(it.perOrderLimit || 0) : Number(NO_LIMIT),
        variants: variantsFor(it),
      })),
      // §5.6.1 (Rev 3.7): setup has no pickup step. A new sale has none; an existing
      // sale's options are sent back exactly as loaded so they are never removed.
      fulfillmentOptions: s.fulfillmentOptions,
      taxHandling: (tax ? tax.handling : s.taxHandling) || null,
      taxConfirmed: tax ? tax.confirmed : false,
    };
  }

  // Save, then optionally publish. Returns an error message, or null on success.
  async function persist(publish: boolean, tax?: { handling: string; confirmed: boolean }): Promise<{ error: string | null; id?: string }> {
    try {
      const res = await fetch(s.id ? `/api/host/merch/${s.id}` : "/api/host/merch", {
        method: s.id ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload(tax)),
      });
      const data = await readJson(res);
      if (!res.ok || typeof data?.id !== "string") return { error: failureText(res, data, "Couldn't save.") };
      const id = data.id;
      if (publish) {
        const p = await fetch(`/api/host/merch/${id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "publish" }) });
        const pd = await readJson(p);
        if (!p.ok) return { error: `Saved as a draft, but not published. ${failureText(p, pd, "Couldn't publish.")}`, id };
      }
      return { error: null, id };
    } catch {
      return { error: "Couldn't reach Daali. Check your connection and try again." };
    }
  }

  function noteLinkProblem(text: string) {
    // The after-order link lives under Additional options; open it when it's the problem.
    if (/after-order/i.test(text)) setShowMore(true);
  }

  async function saveDraft() {
    setBusy(true);
    setMsg(null);
    const r = await persist(false);
    setBusy(false);
    if (r.error) {
      noteLinkProblem(r.error);
      if (!s.id && r.id) return goToSale(r.id, { ok: false, text: r.error });
      return showMsg({ ok: false, text: r.error });
    }
    if (!s.id && r.id) return goToSale(r.id, { ok: true, text: "Draft saved." });
    showMsg({ ok: true, text: "Draft saved." });
    router.refresh();
  }

  // An open sale saves and stays open; a draft goes through the review step.
  async function continueOrSave() {
    if (s.status === "OPEN") {
      setBusy(true);
      setMsg(null);
      const r = await persist(true);
      setBusy(false);
      if (r.error) {
        noteLinkProblem(r.error);
        return showMsg({ ok: false, text: r.error });
      }
      showMsg({ ok: true, text: "Changes saved. Your sale is still open." });
      return router.refresh();
    }
    setReviewMsg(null);
    setReviewing(true);
  }

  async function publishFromReview(tax: { handling: string; confirmed: boolean }) {
    setBusy(true);
    setReviewMsg(null);
    const r = await persist(true, hasPaid ? tax : undefined);
    setBusy(false);
    if (r.error) {
      noteLinkProblem(r.error);
      if (!s.id && r.id) return goToSale(r.id, { ok: false, text: r.error });
      return setReviewMsg(r.error);
    }
    setReviewing(false);
    if (!s.id && r.id) {
      try { sessionStorage.setItem(NOTICE_KEY, JSON.stringify({ live: true })); } catch {}
      return router.replace(`/host/merch/${r.id}`);
    }
    setLive(true);
    router.refresh();
  }

  // A new sale moves to its own page after the first save; the result is
  // carried across that navigation so it is not lost on the way.
  function goToSale(id: string, m: Msg) {
    try { sessionStorage.setItem(NOTICE_KEY, JSON.stringify(m)); } catch {}
    router.replace(`/host/merch/${id}`);
  }

  function showMsg(m: Msg) {
    setMsg(m);
    try { window.scrollTo({ top: 0, behavior: "smooth" }); } catch {}
  }

  async function upload(idx: number, file: File) {
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch("/api/host/merch/upload", { method: "POST", body: fd }).catch(() => null);
    const data = res ? await readJson(res) : null;
    if (!res || !res.ok || typeof data?.url !== "string") return showMsg({ ok: false, text: res ? failureText(res, data, "Upload failed.") : "Upload failed. Check your connection and try again." });
    setItem(idx, { imageUrl: data.url });
  }

  async function closeSale() {
    if (!s.id || !confirm("Close this sale? Supporters won't be able to order.")) return;
    await fetch(`/api/host/merch/${s.id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "close" }) });
    router.refresh();
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(saleUrl);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  if (live) {
    return (
      <div className="max-w-xl mx-auto flex flex-col gap-5">
        <section className={card + " items-start"}>
          <h1 className="text-2xl font-bold">✓ Your sale is live</h1>
          <p className="text-sm text-gray-300">Share this link with your supporters.</p>
          <div className="w-full flex gap-2 items-center">
            <span className="flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap rounded-lg border border-gray-700 bg-gray-950 px-3 h-[42px] leading-[42px] text-[15px]" style={{ direction: "rtl", textAlign: "left" }}>
              <bdi dir="ltr">{saleUrl.replace(/^https:\/\//, "")}</bdi>
            </span>
            <button onClick={copyLink} className="h-[42px] px-4 rounded-lg bg-white text-gray-950 text-sm font-semibold shrink-0">{copied ? "Copied" : "Copy link"}</button>
          </div>
          <div className="flex flex-wrap gap-2 pt-1">
            <a href={saleUrl} target="_blank" rel="noreferrer noopener" className="h-11 px-4 rounded-lg border border-gray-700 flex items-center text-sm">View sale</a>
            <Link href="/host/boards" className="h-11 px-4 rounded-lg border border-gray-700 flex items-center text-sm">Back to dashboard</Link>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto flex flex-col gap-6">
      <div className="flex flex-wrap justify-between items-center gap-3">
        <div>
          <Link href="/host/boards" className="text-sm text-gray-400">← Your boards</Link>
          <h1 className="text-2xl font-bold">{s.id ? s.title || "Merch sale" : "New merch sale"}</h1>
          {s.id ? <p className="text-sm text-gray-400">Status: {s.status.toLowerCase()}.</p> : null}
        </div>
        <div className="flex flex-wrap gap-2">
          {s.id ? <a href={`/host/merch/${s.id}/orders`} className="h-11 px-4 rounded-lg border border-gray-700 flex items-center text-sm">Orders</a> : null}
          {s.status === "OPEN" ? <button onClick={closeSale} className="h-11 px-4 rounded-lg border border-gray-700 text-sm">Close sale</button> : null}
          <button disabled={busy} onClick={saveDraft} className="h-11 px-4 rounded-lg border border-gray-700 text-sm">Save draft</button>
          {s.status !== "CLOSED" ? <button disabled={busy} onClick={continueOrSave} className="h-11 px-5 rounded-lg bg-white text-gray-950 text-sm font-semibold">{s.status === "OPEN" ? "Save changes" : "Continue"}</button> : null}
        </div>
      </div>
      {msg ? <div role="status" className={`rounded-lg p-3 text-sm ${msg.ok ? "bg-green-950/40 border border-green-900 text-green-200" : "bg-red-950/40 border border-red-900 text-red-200"}`}>{msg.text}</div> : null}
      {hasPaid && !paymentsReady ? (
        <div className="rounded-lg border border-yellow-900/50 bg-yellow-950/20 p-3 text-sm text-yellow-200">
          Paid items need Stripe set up before you can publish. <a href="/host/stripe" className="underline">Connect Stripe</a>
        </div>
      ) : null}

      <section className={card}>
        <label className="flex flex-col gap-1.5 text-sm text-gray-300">Sale name<input className={input} value={s.title} onChange={(e) => setTitle(e.target.value)} /></label>
        <label className="flex flex-col gap-1.5 text-sm text-gray-300">Sale link
          <input className={input + " w-full"} value={s.slug} onChange={(e) => { setLinkEdited(true); set({ slug: e.target.value.toLowerCase() }); }} placeholder="your-sale" />
          {/* Full address on one line under the box. A long host is cut from the
              start ("…") so the part being typed always stays visible. */}
          <span className="flex min-w-0 gap-1 text-xs text-gray-400">
            <span className="shrink-0">Your sale&apos;s address:</span>
            <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap" style={{ direction: "rtl", textAlign: "left" }}>
              <bdi dir="ltr">{publicBase}{s.slug || "your-sale"}</bdi>
            </span>
          </span>
        </label>
        <label className="flex flex-col gap-1.5 text-sm text-gray-300">Description (optional)<textarea className={input + " h-24 py-2"} value={s.description} onChange={(e) => set({ description: e.target.value })} placeholder="Include pickup details, like where and when to collect." /></label>
      </section>

      {s.items.map((it, idx) => {
        const net = Math.round(parseFloat(it.net || "0") * 100);
        const maxQty = limited[idx] ? Math.min(Math.max(Number(it.perOrderLimit) || 1, 1), 100) : Number(NO_LIMIT);
        const price = it.priceMode === "PAID" && net >= 50 ? priceForNet(net, maxQty) : null;
        return (
          <section key={idx} className={card}>
            <div className="flex justify-between items-center"><h2 className="text-lg font-semibold">Item</h2>
              {s.items.length > 1 ? <button className="text-sm text-gray-400" onClick={() => { set({ items: s.items.filter((_, i) => i !== idx) }); setLimited((l) => l.filter((_, i) => i !== idx)); }}>Remove item</button> : null}</div>
            <div className="flex gap-3.5 items-center">
              <label className="w-[88px] h-[88px] rounded-xl border border-dashed border-gray-600 flex items-center justify-center text-xs text-gray-400 text-center cursor-pointer overflow-hidden shrink-0">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                {it.imageUrl ? <img src={it.imageUrl} alt="" className="w-full h-full object-cover" /> : "Add photo (optional)"}
                <input type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" onChange={(e) => e.target.files?.[0] && upload(idx, e.target.files[0])} />
              </label>
              <label className="flex-1 min-w-0 flex flex-col gap-1.5 text-sm text-gray-300">Item name<input className={input + " w-full min-w-0"} value={it.name} onChange={(e) => setItem(idx, { name: e.target.value })} /></label>
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
                  <div className="rounded-lg border border-green-800 bg-green-950 px-3.5 py-3 text-sm text-green-100 flex justify-between"><span>Supporters pay</span><span className="font-semibold">{money(price)} each</span></div>
                ) : null}
                <p className="text-xs text-gray-400">Includes standard card processing, so you keep at least what you entered per item. International cards, refunds and disputes can cost you extra.</p>
              </>
            ) : null}
            <div className="flex flex-col gap-2">
              <div className="flex justify-between text-sm"><span className="font-semibold">Sizes (optional)</span><span className="text-xs text-gray-400">Limit is optional</span></div>
              {it.variants.map((v, vi) => (
                <div key={vi} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] gap-2 items-center">
                  <input aria-label="Size" className={input + " w-full min-w-0"} value={v.label} onChange={(e) => setItem(idx, { variants: it.variants.map((x, j) => (j === vi ? { ...x, label: e.target.value } : x)) })} />
                  <input aria-label={`Limit for ${v.label}`} className={input + " w-full min-w-0"} inputMode="numeric" placeholder="No limit" value={v.stockLimit} onChange={(e) => setItem(idx, { variants: it.variants.map((x, j) => (j === vi ? { ...x, stockLimit: e.target.value.replace(/\D/g, "") } : x)) })} />
                  <button aria-label={`Remove size ${v.label}`} className="w-9 h-9 rounded-lg border border-gray-700 text-gray-400" onClick={() => setItem(idx, { variants: it.variants.filter((_, j) => j !== vi) })}>×</button>
                </div>
              ))}
              <button className={dashed} onClick={() => setItem(idx, { variants: [...it.variants, { label: "", stockLimit: "" }] })}>+ Add size</button>
              {it.variants.every((v) => v.label.trim() === "") ? <p className="text-xs text-gray-400">No sizes: buyers will see this as &ldquo;{ONE_SIZE}&rdquo;.</p> : null}
            </div>
            <fieldset className="flex flex-col gap-2">
              <legend className="text-sm text-gray-300 mb-2">Is there a limit on how many items a customer can purchase?</legend>
              <div role="radiogroup" className="grid grid-cols-2 border border-gray-700 rounded-lg overflow-hidden w-48">
                {[false, true].map((yes) => (
                  <button key={String(yes)} role="radio" aria-checked={limited[idx] === yes} onClick={() => { setLimited((l) => l.map((x, i) => (i === idx ? yes : x))); setItem(idx, { perOrderLimit: yes ? "" : NO_LIMIT }); }} className={`h-[40px] text-sm ${limited[idx] === yes ? "bg-white text-gray-950 font-semibold" : "text-gray-300"}`}>{yes ? "Yes" : "No"}</button>
                ))}
              </div>
              {limited[idx] ? (
                <label className="flex flex-col gap-1.5 text-sm text-gray-300">How many per order?<input className={input + " w-28"} inputMode="numeric" value={it.perOrderLimit} onChange={(e) => setItem(idx, { perOrderLimit: e.target.value.replace(/\D/g, "") })} placeholder="1–100" /></label>
              ) : null}
            </fieldset>
          </section>
        );
      })}
      <button className={dashed + " h-11"} onClick={() => { set({ items: [...s.items, blankItem()] }); setLimited((l) => [...l, false]); }}>+ Add another item</button>


      <section className={card}>
        <button aria-expanded={showMore} onClick={() => setShowMore((x) => !x)} className="flex flex-col items-start gap-1 text-left">
          <span className="text-lg font-semibold">{showMore ? "▾" : "▸"} Additional options</span>
          <span className="text-xs text-gray-400">Order deadline · buyer questions · after-order link</span>
        </button>
        {showMore ? (
          <div className="flex flex-col gap-5 pt-2">
            <label className="flex flex-col gap-1.5 text-sm text-gray-300">Order deadline (optional)<input type="datetime-local" className={input} value={s.closesAt} onChange={(e) => set({ closesAt: e.target.value })} /></label>

            <div className="flex flex-col gap-2">
              <span className="text-sm text-gray-300">Buyer questions <span className="text-gray-400">(up to 2)</span></span>
              {s.questions.map((q, i) => (
                <div key={i} className="flex gap-2 items-center">
                  <input aria-label="Question" className={input + " flex-1"} value={q.label} onChange={(e) => set({ questions: s.questions.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })} />
                  <label className="text-xs text-gray-300 flex items-center gap-1"><input type="checkbox" checked={q.required} onChange={(e) => set({ questions: s.questions.map((x, j) => (j === i ? { ...x, required: e.target.checked } : x)) })} />Required</label>
                  <button aria-label="Remove question" className="w-9 h-9 rounded-lg border border-gray-700 text-gray-400" onClick={() => set({ questions: s.questions.filter((_, j) => j !== i) })}>×</button>
                </div>
              ))}
              {s.questions.length < 2 ? <button className={dashed} onClick={() => set({ questions: [...s.questions, { label: "", required: false }] })}>+ Add question</button> : null}
            </div>

            <label className="flex flex-col gap-1.5 text-sm text-gray-300">After-order link (optional)
              <input className={input} value={s.redirectUrl} onChange={(e) => set({ redirectUrl: e.target.value })} placeholder="https://…" />
              <span className="text-xs text-gray-400">Buyers go here once payment is confirmed, like your game ticket page.</span>
            </label>
          </div>
        ) : null}
      </section>

      {reviewing ? (
        <Review
          s={s}
          limited={limited}
          hasPaid={hasPaid}
          busy={busy}
          error={reviewMsg}
          onBack={() => setReviewing(false)}
          onPublish={publishFromReview}
        />
      ) : null}
    </div>
  );
}

function Review({ s, limited, hasPaid, busy, error, onBack, onPublish }: {
  s: EditorInitial;
  limited: boolean[];
  hasPaid: boolean;
  busy: boolean;
  error: string | null;
  onBack: () => void;
  onPublish: (tax: { handling: string; confirmed: boolean }) => void;
}) {
  // §6: no default choice for a new sale; a previously confirmed choice is shown, but must be confirmed again here.
  const [handling, setHandling] = useState(s.taxConfirmed ? s.taxHandling : "");
  const [confirmed, setConfirmed] = useState(false);
  const canPublish = !busy && (!hasPaid || (!!handling && confirmed));
  const deadline = s.closesAt ? new Date(s.closesAt) : null;

  return (
    <div role="dialog" aria-modal="true" aria-label="Review your sale" className="fixed inset-0 z-50 bg-black/70 flex items-start sm:items-center justify-center p-4 overflow-y-auto">
      <div className="w-full max-w-lg rounded-2xl border border-gray-800 bg-gray-900 p-5 flex flex-col gap-4">
        <h2 className="text-xl font-bold">Review your sale</h2>
        <div className="flex flex-col gap-1 text-sm">
          <span className="font-semibold text-base">{s.title || "Untitled sale"}</span>
          {s.items.map((it, i) => {
            const net = Math.round(parseFloat(it.net || "0") * 100);
            const maxQty = limited[i] ? Math.min(Math.max(Number(it.perOrderLimit) || 1, 1), 100) : Number(NO_LIMIT);
            const sizes = it.variants.map((v) => v.label.trim()).filter(Boolean);
            const price = it.priceMode === "PAID" && net >= 50 ? priceForNet(net, maxQty) : null;
            return (
              <span key={i} className="text-gray-300">
                {it.name || "Unnamed item"} — {it.priceMode === "FREE" ? "free" : price ? `supporters pay ${money(price)} (you receive ${money(net)})` : "price not set"}
                {" · "}{sizes.length ? sizes.join(", ") : ONE_SIZE}
                {limited[i] && it.perOrderLimit ? ` · up to ${it.perOrderLimit} per order` : ""}
              </span>
            );
          })}
          {deadline && !Number.isNaN(deadline.getTime()) ? <span className="text-gray-300">Orders close: {deadline.toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span> : null}
          {s.redirectUrl.trim() ? <span className="text-gray-300 break-all">After-order link: {s.redirectUrl.trim()}</span> : null}
        </div>

        {hasPaid ? (
          <div className="flex flex-col gap-2.5 border-t border-gray-800 pt-4">
            <span className="font-semibold">Sales tax</span>
            <p className="text-sm text-gray-300">Daali doesn&apos;t calculate, collect separately or pay sales tax. Fundraiser merchandise isn&apos;t automatically tax-exempt. Check your state&apos;s rules.</p>
            <fieldset className="flex flex-col gap-2.5">
              <legend className="sr-only">How will sales tax be handled?</legend>
              {TAX.map(([v, text]) => (
                <label key={v} className="flex gap-2.5 items-start text-sm"><input type="radio" name="tax" className="mt-0.5 w-[18px] h-[18px]" checked={handling === v} onChange={() => { setHandling(v); setConfirmed(false); }} />{text}</label>
              ))}
            </fieldset>
            <label className="flex gap-2.5 items-start text-sm"><input type="checkbox" className="mt-0.5 w-[18px] h-[18px]" checked={confirmed} disabled={!handling} onChange={(e) => setConfirmed(e.target.checked)} />I confirm this is accurate and that sales tax is my organization&apos;s responsibility.</label>
          </div>
        ) : null}

        {error ? <div role="alert" className="rounded-lg p-3 text-sm bg-red-950/40 border border-red-900 text-red-200">{error}</div> : null}
        <div className="flex justify-end gap-2">
          <button onClick={onBack} disabled={busy} className="h-11 px-4 rounded-lg border border-gray-700 text-sm">Back</button>
          <button onClick={() => onPublish({ handling, confirmed })} disabled={!canPublish} className="h-11 px-5 rounded-lg bg-white text-gray-950 text-sm font-semibold disabled:opacity-50">{busy ? "Publishing…" : "Publish"}</button>
        </div>
      </div>
    </div>
  );
}
