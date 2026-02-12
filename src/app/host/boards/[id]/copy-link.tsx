"use client";

import { useState } from "react";

export default function CopyLinkButton({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    await navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="flex items-center gap-2">
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
  );
}
