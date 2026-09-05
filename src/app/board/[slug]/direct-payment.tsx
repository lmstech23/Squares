"use client";

// The host's direct-payment handles, with the amount to send.
//
// ONE COPY. This markup existed three times — inline in the claim sheet before
// submitting, inline in the donate sheet before submitting, and again in the
// donate sheet's post-submit screen. Three copies of a list of the host's
// personal payment handles is three places for one of them to be forgotten
// when a handle is added.
//
// Board v2 §6C: only methods the host actually configured are offered. A null
// handle is absent, never a greyed-out row.

export interface Handles {
  venmo: string | null;
  zelle: string | null;
  cashapp: string | null;
  paypal: string | null;
}

export function hasAnyHandle(h: Handles): boolean {
  return Boolean(h.zelle || h.cashapp || h.venmo || h.paypal);
}

export default function DirectPaymentHandles({
  amountLabel,
  handles,
}: {
  /**
   * Pre-formatted, because the callers format money differently.
   *
   * NULL SUPPRESSES THE LEAD LINE. The post-submit screens now state the
   * amount themselves ("Send $25", "Payment due: $40") directly above this, so
   * the built-in "Send $25 to:" repeated it one line later. The pre-submit
   * sheets still pass a label — nothing above them says it.
   */
  amountLabel: string | null;
  handles: Handles;
}) {
  return (
    <>
      {amountLabel && <p className="text-sm mb-2">Send {amountLabel} to:</p>}
      <ul className="space-y-1 text-sm">
        {handles.zelle && (
          <li>
            <span className="text-gray-500">Zelle</span> — {handles.zelle}
          </li>
        )}
        {handles.cashapp && (
          <li>
            <span className="text-gray-500">Cash App</span> — {handles.cashapp}
          </li>
        )}
        {handles.venmo && (
          <li>
            <span className="text-gray-500">Venmo</span> — {handles.venmo}
          </li>
        )}
        {handles.paypal && (
          <li>
            <span className="text-gray-500">PayPal</span> — {handles.paypal}
          </li>
        )}
      </ul>
    </>
  );
}
