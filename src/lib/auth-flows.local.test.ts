import { test, describe, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Daali Slice 1 S1.4 account flows against a LOCAL Supabase stack.
//
//   supabase start                       (supabase/config.toml in this repo)
//   node --env-file=.env.local --experimental-strip-types scripts/seed-local-auth.mts
//   DAALI_LOCAL_AUTH=1 node --env-file=.env.local --experimental-strip-types \
//     --experimental-test-module-mocks --import ./scripts/test-alias-only.mjs \
//     --test src/lib/auth-flows.local.test.ts
//
// SKIPPED unless DAALI_LOCAL_AUTH=1. When it is set, every URL must be
// loopback or the file throws before connecting to anything: these tests
// create and delete auth users.
//
// They drive Supabase exactly as the screens do (signInWithOtp, verifyOtp),
// read the local Mailpit inbox for codes and links, and run the app's real
// finalize against the local database. The screens' wiring is exercised
// separately in a browser walkthrough.
//
// Supabase limits one email per address per 60 seconds (config.toml), so a
// second run inside a minute fails on the fixture addresses.

const enabled = process.env.DAALI_LOCAL_AUTH === "1";
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const DB_URL = process.env.DATABASE_URL ?? "";
const MAILPIT = "http://127.0.0.1:54324";

const loopback = (u: string) => {
  try {
    return ["127.0.0.1", "localhost", "[::1]"].includes(new URL(u).hostname);
  } catch {
    return false;
  }
};
if (enabled && (!loopback(SUPABASE_URL) || !loopback(DB_URL))) {
  throw new Error("DAALI_LOCAL_AUTH=1 but the Supabase URL or DATABASE_URL is not loopback. Refusing.");
}

const prisma = enabled ? new PrismaClient({ datasources: { db: { url: DB_URL } } }) : null;
if (enabled) mock.module("@/lib/prisma", { namedExports: { prisma } });
const { finalizeOrganizerProfile } = enabled ? await import("./finalize-organizer.ts") : ({} as never);

const browser = () => createClient(SUPABASE_URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
const admin = () => createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });

