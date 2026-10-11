import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Daali Slice 1 S1.5 — /setup's Supabase calls against a LOCAL Supabase stack:
// attaching a phone (updateUser + phone_change) and, for existing phone-only
// accounts, attaching a first email (updateUser + email_change).
//
//   supabase start                       (supabase/config.toml in this repo)
//   node --env-file=.env.local --experimental-strip-types scripts/seed-local-auth.mts
//   DAALI_LOCAL_AUTH=1 node --env-file=.env.local --experimental-strip-types \
//     --experimental-test-module-mocks --import ./scripts/test-alias-only.mjs \
//     --test src/lib/setup-flows.local.test.ts
//
// SKIPPED unless DAALI_LOCAL_AUTH=1; refuses any non-loopback target. Re-seed
// before each run: these tests attach emails and numbers to the fixtures.
// T27 waits twice for Supabase's 60-second email limit (about two minutes).

const enabled = process.env.DAALI_LOCAL_AUTH === "1";
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
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
const browser = () => createClient(SUPABASE_URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } });

async function mailIds(address: string): Promise<string[]> {
  const res = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${address}"`)}`);
  const { messages } = (await res.json()) as { messages: { ID: string }[] | null };
  return (messages ?? []).map((m) => m.ID);
}

async function newMail(address: string, seen: string[]): Promise<{ code: string; tokenHash: string; html: string; subject: string }> {
  for (let i = 0; i < 120; i++) {
    const id = (await mailIds(address)).find((x) => !seen.includes(x));
    if (id) {
      const m = (await (await fetch(`${MAILPIT}/api/v1/message/${id}`)).json()) as { HTML: string; Subject: string };
      const code = /<strong>(\d{6})<\/strong>/.exec(m.HTML)?.[1];
      const tokenHash = /token_hash=([^&"]+)/.exec(m.HTML)?.[1];
      if (!code || !tokenHash) throw new Error("email has no code or token_hash");
      return { code, tokenHash, html: m.HTML, subject: m.Subject };
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`no email to ${address}`);
}

async function phoneSession(phone: string, code: string): Promise<{ c: SupabaseClient; id: string }> {
  const c = browser();
  const sent = await c.auth.signInWithOtp({ phone, options: { shouldCreateUser: false } });
  if (sent.error) throw sent.error;
  const v = await c.auth.verifyOtp({ phone, token: code, type: "sms" });
  if (v.error || !v.data.user) throw v.error ?? new Error("no user");
  return { c, id: v.data.user.id };
}

async function emailSession(email: string): Promise<{ c: SupabaseClient; id: string }> {
  const c = browser();
  const seen = await mailIds(email);
  const sent = await c.auth.signInWithOtp({ email, options: { shouldCreateUser: false } });
  if (sent.error) throw sent.error;
  const { code } = await newMail(email, seen);
  const v = await c.auth.verifyOtp({ email, token: code, type: "email" });
  if (v.error || !v.data.user) throw v.error ?? new Error("no user");
  return { c, id: v.data.user.id };
}

type AuthRow = { email: string | null; new_email: string | null; phone: string | null; new_phone: string | null; email_ok: boolean; phone_ok: boolean };
async function authRow(id: string): Promise<AuthRow> {
  const [r] = await prisma!.$queryRaw<AuthRow[]>`
    SELECT email, NULLIF(email_change, '') AS new_email, phone, NULLIF(phone_change, '') AS new_phone,
           email_confirmed_at IS NOT NULL AS email_ok, phone_confirmed_at IS NOT NULL AS phone_ok
      FROM auth.users WHERE id = ${id}::uuid`;
  return r;
}

async function userCount(): Promise<number> {
  const [{ n }] = await prisma!.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM auth.users`;
  return n;
}

/** Everything about this user's legacy footprint that must not move. */
async function legacySnapshot(userId: string) {
  const host = await prisma!.host.findFirstOrThrow({ where: { supabaseUserId: userId } });
  const ownedBoards = await prisma!.board.findMany({
    where: { hostId: host.id },
    select: { boardId: true, hostId: true, status: true, slug: true },
    orderBy: { boardId: "asc" },
  });
  const grants = await prisma!.boardCollaborator.findMany({ where: { hostId: host.id }, orderBy: { id: "asc" } });
  const onOwned = await prisma!.boardCollaborator.findMany({
    where: { boardId: { in: ownedBoards.map((b) => b.boardId) } },
    orderBy: { id: "asc" },
  });
  return { host, ownedBoards, grants, onOwned };
}

/** Supabase allows one SMS per number every 5 seconds (config.toml max_frequency). */
const smsGap = () => new Promise((r) => setTimeout(r, 6_000));

/** "Come back later": a new client resuming the session the browser kept. */
async function resume(c: SupabaseClient): Promise<SupabaseClient> {
  const { data } = await c.auth.getSession();
  const back = browser();
  const { error } = await back.auth.setSession({
    access_token: data.session!.access_token,
    refresh_token: data.session!.refresh_token,
  });
  if (error) throw error;
  return back;
}

async function phoneSentAt(id: string): Promise<string | null> {
  const [r] = await prisma!.$queryRaw<{ t: string | null }[]>`
    SELECT phone_change_sent_at::text AS t FROM auth.users WHERE id = ${id}::uuid`;
  return r.t;
}

const unique = (tag: string) => `s15-${tag}-${randomUUID().slice(0, 8)}@example.com`;

describe("S1.5 setup flows (local Supabase)", { skip: !enabled && "DAALI_LOCAL_AUTH not set" }, () => {
  before(async () => {
    const [{ n }] = await prisma!.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM auth.users WHERE phone IN ('15555550101','15555550102','15555550103') AND email IS NULL`;
    if (n !== 3) throw new Error("phone-only fixtures missing or already given an email: re-run scripts/seed-local-auth.mts");
  });

  after(async () => {
    await prisma!.$disconnect();
  });

  // ── T25 ───────────────────────────────────────────────────────────────────
  test("T25: a phone-only organizer adds an email — attached only after the code; same user, legacy rows untouched", async () => {
    const { c, id } = await phoneSession("+15555550102", "102102"); // owns a fundraiser, MANAGER on another
    const users0 = await userCount();
    const legacy0 = await legacySnapshot(id);
    assert.ok(legacy0.ownedBoards.length >= 1 && legacy0.grants.some((g) => g.role === "MANAGER"), "fixture shape");

    const email = unique("t25");
    const seen = await mailIds(email);
    const sent = await c.auth.updateUser({ email }, { emailRedirectTo: "http://localhost:3000/auth/confirm" });
    assert.equal(sent.error, null);

    // Pending: nothing attached yet.
    const pending = await authRow(id);
    assert.equal(pending.email, null);
    assert.equal(pending.new_email, email);
    assert.equal(pending.email_ok, false);

    const mail = await newMail(email, seen);
    assert.equal(mail.subject, "Confirm your email for Daali", "the Change Email Address template");
    assert.match(mail.html, /\/auth\/confirm\?token_hash=[^&]+&(amp;)?type=email_change/);

    const v = await c.auth.verifyOtp({ email, token: mail.code, type: "email_change" });
    assert.equal(v.error, null);
    assert.equal(v.data.user?.id, id, "same user id");

    const attached = await authRow(id);
    assert.equal(attached.email, email);
    assert.equal(attached.email_ok, true);
    assert.equal(attached.phone_ok, true, "the phone is untouched");
    assert.equal(await userCount(), users0, "no user created");
    assert.deepEqual(await legacySnapshot(id), legacy0, "Host row, Board owner ids and collaborator rows unchanged");

    // Afterwards the account signs in by email AND by phone, to the same id.
    const byEmail = await emailSession(email);
    await smsGap();
    const byPhone = await phoneSession("+15555550102", "102102");
    assert.equal(byEmail.id, id);
    assert.equal(byPhone.id, id);
  });

  test("T25 (link): the email_change link through /auth/confirm attaches it too — on another device", async () => {
    const { c, id } = await phoneSession("+15555550103", "103103");
    const legacy0 = await legacySnapshot(id);
    const email = unique("t25-link");
    const seen = await mailIds(email);
    assert.equal((await c.auth.updateUser({ email })).error, null);
    const { tokenHash } = await newMail(email, seen);

    const other = browser(); // the link opened somewhere else: no session there
    const v = await other.auth.verifyOtp({ token_hash: tokenHash, type: "email_change" });
    assert.equal(v.error, null);
    assert.equal(v.data.user?.id, id);
    assert.equal((await authRow(id)).email, email);
    assert.deepEqual(await legacySnapshot(id), legacy0);
  });

  // ── T26 ───────────────────────────────────────────────────────────────────
  test("T26: an email that belongs to another account is refused and changes neither account", async () => {
    const { c, id } = await phoneSession("+15555550101", "101101");
    const owner = (await prisma!.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM auth.users WHERE email = 'organizer.one@example.com'`)[0].id;
    const before = { mine: await authRow(id), theirs: await authRow(owner), users: await userCount() };

    const r = await c.auth.updateUser({ email: "organizer.one@example.com" });
    assert.equal(r.error?.code, "email_exists");
    assert.deepEqual(await authRow(id), before.mine);
    assert.deepEqual(await authRow(owner), before.theirs);
    assert.equal(await userCount(), before.users);
  });

  // ── T12 ───────────────────────────────────────────────────────────────────
  test("T12: attaching a number already on another account fails and changes neither account", async () => {
    const { c, id } = await emailSession("organizer.one@example.com");
    const other = (await prisma!.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM auth.users WHERE phone = '15555550101'`)[0].id;
    const before = { mine: await authRow(id), theirs: await authRow(other) };

    const r = await c.auth.updateUser({ phone: "+15555550101" });
    assert.equal(r.error?.code, "phone_exists");
    assert.deepEqual(await authRow(id), before.mine);
    assert.deepEqual(await authRow(other), before.theirs);
  });

  // ── phone attach (Screen 4) and the interrupted phone step ───────────────
  test("phone attach: pending until the phone_change code; a wrong code is refused; resumes after leaving", async () => {
    const { c, id } = await emailSession("no.name@example.com");
    assert.equal((await c.auth.updateUser({ phone: "+15555550106" })).error, null);

    const pending = await authRow(id);
    assert.equal(pending.phone, null, "not attached before verification");
    assert.equal(pending.new_phone, "15555550106");
    assert.equal(pending.phone_ok, false);

    // "Leave", then come back later: the pending number is still there to resume.
    const back = await resume(c);
    const { data } = await back.auth.getUser();
    assert.equal(data.user?.new_phone, "15555550106", "the /setup loader sees the pending number");

    // Resend = re-issue the change: resend({ type: 'phone_change' }) is a no-op
    // for an account with no current number (see setup-flow.tsx). The sent time moves.
    const sent0 = await phoneSentAt(id);
    await smsGap();
    assert.equal((await back.auth.updateUser({ phone: "+15555550106" })).error, null, "Resend");
    assert.notEqual(await phoneSentAt(id), sent0, "a fresh code was sent");
    assert.ok((await back.auth.verifyOtp({ phone: "+15555550106", token: "000000", type: "phone_change" })).error);
    const ok = await back.auth.verifyOtp({ phone: "+15555550106", token: "106106", type: "phone_change" });
    assert.equal(ok.error, null);
    assert.equal(ok.data.user?.id, id);
    const done = await authRow(id);
    assert.equal(done.phone, "15555550106");
    assert.equal(done.phone_ok, true);
  });

  // ── T27 (email) ───────────────────────────────────────────────────────────
  test("T27: leaving after the email code is sent — the pending address returns; Resend and Change email work; finishing later attaches to the same user", async () => {
    const first = await phoneSession("+15555550101", "101101"); // phone-1: owns a Game Day board
    const legacy0 = await legacySnapshot(first.id);
    const a = unique("t27-a");
    assert.equal((await first.c.auth.updateUser({ email: a })).error, null);

    // Leave, sign in again later by phone: the pending address is shown.
    await smsGap();
    const back = await phoneSession("+15555550101", "101101");
    assert.equal((await back.c.auth.getUser()).data.user?.new_email, a);

    // Change email: replaces the pending address; nothing attached. Supabase
    // refuses a change inside 60 seconds of the last send, exactly as it
    // refuses Resend, so wait it out first.
    await new Promise((r) => setTimeout(r, 61_000));
    const b = unique("t27-b");
    const seenB = await mailIds(b);
    assert.equal((await back.c.auth.updateUser({ email: b })).error, null);
    assert.equal((await authRow(first.id)).new_email, b);
    assert.equal((await authRow(first.id)).email, null);
    await newMail(b, seenB);

    // Resend after Supabase's 60-second per-address limit.
    await new Promise((r) => setTimeout(r, 61_000));
    const seenAgain = await mailIds(b);
    // Resend = re-issue the change to the pending address (resend({ type:
    // 'email_change' }) answers 200 and sends nothing here).
    assert.equal((await back.c.auth.updateUser({ email: b })).error, null);
    const { code } = await newMail(b, seenAgain);
    const v = await back.c.auth.verifyOtp({ email: b, token: code, type: "email_change" });
    assert.equal(v.error, null);
    assert.equal(v.data.user?.id, first.id);
    assert.equal((await authRow(first.id)).email, b);
    assert.deepEqual(await legacySnapshot(first.id), legacy0);
  });
});
