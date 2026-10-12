import { test, describe, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

// L2, EXERCISED THROUGH THE ACTUAL ROUTE HANDLER — Daali Slice 1, S1.7 (T29).
//
// POST /api/boards refuses a board whose type RESOLVES to "game" unless the
// signed-in account's organizer_profiles.legacy_boards_enabled is true. The
// route treats a missing or unrecognised boardType as "game", so those are
// refused too. An account with no profile row is not entitled. A refusal
// writes nothing. Fundraiser creation is not affected.
//
// NO DATABASE: `@/lib/prisma` is mocked, as in board-creation-route.test.ts.

let profile: { legacyBoardsEnabled: boolean } | null = null;
let writes: string[] = [];
let profileLookups: string[] = [];

const tx = {
  board: {
    create: async ({ data }: { data: Record<string, unknown> }) => {
      writes.push(`board.create:${data.boardType}`);
      return { ...data, boardId: "board_test_id", slug: data.slug ?? "test-slug" };
    },
  },
  square: { createMany: async () => (writes.push("square.createMany"), { count: 100 }) },
  boardCollaborator: { create: async () => (writes.push("boardCollaborator.create"), {}) },
  event: { create: async () => (writes.push("event.create"), {}) },
};

mock.module("@/lib/prisma", {
  namedExports: {
    prisma: {
      host: {
        findUnique: async () => ({
          id: "host_test",
          supabaseUserId: "supabase_user_test",
          paymentPreference: "cash",
          stripeChargesEnabled: false,
          stripeAccountId: null,
        }),
      },
      organizerProfile: {
        findUnique: async ({ where }: { where: { userId: string } }) => {
          profileLookups.push(where.userId);
          return profile;
        },
      },
      board: { findUnique: async () => null, findFirst: async () => null },
      $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    },
  },
});

mock.module("@/lib/supabase/server", {
  namedExports: {
    createClient: async () => ({
      auth: { getUser: async () => ({ data: { user: { id: "supabase_user_test" } } }) },
    }),
  },
});

const { POST } = await import("../app/api/boards/route.ts");

/** A Game Day body that passes every validation the route applies (as in board-creation-route.test.ts). */
const gameBody = (over: Record<string, unknown> = {}) => ({
  gameName: "L2 test",
  sportType: "nfl",
  squarePrice: 500,
  teamRow: "Home",
  teamCol: "Away",
  gridType: "standard",
  hostCutPercent: 0,
  payoutStructure: { Q1: 25, Q2: 25, Q3: 25, Final: 25 },
  ...over,
});

const post = (body: unknown) =>
  POST(new Request("https://test.local/api/boards", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));

async function refused(body: unknown) {
  const res = await post(body);
  const json = (await res.json()) as { reason?: string };
  return { status: res.status, reason: json.reason };
}

beforeEach(() => {
  profile = null;
  writes = [];
  profileLookups = [];
});

describe("POST /api/boards — Game Day entitlement (L2, T29)", () => {
  test("no profile row: boardType 'game' is refused 403 and nothing is written", async () => {
    profile = null;
    assert.deepEqual(await refused(gameBody({ boardType: "game" })), { status: 403, reason: "game_day_not_enabled" });
    assert.deepEqual(writes, []);
    assert.deepEqual(profileLookups, ["supabase_user_test"], "checked against the signed-in user");
  });

  test("flag false: 'game' refused, and so is a MISSING boardType, and an UNRECOGNISED one", async () => {
    profile = { legacyBoardsEnabled: false };
    for (const body of [gameBody({ boardType: "game" }), gameBody(), gameBody({ boardType: "chess" }), gameBody({ boardType: "" })]) {
      assert.deepEqual(await refused(body), { status: 403, reason: "game_day_not_enabled" }, JSON.stringify(body.boardType));
    }
    assert.deepEqual(writes, []);
  });

  test("flag true: Game Day creation behaves as today", async () => {
    profile = { legacyBoardsEnabled: true };
    const res = await post(gameBody({ boardType: "game" }));
    assert.equal(res.status, 200);
    assert.ok(writes.includes("board.create:game"));
    assert.ok(writes.includes("square.createMany"));
  });

  test("flag true, missing boardType: still defaults to Game Day, unchanged", async () => {
    profile = { legacyBoardsEnabled: true };
    const res = await post(gameBody());
    assert.equal(res.status, 200);
    assert.ok(writes.includes("board.create:game"));
  });

  test("fundraiser creation never consults the entitlement", async () => {
    profile = null;
    const res = await post({ boardType: "fundraiser", gameName: "", squarePrice: 500 });
    const json = (await res.json()) as { reason?: string };
    assert.notEqual(json.reason, "game_day_not_enabled");
    assert.equal(res.status, 400, "it reaches the fundraiser's own validation");
    assert.deepEqual(profileLookups, []);
  });

  // The payment-setup gate is unchanged and still answers first; its ordering
  // against a refused host is pinned in board-creation-route.test.ts. Here the
  // host is a cash host, so the gate allows and L2 is what refuses.
  test("L2 refuses a Game Day board before its body is validated, and writes nothing", async () => {
    profile = null;
    assert.deepEqual(await refused(gameBody({ gameName: "" })), { status: 403, reason: "game_day_not_enabled" });
    assert.deepEqual(writes, []);
  });
});
