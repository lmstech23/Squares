"use client";

import { useState } from "react";

// One ticket, individually shareable — fundraiser-board-v2.md §6.
//
// The family case: mom buys four, forwards one to her daughter and one to her
// cousin. Each row therefore carries its own link to a single-ticket page, not
// a link back to the whole set — forwarding the set would hand over all four.

interface Props {
  token: string;
  ordinal: number;
  total: number;
  used: boolean;
  label: string | null;
}

export default function PassRow({ token, ordinal, total, used, label }: Props) {
  const [copied, setCopied] = useState(false);

  const url =
    typeof window !== "undefined"
      ? `${window.location.origin}/tickets/${token}`
      : `/tickets/${token}`;

  async function share() {
    // The native sheet is the right thing on a phone, which is where this is
    // opened. Clipboard is the fallback everywhere else.
    try {
      if (navigator.share) {
        await navigator.share({ title: `Ticket ${ordinal} of ${total}`, url });
        return;
      }
    } catch {
      // Dismissed or unavailable — fall through to copying.
    }

    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked. The link is visible below, so nothing is lost.
    }
  }

  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">
            Ticket {ordinal} of {total}
          </p>
          {label && <p className="text-xs text-gray-500 mt-0.5">{label}</p>}
          {used && (
            <p className="text-xs text-gray-500 mt-0.5">
              Already scanned at the gate
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={share}
          className="flex-shrink-0 rounded-lg border border-gray-700 px-3 py-1.5 text-xs text-gray-300 hover:text-white hover:border-gray-600 transition-colors"
        >
          {copied ? "Link copied" : "Share"}
        </button>
      </div>

      <div className="mt-3 flex justify-center">
        {/* eslint-disable-next-line @next/next/no-img-element -- the QR is
            generated per token by an API route, not a static asset, and must
            render identically here and in the email. */}
        <img
          src={`/api/tickets/${encodeURIComponent(token)}/qr`}
          alt={`Ticket ${ordinal} QR code`}
          width={200}
          height={200}
          className={`rounded bg-white p-2 ${used ? "opacity-40" : ""}`}
        />
      </div>
    </div>
  );
}
