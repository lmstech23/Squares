import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";
import { createClient } from "@supabase/supabase-js";

// The before-user-created hook (T3) and CAPTCHA (T7) against the LOCAL stack
// — Daali Slice 1, S1.8a. Run with CAPTCHA and the hook ON (supabase/config.toml)
// and the stack started with one of Cloudflare's Turnstile TEST secrets:
//
//   SUPABASE_AUTH_CAPTCHA_SECRET=1x0000000000000000000000000000000AA  (always passes)
//     DAALI_LOCAL_AUTH=1 DAALI_CAPTCHA_SECRET_MODE=pass node --env-file=.env.local \
//       --experimental-strip-types --experimental-test-module-mocks \
//       --import ./scripts/test-alias-only.mjs --test src/lib/hook-captcha.local.test.ts
//   SUPABASE_AUTH_CAPTCHA_SECRET=2x0000000000000000000000000000000AA  (always fails)
//     … DAALI_CAPTCHA_SECRET_MODE=fail …
//
// The test site keys produce Cloudflare's dummy token below; only the TEST
// secrets accept it. SKIPPED unless DAALI_LOCAL_AUTH=1; refuses any non-loopback
// target.

const enabled = process.env.DAALI_LOCAL_AUTH === "1";
const MODE = process.env.DAALI_CAPTCHA_SECRET_MODE === "fail" ? "fail" : "pass";
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
const DB_URL = process.env.DATABASE_URL ?? "";
const DUMMY_TOKEN = "XXXX.DUMMY.TOKEN.XXXX";

const loopback = (u: string) => {
  try {
    return ["127.0.0.1", "localhost", "[::1]"].includes(new URL(u).hostname);
  } catch {
    return false;
  }
};
if (enabled && (!loopback(SUPABASE_URL) || !loopback(DB_URL))) throw new Error("not the local stack: refusing");

const db = enabled ? new PrismaClient({ datasources: { db: { url: DB_URL } } }) : null;
const client = () => createClient(SUPABASE_URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
const users = async (where: string) =>
  Number((await db!.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM auth.users WHERE ${where}`))[0].n);
const hook = async (event: unknown) =>
  (await db!.$queryRaw<{ r: unknown }[]>`SELECT public.hook_before_user_created(${JSON.stringify(event)}::jsonb) AS r`)[0].r;
const created: string[] = [];

describe(`hook and CAPTCHA (local stack, test secret: always ${MODE})`, { skip: !enabled && "DAALI_LOCAL_AUTH not set" }, () => {
  after(async () => {
    if (created.length) await db!.$executeRawUnsafe(`DELETE FROM auth.users WHERE email = ANY($1::text[])`, created);
    await db!.$disconnect();
  });

  // ── the function itself ───────────────────────────────────────────────────
  test("contract: rejects no email and anonymous with 403; allows an email signup; writes nothing", async () => {
    const before = await users("true");
    const base = { metadata: { name: "before-user-created" }, user: { app_metadata: { provider: "email" }, identities: [], is_anonymous: false } };
    assert.deepEqual(await hook({ ...base, user: { ...base.user, email: "", phone: "15555550191", app_metadata: { provider: "phone" } } }), {
      error: { http_code: 403, message: "An email address is required to create a Daali account." },
    });
    assert.deepEqual(await hook({ ...base, user: { ...base.user, email: "a@example.com", is_anonymous: true } }), {
      error: { http_code: 403, message: "Anonymous sign-ins are not allowed." },
    });
    assert.deepEqual(await hook({ ...base, user: { ...base.user, email: "", app_metadata: { provider: "anonymous" } } }), {
      error: { http_code: 403, message: "Anonymous sign-ins are not allowed." },
    });
    assert.deepEqual(await hook({ ...base, user: { ...base.user, email: "new.person@example.com" } }), {});
    assert.equal(await users("true"), before);
  });

  test("privileges: only supabase_auth_admin (and the owner) may execute it", async () => {
    const [r] = await db!.$queryRaw<{ anon: boolean; authenticated: boolean; admin: boolean; pub: boolean }[]>`
      SELECT has_function_privilege('anon', 'public.hook_before_user_created(jsonb)', 'EXECUTE') AS anon,
             has_function_privilege('authenticated', 'public.hook_before_user_created(jsonb)', 'EXECUTE') AS authenticated,
             has_function_privilege('supabase_auth_admin', 'public.hook_before_user_created(jsonb)', 'EXECUTE') AS admin,
             EXISTS (SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a
                      WHERE p.oid = 'public.hook_before_user_created(jsonb)'::regprocedure AND a.grantee = 0) AS pub`;
    assert.deepEqual(r, { anon: false, authenticated: false, admin: true, pub: false });
  });

  // ── T7: CAPTCHA ───────────────────────────────────────────────────────────
  test("T7: every checked call without a token is refused (captcha_failed), and nothing is created", async () => {
    const email = `s18a-nocaptcha-${randomUUID().slice(0, 8)}@example.com`;
    const calls = [
      await client().auth.signInWithOtp({ email, options: { shouldCreateUser: true } }),
      await client().auth.signInWithOtp({ email: "organizer.one@example.com", options: { shouldCreateUser: false } }),
      await client().auth.signInWithOtp({ phone: "+15555550102", options: { shouldCreateUser: false } }),
    ];
    for (const r of calls) assert.equal(r.error?.code, "captcha_failed", r.error?.message);
    assert.equal(await users(`email = '${email}'`), 0);
  });

  test(`T7: with the dummy token, the always-${MODE} secret ${MODE === "pass" ? "lets the call through" : "refuses it too"}`, async () => {
    const email = `s18a-token-${randomUUID().slice(0, 8)}@example.com`;
    const r = await client().auth.signInWithOtp({ email, options: { shouldCreateUser: true, captchaToken: DUMMY_TOKEN } });
    if (MODE === "pass") {
      assert.equal(r.error, null);
      created.push(email);
      assert.equal(await users(`email = '${email}'`), 1, "Get started creates the (unconfirmed) user: the hook allowed it");
    } else {
      assert.equal(r.error?.code, "captcha_failed", r.error?.message);
      assert.equal(await users(`email = '${email}'`), 0);
    }
  });

  // ── T3: the hook, end to end ──────────────────────────────────────────────
  test("T3: a direct /auth/v1/otp with only a phone and create_user: true is rejected by the hook; no user appears", { skip: MODE === "fail" && "needs the always-pass secret" }, async () => {
    const phone = "+15555550191";
    const res = await fetch(`${SUPABASE_URL}/auth/v1/otp`, {
      method: "POST",
      headers: { apikey: ANON, "Content-Type": "application/json" },
      body: JSON.stringify({ phone, create_user: true, gotrue_meta_security: { captcha_token: DUMMY_TOKEN } }),
    });
    const body = (await res.json()) as { msg?: string; message?: string };
    assert.equal(res.status, 403);
    assert.match(body.msg ?? body.message ?? "", /email address is required/i);
    assert.equal(await users(`phone = '15555550191'`), 0);
  });

  test("T3: an anonymous sign-in is refused; no user appears", { skip: MODE === "fail" && "needs the always-pass secret" }, async () => {
    const before = await users("is_anonymous");
    const r = await client().auth.signInAnonymously({ options: { captchaToken: DUMMY_TOKEN } });
    assert.ok(r.error, "refused");
    assert.equal(await users("is_anonymous"), before);
  });
});
