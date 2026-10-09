import { test, describe, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

// resolveOrganizerState, Daali Slice 1 S1.2: the four states, and the rule that
// the resolver reads ONLY the Supabase user and organizer_profiles.
//
// NO DATABASE. `@/lib/prisma` is mocked before the module is imported. The mock
// exposes organizer_profiles and nothing else: touching `host`, `board` or any
// other model throws, so a resolver that strayed into hosts would fail here.
// `@/lib/auth` is mocked to throw, for the same reason about getHost /
// getHostOrNull.

/** The organizer_profiles row the mock returns, keyed by user id. */
let profiles = new Map<string, { displayName: string | null }>();
/** Every model the resolver touched, and every profile lookup it made. */
let touched: string[] = [];

const prismaMock = new Proxy(
  {},
  {
    get(_t, model: string | symbol) {
      if (typeof model !== "string" || model === "then") return undefined;
      touched.push(model);
      if (model !== "organizerProfile") {
        throw new Error(`resolveOrganizerState read prisma.${model}`);
      }
      return {
        findUnique: async ({ where }: { where: { userId: string } }) => profiles.get(where.userId) ?? null,
      };
    },
  }
);

mock.module("@/lib/prisma", { namedExports: { prisma: prismaMock } });
mock.module("@/lib/auth", {
  namedExports: {
    getHost: async () => {
      throw new Error("resolveOrganizerState called getHost");
    },
    getHostOrNull: async () => {
      throw new Error("resolveOrganizerState called getHostOrNull");
    },
  },
});

const { resolveOrganizerState, organizerStateFor } = await import("./organizer-state.ts");

const CONFIRMED = "2026-10-01T12:00:00Z";
const user = (id: string, opts: { anonymous?: boolean; phoneConfirmedAt?: string | null } = {}) => ({
  id,
  is_anonymous: opts.anonymous ?? false,
  phone_confirmed_at: opts.phoneConfirmedAt === null ? undefined : opts.phoneConfirmedAt,
});

beforeEach(() => {
  profiles = new Map();
  touched = [];
});

describe("resolveOrganizerState", () => {
  test("SIGNED_OUT: no user, without a query", async () => {
    assert.equal(await resolveOrganizerState(null), "SIGNED_OUT");
    assert.equal(await resolveOrganizerState(undefined), "SIGNED_OUT");
    assert.deepEqual(touched, []);
  });

  test("SIGNED_OUT: an anonymous user, even one holding a profile and a phone", async () => {
    profiles.set("u-anon", { displayName: "Someone" });
    assert.equal(await resolveOrganizerState(user("u-anon", { anonymous: true, phoneConfirmedAt: CONFIRMED })), "SIGNED_OUT");
    assert.deepEqual(touched, []);
  });

  test("NO_PROFILE: signed in, no organizer_profiles row", async () => {
    assert.equal(await resolveOrganizerState(user("u1", { phoneConfirmedAt: CONFIRMED })), "NO_PROFILE");
  });

  test("SETUP_INCOMPLETE: no display name", async () => {
    for (const displayName of [null, "", "   "]) {
      profiles.set("u1", { displayName });
      assert.equal(await resolveOrganizerState(user("u1", { phoneConfirmedAt: CONFIRMED })), "SETUP_INCOMPLETE", `name ${JSON.stringify(displayName)}`);
    }
  });

  test("SETUP_INCOMPLETE: no confirmed phone", async () => {
    profiles.set("u1", { displayName: "Daaliyah" });
    assert.equal(await resolveOrganizerState(user("u1", { phoneConfirmedAt: null })), "SETUP_INCOMPLETE");
    assert.equal(await resolveOrganizerState(user("u1", { phoneConfirmedAt: "" })), "SETUP_INCOMPLETE");
  });

  test("SETUP_INCOMPLETE: neither", async () => {
    profiles.set("u1", { displayName: null });
    assert.equal(await resolveOrganizerState(user("u1")), "SETUP_INCOMPLETE");
  });

  test("COMPLETE: a name and a confirmed phone", async () => {
    profiles.set("u1", { displayName: "Daaliyah" });
    assert.equal(await resolveOrganizerState(user("u1", { phoneConfirmedAt: CONFIRMED })), "COMPLETE");
  });

  test("reads organizer_profiles and nothing else", async () => {
    profiles.set("u1", { displayName: "Daaliyah" });
    await resolveOrganizerState(user("u1", { phoneConfirmedAt: CONFIRMED }));
    await resolveOrganizerState(user("u2"));
    assert.deepEqual(touched, ["organizerProfile", "organizerProfile"]);
  });
});

describe("organizerStateFor (the decision table, no database)", () => {
  test("every row of the table", () => {
    const named = { displayName: "D" };
    assert.equal(organizerStateFor(null, named), "SIGNED_OUT");
    assert.equal(organizerStateFor(user("a", { anonymous: true }), null), "SIGNED_OUT");
    assert.equal(organizerStateFor(user("a"), null), "NO_PROFILE");
    assert.equal(organizerStateFor(user("a"), named), "SETUP_INCOMPLETE");
    assert.equal(organizerStateFor(user("a", { phoneConfirmedAt: CONFIRMED }), { displayName: null }), "SETUP_INCOMPLETE");
    assert.equal(organizerStateFor(user("a", { phoneConfirmedAt: CONFIRMED }), named), "COMPLETE");
  });
});
