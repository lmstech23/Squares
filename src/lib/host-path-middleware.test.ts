import { test, describe, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

// The middleware's /host match, Daali Slice 1 S1.2: `/host` and `/host/...`
// only, so it no longer catches `/hostX`. From S1.4 the target is
// /sign-in?next=…, and an anonymous user counts as signed out.
//
// `@supabase/ssr` is mocked so updateSession runs without a Supabase project.

let currentUser: { id: string; is_anonymous?: boolean } | null = null;

mock.module("@supabase/ssr", {
  namedExports: {
    createServerClient: () => ({
      auth: { getUser: async () => ({ data: { user: currentUser } }) },
    }),
  },
});

const { isHostPath, updateSession } = await import("./supabase/middleware.ts");
const { NextRequest } = await import("next/server");

const run = async (path: string) => {
  const res = await updateSession(new NextRequest(`https://beta.daali.app${path}`));
  return res.headers.get("location");
};

beforeEach(() => {
  currentUser = null;
});

describe("isHostPath", () => {
  test("matches /host and paths beneath it", () => {
    for (const p of ["/host", "/host/", "/host/boards", "/host/boards/new", "/host/payment-setup", "/host/boards/abc/donations"]) {
      assert.equal(isHostPath(p), true, p);
    }
  });

  test("does not match lookalikes or other routes", () => {
    for (const p of ["/hostX", "/hosts", "/host-signup", "/hostboards", "/", "/board/abc", "/invite/abc", "/login", "/api/host"]) {
      assert.equal(isHostPath(p), false, p);
    }
  });
});

describe("updateSession", () => {
  test("signed out on /host or /host/... goes to /sign-in, carrying the path as next", async () => {
    for (const p of ["/host", "/host/boards", "/host/boards/abc"]) {
      assert.equal(await run(p), `https://beta.daali.app/sign-in?next=${encodeURIComponent(p)}`, p);
    }
    assert.equal(
      await run("/host/boards/abc?tab=x"),
      `https://beta.daali.app/sign-in?next=${encodeURIComponent("/host/boards/abc?tab=x")}`
    );
  });

  test("/setup needs a signed-in user too (S1.5); its lookalikes do not", async () => {
    assert.equal(await run("/setup"), `https://beta.daali.app/sign-in?next=${encodeURIComponent("/setup")}`);
    assert.equal(await run("/setupX"), null);
    currentUser = { id: "u1" };
    assert.equal(await run("/setup"), null);
  });

  test("an anonymous user counts as signed out", async () => {
    currentUser = { id: "anon", is_anonymous: true };
    assert.equal(await run("/host/boards"), `https://beta.daali.app/sign-in?next=${encodeURIComponent("/host/boards")}`);
  });

  test("signed out on a /host lookalike is not redirected", async () => {
    assert.equal(await run("/hostX"), null);
    assert.equal(await run("/hosts/anything"), null);
  });

  // T18: the middleware does not consult organizer setup. Any signed-in user
  // passes through to /host/* exactly as today.
  test("signed in passes through to /host/*", async () => {
    currentUser = { id: "u1" };
    assert.equal(await run("/host/boards"), null);
    assert.equal(await run("/host"), null);
  });
});
