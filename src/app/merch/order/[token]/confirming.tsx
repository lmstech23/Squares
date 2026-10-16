"use client";

import { useEffect, useState } from "react";

// Polls the server, which re-checks Stripe. Navigates ONLY when the server
// reports PAID and hands back the destination from the order row.
export default function Confirming({ token }: { token: string }) {
  const [gaveUp, setGaveUp] = useState(false);
  useEffect(() => {
    let stop = false;
    const started = Date.now();
    (async function loop() {
      while (!stop && Date.now() - started < 60_000) {
        try {
          const res = await fetch(`/api/merch/orders/${token}/status`, { cache: "no-store" });
          const data = await res.json();
          if (["PAID", "PARTIALLY_REFUNDED", "REFUNDED", "CONFIRMED_FREE"].includes(data.status)) {
            window.location.replace(data.next ?? `/merch/order/${token}`);
            return;
          }
          if (["EXPIRED", "CANCELLED"].includes(data.status)) {
            window.location.replace(`/merch/order/${token}`);
            return;
          }
        } catch {
          /* keep trying */
        }
        await new Promise((r) => setTimeout(r, 3000));
      }
      if (!stop) setGaveUp(true);
    })();
    return () => {
      stop = true;
    };
  }, [token]);

  return gaveUp ? (
    <>
      <h1 className="text-xl font-bold">Still confirming your payment</h1>
      <p className="text-sm text-gray-300">This is taking longer than usual. If your payment went through, you&apos;ll get a receipt by email with a link to continue. <a className="text-green-300" href={`/merch/order/${token}`}>Check your order</a></p>
    </>
  ) : (
    <>
      <h1 className="text-xl font-bold" role="status">Confirming your payment…</h1>
      <p className="text-sm text-gray-300">Keep this page open. You&apos;ll be sent on automatically.</p>
    </>
  );
}
