"use client";

import { useCallback, useRef, useState } from "react";

// Cloudflare Turnstile for the account screens — Daali Slice 1, S1.8a (Auth
// spec, "Abuse controls": Supabase CAPTCHA protection on, with Turnstile).
//
// WHICH CALLS NEED A TOKEN was measured on the local stack with CAPTCHA on,
// not assumed: signInWithOtp (email and phone, create or not — so /start,
// /sign-in, the create path in /sign-in's unknown-email state, and their
// Resend). verifyOtp, updateUser, exchangeCodeForSession and the Google
// redirect are not checked, so /setup and the code steps' verify carry none.
//
// SINGLE USE. `take()` hands over the current token and resets the widget at
// once, so a retry or Resend always gets a fresh one. A widget still solving
// is given up to 10 seconds; if it fails, or no token arrives, `take()` says so
// and the caller does not send the request: the spec's "Please try again."
//
// The site key comes from NEXT_PUBLIC_TURNSTILE_SITE_KEY. Unset, no widget is
// rendered and no token is sent (CAPTCHA off). Locally it is one of
// Cloudflare's published TEST site keys; the matching test secret is given to
// the local Supabase stack, never to the app or the repo. INTERIM placement
// and styling, pending design review.

type Turnstile = {
  render(el: HTMLElement, options: Record<string, unknown>): string;
  reset(widgetId?: string): void;
  remove(widgetId: string): void;
};

declare global {
  interface Window {
    turnstile?: Turnstile;
  }
}

const SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? "";
const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

let scriptPromise: Promise<void> | null = null;
function loadTurnstile(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  scriptPromise ??= new Promise<void>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = SCRIPT_SRC;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => {
      scriptPromise = null;
      reject(new Error("Turnstile failed to load"));
    };
    document.head.appendChild(s);
  });
  return scriptPromise;
}

export type CaptchaTake = { ok: true; token?: string } | { ok: false };

export function useCaptcha() {
  const enabled = SITE_KEY !== "";
  const [failed, setFailed] = useState(false);
  const widgetId = useRef<string | null>(null);
  const token = useRef<string | null>(null);
  const errored = useRef(false);

  // A callback ref: each screen that shows the widget gets its own instance,
  // and the previous one is removed when that screen goes away.
  const container = useCallback(
    (el: HTMLDivElement | null) => {
      if (widgetId.current && window.turnstile) window.turnstile.remove(widgetId.current);
      widgetId.current = null;
      token.current = null;
      errored.current = false;
      if (!el || !enabled) return;
      loadTurnstile().then(
        () => {
          if (!el.isConnected || !window.turnstile) return;
          widgetId.current = window.turnstile.render(el, {
            sitekey: SITE_KEY,
            callback: (t: string) => {
              token.current = t;
              errored.current = false;
              setFailed(false);
            },
            "error-callback": () => {
              token.current = null;
              errored.current = true;
              setFailed(true);
            },
            "expired-callback": () => {
              token.current = null;
            },
          });
        },
        () => {
          errored.current = true;
          setFailed(true);
        }
      );
    },
    [enabled]
  );

  const reset = useCallback(() => {
    token.current = null;
    errored.current = false;
    if (widgetId.current && window.turnstile) window.turnstile.reset(widgetId.current);
  }, []);

  /**
   * The current token, used up: the widget resets so it is never sent twice.
   * Waits up to 10 seconds for a widget that is still solving.
   */
  const take = useCallback(async (): Promise<CaptchaTake> => {
    if (!enabled) return { ok: true };
    for (let waited = 0; !token.current && !errored.current && waited < 10_000; waited += 200) {
      await new Promise((r) => setTimeout(r, 200));
    }
    const t = token.current;
    if (!t) return { ok: false };
    reset();
    return { ok: true, token: t };
  }, [enabled, reset]);

  const widget = enabled ? <div ref={container} data-captcha="turnstile" /> : null;
  return { enabled, failed, take, reset, widget };
}
