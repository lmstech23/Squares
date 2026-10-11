import { test, describe, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

// The Host creation guard and the callback cleanup, Daali Slice 1 S1.2.
//
//   getHostOrNull  an anonymous user gets null and NO Host write; a
//                  non-anonymous user behaves exactly as before — an existing
//                  Host is returned, a missing one is upserted with the same
//                  payload as before, which leaves boardCredits to the column
//                  default of 2.
//   /auth/callback creates nothing in hosts, and passes `next` through the
//                  shared allowlist with today's fallback. From S1.4 it also
//                  runs finalize — an organizer_profiles insert-or-nothing —
//                  for a user with a confirmed email, and nothing else.
//
// NO DATABASE. `@/lib/supabase/server` and `@/lib/prisma` are mocked before
// either module is imported. The real-database version of the Host guard is
// auth-guards.integration.test.ts.

type FakeUser = {
  id: string;
  is_anonymous?: boolean;
  email?: string;
  phone?: string;
  phone_confirmed_at?: string;
  email_confirmed_at?: string;
  user_metadata?: Record<string, unknown>;
};

let currentUser: FakeUser | null = null;
let exchange: { user: FakeUser | null; error: unknown } = { user: null, error: null };
let existingHost: Record<string, unknown> | null = null;
/** The organizer_profiles row the callback's gate reads (S1.5). */
let currentProfile: { displayName: string | null } | null = null;
/** Every Prisma call made, as "model.method" with its argument. */
let calls: { op: string; arg: unknown }[] = [];

const record = (model: string) =>
  new Proxy(
    {},
    {
      get(_t, method: string | symbol) {
        if (typeof method !== "string" || method === "then") return undefined;
        return async (arg: unknown) => {
          calls.push({ op: `${model}.${method}`, arg });
          if (model === "host" && method === "findUnique") return existingHost;
          if (model === "host" && method === "upsert") {
            const { create } = arg as { create: Record<string, unknown> };
            return { hostId: "h-new", ...create };
          }
          if (model === "organizerProfile" && method === "createMany") return { count: 1 };
          if (model === "organizerProfile" && method === "findUnique") return currentProfile;
          throw new Error(`unexpected prisma.${model}.${method}`);
        };
      },
    }
  );

mock.module("@/lib/prisma", {
  namedExports: {
    prisma: new Proxy(
      {},
      {
        get(_t, model: string | symbol) {
          if (typeof model !== "string" || model === "then") return undefined;
          return record(model);
        },
      }
    ),
  },
});

mock.module("@/lib/supabase/server", {
  namedExports: {
    createClient: async () => ({
      auth: {
        getUser: async () => ({ data: { user: currentUser } }),
        exchangeCodeForSession: async () => ({ data: { user: exchange.user }, error: exchange.error }),
      },
    }),
  },
});

const { getHostOrNull } = await import("./auth.ts");
const { GET: callback } = await import("../app/auth/callback/route.ts");

beforeEach(() => {
  currentUser = null;
  exchange = { user: null, error: null };
  existingHost = null;
  currentProfile = null;
  calls = [];
});

describe("getHostOrNull: anonymous guard", () => {
  test("no user: null, no database call", async () => {
    assert.equal(await getHostOrNull(), null);
    assert.deepEqual(calls, []);
  });

  test("anonymous user: null, and no Host is read or written", async () => {
    currentUser = { id: "u-anon", is_anonymous: true };
    assert.equal(await getHostOrNull(), null);
    assert.deepEqual(calls, []);
  });

  test("anonymous user with an existing Host row still gets null", async () => {
    currentUser = { id: "u-anon", is_anonymous: true };
    existingHost = { hostId: "h-1", supabaseUserId: "u-anon" };
    assert.equal(await getHostOrNull(), null);
    assert.deepEqual(calls, []);
  });
});

describe("getHostOrNull: non-anonymous users are unchanged", () => {
  test("an existing Host is returned, with no write", async () => {
    currentUser = { id: "u1", is_anonymous: false, email: "a@example.com" };
    existingHost = { hostId: "h-1", supabaseUserId: "u1", boardCredits: 7 };
    assert.deepEqual(await getHostOrNull(), existingHost);
    assert.deepEqual(calls.map((c) => c.op), ["host.findUnique"]);
  });

  test("a missing Host is upserted exactly as before; boardCredits is left to the column default", async () => {
    currentUser = { id: "u1", email: "a@example.com", user_metadata: { full_name: "A Person" } };
    await getHostOrNull();
    assert.deepEqual(calls.map((c) => c.op), ["host.findUnique", "host.upsert"]);
    // No boardCredits key: the 2 comes from the column default, which the
    // integration test checks against a real database.
    assert.deepEqual(calls[1].arg, {
      where: { supabaseUserId: "u1" },
      update: { email: "a@example.com" },
      create: { supabaseUserId: "u1", email: "a@example.com", name: "A Person" },
    });
  });

  test("is_anonymous absent counts as non-anonymous; identifier falls back to phone then id", async () => {
    currentUser = { id: "u-phone", phone: "15555550100" };
    await getHostOrNull();
    assert.deepEqual((calls[1].arg as { create: unknown }).create, {
      supabaseUserId: "u-phone",
      email: "15555550100",
      name: null,
    });
  });

  // T18 / T19b: profile completeness is not consulted. A user with no profile,
  // no name and no confirmed phone gets their Host, and organizer_profiles is
  // never read.
  test("an incomplete organizer profile does not matter", async () => {
    currentUser = { id: "u1", email: "a@example.com" };
    existingHost = { hostId: "h-1", supabaseUserId: "u1", name: null };
    assert.deepEqual(await getHostOrNull(), existingHost);
    assert.ok(calls.every((c) => c.op.startsWith("host.")));
  });
});

const BOARD = "0b6f3c1e-8d2a-4f5b-9c7e-1a2b3c4d5e6f";
const ORIGIN = "https://beta.daali.app";
const hit = async (query: string) => {
  const res = await callback(new Request(`${ORIGIN}/auth/callback${query}`));
  return res.headers.get("location");
};

describe("/auth/callback", () => {
  test("creates nothing in hosts; without a confirmed email it writes nothing (it only reads the profile to route)", async () => {
    exchange = { user: { id: "u1", email: "a@example.com" }, error: null };
    await hit("?code=c");
    assert.deepEqual(calls.map((c) => c.op), ["organizerProfile.findUnique"]);
  });

  test("finalize: a confirmed email gets an organizer_profiles insert-or-nothing, and nothing else", async () => {
    exchange = { user: { id: "u1", email: "a@example.com", email_confirmed_at: "2026-10-10T00:00:00Z" }, error: null };
    await hit("?code=c");
    assert.deepEqual(calls.map((c) => c.op), ["organizerProfile.createMany", "organizerProfile.findUnique"]);
    assert.deepEqual(calls[0].arg, {
      data: [{ userId: "u1", displayName: null, avatarUrl: null, createdVia: "SIGNUP" }],
      skipDuplicates: true,
    });
  });

  test("an allowlisted next is followed", async () => {
    exchange = { user: { id: "u1" }, error: null };
    assert.equal(await hit(`?code=c&next=${encodeURIComponent(`/host/boards/${BOARD}/donations`)}`), `${ORIGIN}/host/boards/${BOARD}/donations`);
    const invite = `/invite/${"a".repeat(43)}`;
    assert.equal(await hit(`?code=c&next=${encodeURIComponent(invite)}`), `${ORIGIN}${invite}`);
  });

  // S1.5: without an allowlisted next, the organizer state decides.
  const OFF_LIST = [null, "//evil.com", "https://evil.com", "/\\evil.com", "%2f%2fevil.com", "/host/stripe", "/host/payment-setup", "/home", "/setup"];
  const q = (next: string | null) => (next === null ? "?code=c" : `?code=c&next=${encodeURIComponent(next)}`);

  test("setup incomplete: no next, or one off the allowlist, goes to /setup", async () => {
    exchange = { user: { id: "u1" }, error: null };
    for (const next of OFF_LIST) assert.equal(await hit(q(next)), `${ORIGIN}/setup`, `next=${next}`);
  });

  test("complete: no next, or one off the allowlist, lands on today's default until /home exists", async () => {
    const done = "2026-10-10T00:00:00Z";
    exchange = { user: { id: "u1", email: "a@example.com", email_confirmed_at: done, phone_confirmed_at: done }, error: null };
    currentProfile = { displayName: "Pat" };
    for (const next of OFF_LIST) assert.equal(await hit(q(next)), `${ORIGIN}/host/boards`, `next=${next}`);
  });

  test("a failed exchange goes to /sign-in?error=auth", async () => {
    exchange = { user: null, error: new Error("bad code") };
    assert.equal(await hit("?code=c"), `${ORIGIN}/sign-in?error=auth`);
    assert.equal(await hit(""), `${ORIGIN}/sign-in?error=auth`);
    assert.deepEqual(calls, []);
  });
});
