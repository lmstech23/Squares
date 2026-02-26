"use client";

import { useState } from "react";
import { QRCodeSVG } from "qrcode.react";

export default function ShareCard({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    await navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900 p-4 mb-6">
      <p className="text-xs text-gray-500 mb-1">Share this link with your group</p>
      <p className="text-[11px] text-gray-600 mb-4">
        Send the link or let players scan the QR code to join instantly.
      </p>

      <div className="flex flex-col sm:flex-row sm:items-center gap-4">
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <code className="flex-1 text-xs text-gray-400 bg-gray-950 rounded-lg px-3 py-2.5 truncate border border-gray-800">
            {url}
          </code>
          <button
            onClick={handleCopy}
            className="shrink-0 rounded-lg bg-white text-gray-950 px-4 py-2.5 text-sm font-medium hover:bg-gray-200 transition-colors"
          >
            {copied ? "Copied!" : "Copy Link"}
          </button>
        </div>

        <div className="flex flex-col items-center sm:items-end shrink-0">
          <div className="bg-white rounded-lg p-2 shadow-lg">
            <QRCodeSVG
              value={url}
              size={120}
              className="block sm:w-[120px] sm:h-[120px] w-[140px] h-[140px]"
            />
          </div>
          <p className="text-[11px] text-gray-600 mt-2 text-center">
            Scan to join this board
          </p>
        </div>
      </div>
    </div>
  );
}