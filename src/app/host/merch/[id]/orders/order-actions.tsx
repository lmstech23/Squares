"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function OrderActions(props: { listingId: string; orderId: string; canHandOut: boolean; canCancelFree: boolean; canResend: boolean; receiptWasSent: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function act(action: string, question?: string) {
    if (question && !confirm(question)) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/host/merch/${props.listingId}/orders/${props.orderId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) setErr(((await res.json().catch(() => ({}))) as { error?: string }).error ?? "Couldn't update.");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-1.5 items-start">
      {props.canHandOut ? <button disabled={busy} onClick={() => act("handed_out")} className="h-9 px-3 rounded-lg bg-white text-gray-950 text-xs font-semibold">Mark handed out</button> : null}
      {props.canResend ? (
        <button
          disabled={busy}
          onClick={() => act("resend_receipt", props.receiptWasSent ? "This sends another copy of the receipt. The buyer may get two. Send it?" : "Send the receipt again? If the first one did arrive, the buyer may get two.")}
          className="h-9 px-3 rounded-lg border border-gray-700 text-xs"
        >
          Resend receipt
        </button>
      ) : null}
      {props.canCancelFree ? <button disabled={busy} onClick={() => act("cancel_free", "Cancel this free reservation? The items go back into stock.")} className="text-xs text-gray-400 underline">Cancel reservation</button> : null}
      {err ? <span className="text-xs text-red-300">{err}</span> : null}
    </div>
  );
}