async function userCount(): Promise<number> {
  const [{ n }] = await prisma!.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM auth.users`;
  return n;
}

async function userIdFor(where: { email?: string; phone?: string }): Promise<string | null> {
  const digits = where.phone?.replace(/^\+/, "") ?? null;
  const rows = await prisma!.$queryRaw<{ id: string }[]>`
    SELECT id::text AS id FROM auth.users
     WHERE (${where.email ?? null}::text IS NOT NULL AND lower(email) = lower(${where.email ?? null}))
        OR (${digits}::text IS NOT NULL AND phone = ${digits})`;
  return rows[0]?.id ?? null;
}

async function mailIds(address: string): Promise<string[]> {
  const res = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${address}"`)}`);
  const { messages } = (await res.json()) as { messages: { ID: string }[] | null };
  return (messages ?? []).map((m) => m.ID);
}

/**
 * The first email to `address` that was not in `seen` (the IDs present before
 * the send), waiting up to 30 seconds. Compared by message ID, not by time:
 * the mail container's clock can differ from this machine's.
 */
async function latestEmail(address: string, seen: string[]): Promise<{ code: string; tokenHash: string; html: string }> {
  for (let i = 0; i < 120; i++) {
    const fresh = (await mailIds(address)).find((id) => !seen.includes(id));
    if (fresh) {
      const msg = (await (await fetch(`${MAILPIT}/api/v1/message/${fresh}`)).json()) as { HTML: string };
      const code = /<strong>(\d{6})<\/strong>/.exec(msg.HTML)?.[1];
      const tokenHash = /token_hash=([^&"]+)/.exec(msg.HTML)?.[1];
      if (!code || !tokenHash) throw new Error("email has no code or token_hash");
      return { code, tokenHash, html: msg.HTML };
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`no email to ${address}`);
}

const created: string[] = [];
const unique = (tag: string) => `s14-${tag}-${randomUUID().slice(0, 8)}@example.com`;

describe("S1.4 account flows (local Supabase)", { skip: !enabled && "DAALI_LOCAL_AUTH not set" }, () => {
  let seeded: Record<string, string> = {};

  before(async () => {
    for (const [key, where] of Object.entries({
      "phone-1": { phone: "+15555550101" },
      "email-1": { email: "organizer.one@example.com" },
      "email-2": { email: "no.name@example.com" },
      "both-1": { email: "both.methods@example.com" },
    })) {
      const id = await userIdFor(where);
      if (!id) throw new Error(`fixture ${key} missing: run scripts/seed-local-auth.mts first`);
      seeded[key] = id;
    }
  });

  after(async () => {
    for (const id of created) {
      await prisma!.organizerProfile.deleteMany({ where: { userId: id } });
      await admin().auth.admin.deleteUser(id);
    }
    await prisma!.$disconnect();
  });

  // ── T4 ────────────────────────────────────────────────────────────────────
  test("T4: sign-in with an unknown email creates nothing and is refused as unknown", async () => {
    const before = await userCount();
    const { error } = await browser().auth.signInWithOtp({ email: unique("unknown"), options: { shouldCreateUser: false } });
    assert.equal(error?.code, "otp_disabled");
    assert.equal(await userCount(), before);
  });

  test("T4: sign-in with an unknown phone creates nothing and is refused as unknown", async () => {
    const before = await userCount();
    const { error } = await browser().auth.signInWithOtp({ phone: "+15555550199", options: { shouldCreateUser: false } });
    assert.equal(error?.code, "otp_disabled");
    assert.equal(await userCount(), before);
  });

  // ── existing phone-only users ─────────────────────────────────────────────
  test("a phone-only user signs in by phone on /sign-in and lands on the same user id", async () => {
    const before = await userCount();
    const hostBefore = await prisma!.host.findFirstOrThrow({ where: { supabaseUserId: seeded["phone-1"] } });
    const boardsBefore = await prisma!.board.findMany({ where: { hostId: hostBefore.id }, orderBy: { boardId: "asc" } });

    const c = browser();
    const sent = await c.auth.signInWithOtp({ phone: "+15555550101", options: { shouldCreateUser: false } });
    assert.equal(sent.error, null);
    const { data, error } = await c.auth.verifyOtp({ phone: "+15555550101", token: "101101", type: "sms" });
    assert.equal(error, null);
    assert.equal(data.user?.id, seeded["phone-1"]);

    // Finalize does not apply (no email), and nothing about the person moves.
    assert.equal(await finalizeOrganizerProfile(data.user), "not-applicable");
    assert.equal(await prisma!.organizerProfile.count({ where: { userId: seeded["phone-1"] } }), 0);
    assert.equal(await userCount(), before);
    assert.deepEqual(await prisma!.host.findFirstOrThrow({ where: { id: hostBefore.id } }), hostBefore);
    assert.deepEqual(await prisma!.board.findMany({ where: { hostId: hostBefore.id }, orderBy: { boardId: "asc" } }), boardsBefore);
  });

  // RECORDS TODAY'S BEHAVIOUR — flagged in the S1.4 report, not endorsed.
  // A phone-only person who types an email on /sign-in is not recognised: no
  // account has that email. Sign-in itself creates nothing. If they then tap
  // "Create an account", the Get started link creates a SECOND, unrelated user.
  // S1.5 (amended Oct 10) answers this two ways without changing it: the
  // unknown-email state now offers "Use your number instead." (T28), and a
  // phone-only account adds its email at /setup (T25).
  test("RECORD: a phone-only user entering an email on /sign-in — refused as unknown; 'Create an account' would make a second user", async () => {
    const theirEmail = unique("phone-only-person");
    const before = await userCount();

    const signIn = await browser().auth.signInWithOtp({ email: theirEmail, options: { shouldCreateUser: false } });
    assert.equal(signIn.error?.code, "otp_disabled", "sign-in refuses: unknown email");
    assert.equal(await userCount(), before, "sign-in creates nothing");

    const seen = await mailIds(theirEmail);
    const createPath = await browser().auth.signInWithOtp({ email: theirEmail, options: { shouldCreateUser: true } });
    assert.equal(createPath.error, null);
    const { code } = await latestEmail(theirEmail, seen);
    const { data } = await browser().auth.verifyOtp({ email: theirEmail, token: code, type: "email" });
    assert.ok(data.user);
    created.push(data.user.id);
    assert.notEqual(data.user.id, seeded["phone-1"], "a different user id from the phone-only user");
    assert.equal(await userCount(), before + 1, "a second user now exists for the same person");
  });

  // ── T1 ────────────────────────────────────────────────────────────────────
  test("T1 (code): Get started with a new email — one user, one profile after the code is confirmed", async () => {
    const email = unique("t1-code");
    const before = await userCount();
    const seen = await mailIds(email);
    const sent = await browser().auth.signInWithOtp({ email, options: { shouldCreateUser: true } });
    assert.equal(sent.error, null);

    // What exists BEFORE confirmation: Supabase writes an UNCONFIRMED auth user
    // when the email is sent. No profile exists yet.
    const pendingId = await userIdFor({ email });
    assert.ok(pendingId, "Supabase creates the unconfirmed user at send time");
    created.push(pendingId);
    const [pending] = await prisma!.$queryRaw<{ confirmed: boolean }[]>`
      SELECT email_confirmed_at IS NOT NULL AS confirmed FROM auth.users WHERE id = ${pendingId}::uuid`;
    assert.equal(pending.confirmed, false);
    assert.equal(await prisma!.organizerProfile.count({ where: { userId: pendingId } }), 0);

    const { code } = await latestEmail(email, seen);
    const { data, error } = await browser().auth.verifyOtp({ email, token: code, type: "email" });
    assert.equal(error, null);
    assert.equal(data.user?.id, pendingId);
    assert.ok(data.user?.email_confirmed_at);

    assert.equal(await finalizeOrganizerProfile(data.user), "created");
    const profile = await prisma!.organizerProfile.findUniqueOrThrow({ where: { userId: pendingId } });
    assert.equal(profile.createdVia, "SIGNUP");
    assert.equal(await userCount(), before + 1);
  });

  // ── T1 (link) + T10 ───────────────────────────────────────────────────────
  test("T1 (link) and T10: the link confirmed on another device signs THAT device in; finalize runs once", async () => {
    const email = unique("t10");
    const laptop = browser();
    const phone = browser();
    const seen = await mailIds(email);
    assert.equal((await laptop.auth.signInWithOtp({ email, options: { shouldCreateUser: true } })).error, null);
    const { tokenHash, html } = await latestEmail(email, seen);
    assert.match(html, /\/auth\/confirm\?token_hash=/, "the link goes to /auth/confirm with a token_hash");

    const { data, error } = await phone.auth.verifyOtp({ token_hash: tokenHash, type: "email" });
    assert.equal(error, null);
    assert.ok(data.user);
    created.push(data.user.id);
    assert.equal(await finalizeOrganizerProfile(data.user), "created");
    assert.equal(await finalizeOrganizerProfile(data.user), "existed", "a second finalize does nothing");
    assert.equal(await prisma!.organizerProfile.count({ where: { userId: data.user.id } }), 1);

    // The device that asked has no session: confirming elsewhere cannot sign it in.
    const { data: laptopSession } = await laptop.auth.getSession();
    assert.equal(laptopSession.session, null, "T10's 'original device continues' is not achievable this way");

    // A used link is refused, which /auth/confirm shows as "This link has expired."
    const reused = await browser().auth.verifyOtp({ token_hash: tokenHash, type: "email" });
    assert.ok(reused.error);
  });

  // ── T5 (email) ────────────────────────────────────────────────────────────
  test("T5 (email): Get started with an existing email signs in; no second user", async () => {
    const email = "no.name@example.com";
    const before = await userCount();
    const seen = await mailIds(email);
    assert.equal((await browser().auth.signInWithOtp({ email, options: { shouldCreateUser: true } })).error, null);
    assert.equal(await userCount(), before);
    const { code } = await latestEmail(email, seen);
    const { data } = await browser().auth.verifyOtp({ email, token: code, type: "email" });
    assert.equal(data.user?.id, seeded["email-2"]);
    assert.equal(await userCount(), before);
    assert.equal(await finalizeOrganizerProfile(data.user), "created", "an existing user without a profile gets one");
    await prisma!.organizerProfile.delete({ where: { userId: seeded["email-2"] } }); // keep the fixture's shape
  });

  // ── T6 ────────────────────────────────────────────────────────────────────
  test("T6: finalize twice — and twice at once — leaves exactly one profile; a BACKFILL row is never rewritten", async () => {
    const { data } = await admin().auth.admin.createUser({ email: unique("t6"), email_confirm: true });
    assert.ok(data.user);
    created.push(data.user.id);
    const results = await Promise.all([finalizeOrganizerProfile(data.user), finalizeOrganizerProfile(data.user)]);
    assert.deepEqual([...results].sort(), ["created", "existed"]);
    assert.equal(await finalizeOrganizerProfile(data.user), "existed");
    assert.equal(await prisma!.organizerProfile.count({ where: { userId: data.user.id } }), 1);

    const backfilled = await prisma!.organizerProfile.findUniqueOrThrow({ where: { userId: seeded["email-1"] } });
    const { data: e1 } = await admin().auth.admin.getUserById(seeded["email-1"]);
    assert.equal(await finalizeOrganizerProfile(e1.user), "existed");
    assert.deepEqual(await prisma!.organizerProfile.findUniqueOrThrow({ where: { userId: seeded["email-1"] } }), backfilled);
  });

  // ── T11 (email + phone) ───────────────────────────────────────────────────
  test("T11 (email and phone): one person signing in by phone and by email resolves to one user id", async () => {
    const before = await userCount();
    const byPhone = browser();
    assert.equal((await byPhone.auth.signInWithOtp({ phone: "+15555550104", options: { shouldCreateUser: false } })).error, null);
    const p = await byPhone.auth.verifyOtp({ phone: "+15555550104", token: "104104", type: "sms" });

    const email = "both.methods@example.com";
    const seen = await mailIds(email);
    assert.equal((await browser().auth.signInWithOtp({ email, options: { shouldCreateUser: false } })).error, null);
    const { code } = await latestEmail(email, seen);
    const e = await browser().auth.verifyOtp({ email, token: code, type: "email" });

    assert.equal(p.data.user?.id, seeded["both-1"]);
    assert.equal(e.data.user?.id, seeded["both-1"]);
    assert.equal(await userCount(), before);
  });

  // ── wrong code ────────────────────────────────────────────────────────────
  test("a wrong code is refused and creates nothing", async () => {
    const before = await userCount();
    const c = browser();
    assert.equal((await c.auth.signInWithOtp({ phone: "+15555550103", options: { shouldCreateUser: false } })).error, null);
    const { error } = await c.auth.verifyOtp({ phone: "+15555550103", token: "000000", type: "sms" });
    assert.ok(error);
    assert.equal(await userCount(), before);
  });
});

void (null as unknown as SupabaseClient);
