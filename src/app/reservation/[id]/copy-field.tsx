"use client";

import { useState } from "react";

// A value the contributor has to retype into a banking app, with one tap to
// copy it.
//
// THE FALLBACK IS THE POINT. `navigator.clipboard` needs a secure context and a
// permission, and it is absent or refused often enough on mobile in-app
// browsers — which is where this page will mostly be opened, from an email —
// that a silent failure would be common. The value is therefore always visible
// and always selectable; the button is a convenience over it, never the only
// way to get the text.

export default function CopyField({
  label,
  value,
  hint,
  size = "normal",
}: {
  label: string;
  value: string;
  hint?: string;
  /** `large` for the reference code and the amount — the two things being read
      off this screen into another app. */
  size?: "normal" | "large";
}) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setState("copied");
      setTimeout(() => setState("idle"), 2000);
    } catch {
      // No clipboard, or permission refused. Say so rather than showing
      // "Copied!" over a clipboard that did not change.
      setState("failed");
    }
  }

  return (
    <div className="rounded-lg border border-tone-800 bg-tone-900 px-3.5 py-3">
      <p className="text-[11px] uppercase tracking-wider text-tone-500">{label}</p>
      <div className="mt-1 flex items-center justify-between gap-3">
        <span
          className={
            size === "large"
              ? "font-bold tabular-nums tracking-wider text-2xl text-tone-fg select-all break-all"
              : "text-base text-tone-100 select-all break-all"
          }
        >
          {value}
        </span>
        <button
          type="button"
          onClick={copy}
          className="shrink-0 rounded-lg border border-tone-700 px-3 py-1.5 text-xs text-tone-300 hover:border-tone-500 transition-colors"
        >
          {state === "copied" ? "Copied" : state === "failed" ? "Select it" : "Copy"}
        </button>
      </div>
      {hint && <p className="mt-1.5 text-xs text-tone-500 leading-relaxed">{hint}</p>}
      {state === "failed" && (
        <p className="mt-1.5 text-xs text-caution-300/80">
          This browser blocked copying. Press and hold the text above to select it.
        </p>
      )}
    </div>
  );
}
