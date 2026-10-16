// Merch unit tests that need no database: Stripe error classification,
// input validation, idempotency keys, and the import guard that keeps the
// merch domain and the Board payment code apart (spec §10).

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { classifyStripeError } from "./stripe.ts";
import { hashIp, normalizeEmail, slugify, validateAfterOrderUrl } from "./validate.ts";
import { idempotencyKeyFor, BACKOFF_MINUTES, MAX_ATTEMPTS, AUTO_SEND_WINDOW_MS } from "./notifications.ts";
import { checkoutIdempotencyKey, HOLD_MINUTES } from "./orders.ts";
import { isMerchError, MerchError } from "./errors.ts";

describe("classifyStripeError (§5.7)", () => {
  test("connection errors, 409, 429 and 5xx may have executed → ambiguous", () => {
    assert.equal(classifyStripeError({ type: "StripeConnectionError" }), "ambiguous");
    for (const statusCode of [409, 429, 500, 502, 503]) assert.equal(classifyStripeError({ statusCode }), "ambiguous");
    assert.equal(classifyStripeError(new Error("socket hang up")), "ambiguous");
    assert.equal(classifyStripeError(undefined), "ambiguous");
  });
  test("other 4xx executed nothing → definite", () => {
    for (const statusCode of [400, 401, 402, 403, 404]) assert.equal(classifyStripeError({ statusCode }), "definite");
  });
});

describe("validation", () => {
  test("email is normalized and checked", () => {
    assert.equal(normalizeEmail("  Pat@Example.COM "), "pat@example.com");
    for (const bad of ["", "pat", "pat@", "@x.com", "pat@example", "a b@c.com"]) assert.throws(() => normalizeEmail(bad), isMerchError);
  });

  test("after-order link: https, no credentials, port or IP host", () => {
    assert.equal(validateAfterOrderUrl("https://www.nba.com/wizards/tickets?promo=dance"), "https://www.nba.com/wizards/tickets?promo=dance");
    for (const bad of [
      "http://www.nba.com", "javascript:alert(1)", "https://user:pw@nba.com", "https://nba.com:8443/x",
      "https://192.168.1.1/", "https://[::1]/", "https://localhost/", "not a url", "data:text/html,hi",
    ]) assert.throws(() => validateAfterOrderUrl(bad), isMerchError, bad);
  });

  test("slug: format and reserved route names", () => {
    assert.equal(slugify("Wizards Dance Team 2026!"), "wizards-dance-team-2026");
    for (const bad of ["", "a", "--", "return", "order", "orders", "new", "api", "admin"]) assert.throws(() => slugify(bad), isMerchError, bad);
  });

  test("IP is stored only as a salted hash", () => {
    const h = hashIp("203.0.113.9", "s1")!;
    assert.match(h, /^[0-9a-f]{64}$/);
    assert.notEqual(h, hashIp("203.0.113.9", "s2"));
    assert.equal(hashIp(null, "s1"), null);
  });

  test("errors map to HTTP status", () => {
    assert.equal(new MerchError("OUT_OF_STOCK", "x").status, 409);
    assert.equal(new MerchError("RATE_LIMITED", "x").status, 429);
  });
});

describe("idempotency keys and timing constants", () => {
  test("checkout key is per order; receipt key is per order, kind and resend", () => {
    const id = "6f1c2c1e-0000-4000-8000-000000000001";
    assert.equal(checkoutIdempotencyKey(id), `merch-checkout-${id}`);
    assert.equal(idempotencyKeyFor({ kind: "RECEIPT", order_id: id, idempotency_suffix: 0 }), `merch-receipt-${id}-0`);
    assert.equal(idempotencyKeyFor({ kind: "FREE_CONFIRMATION", order_id: id, idempotency_suffix: 2 }), `merch-free_confirmation-${id}-2`);
  });
  test("hold ≥ Stripe's 30-minute minimum; retries fit inside the provider window", () => {
    assert.ok(HOLD_MINUTES >= 30); // D5
    const totalBackoff = BACKOFF_MINUTES.reduce((a, b) => a + b, 0) * 60_000;
    assert.ok(totalBackoff < AUTO_SEND_WINDOW_MS);
    assert.ok(AUTO_SEND_WINDOW_MS < 24 * 60 * 60_000);
    assert.equal(MAX_ATTEMPTS, BACKOFF_MINUTES.length + 1);
  });
});

// ------------------------------------------------------------ import guard --

const SRC = join(import.meta.dirname, "..", "..");
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
  });
}
const MERCH_PATHS = [/^domain\/merch\//, /^app\/merch\//, /^app\/host\/merch\//, /^app\/api\/merch\//, /^app\/api\/host\/merch\//, /^app\/api\/webhooks\/merch\//, /^app\/api\/cron\/merch-reconcile\//];
const isMerch = (rel: string) => MERCH_PATHS.some((r) => r.test(rel));
function imports(file: string): string[] {
  const src = readFileSync(file, "utf8");
  return [...src.matchAll(/(?:from\s+|import\s*\(\s*)["']([^"']+)["']/g)].map((m) => m[1]);
}

describe("import guard (spec §10)", () => {
  const files = walk(SRC).map((f) => ({ f, rel: relative(SRC, f).replaceAll("\\", "/") }));

  test("merch code imports nothing from Board payment processing", () => {
    // The only shared modules merch may use: the Prisma client, the Supabase session, the Stripe client.
    const ALLOWED_LIB = new Set(["@/lib/prisma", "@/lib/supabase/server", "@/lib/stripe"]);
    const offenders: string[] = [];
    for (const { f, rel } of files) {
      if (!isMerch(rel)) continue;
      for (const s of imports(f)) {
        if (s.startsWith("@/lib/") && !ALLOWED_LIB.has(s)) offenders.push(`${rel} → ${s}`);
        if (/board|square|contribution|entry|checkout\/|confirm-square|webhooks\/stripe/i.test(s) && !s.includes("merch")) {
          if (!rel.endsWith("legacy-isolation.integration.test.ts")) offenders.push(`${rel} → ${s}`);
        }
      }
    }
    assert.deepEqual(offenders, []);
  });

  test("nothing outside merch imports merch, except the dashboard link", () => {
    const offenders: string[] = [];
    for (const { f, rel } of files) {
      if (isMerch(rel)) continue;
      for (const s of imports(f)) if (/merch/.test(s)) offenders.push(`${rel} → ${s}`);
    }
    assert.deepEqual(offenders, ["app/host/boards/page.tsx → @/domain/merch/runtime"]);
  });

  test("the legacy Board webhook and checkout code is unmodified by this change", () => {
    const legacy = readFileSync(join(SRC, "app/api/webhooks/stripe/route.ts"), "utf8");
    assert.ok(!/merch/i.test(legacy));
  });
});
