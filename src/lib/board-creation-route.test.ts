import { test, describe, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

// GATE #4, EXERCISED THROUGH THE ACTUAL ROUTE HANDLER.
//
// board-creation-gate.test.ts proves the gate's SEMANTICS. This proves the
// WIRING: that `POST /api/boards` imports it, calls it, calls it before it
// parses the body, and shapes the refusal so the client can route on it.
//
// Those are three different faults from a wrong condition, and none of them
// would be caught by a unit test of the gate function:
//
//   - the import is missing or the call is dropped   -> no refusal at all
//   - the gate sits after body validation            -> a refused host gets 400
//                                                       on an unrelated field
//   - the 403 body omits `destination`               -> the form has nowhere to
//                                                       send them
//
// THIS IS THE ACCEPTED VERIFICATION GAP FROM THE PREVIEW PASS, CLOSED.
// Step 4 of the release sequence — one real board creation through the form —
// was declined rather than run against a live 19-board production account. The
// gap was recorded honestly rather than inferred away; this is what closes it,
// and unlike a manual pass it runs on every commit.
//
// The lesson is `b771c68`: a correct fix with no test, deleted the next day by a
// cleanup pass that could not tell load-bearing code from residue. The durable
// protection is a test, not a careful person.
//
// NO DATABASE. `@/lib/prisma` is mocked before the route is imported, so the
// singleton never evaluates, no PrismaClient is constructed, and no connection
// string is read. That is what lets this live in the default `npm test` suite
// instead of behind `test:db:up`.

/** The host the mocked Prisma will return. Set per test. */
let currentHost: Record<string, unknown> | null = null;

/** Everything the route asked the database to do, in order. */
let writes: string[] = [];

const tx = {
  host: {
    update: async () => ({ ...currentHost, boardCredits: 1 }),
  },
  board: {
    create: async ({ data }: { data: Record<string, unknown> }) => {
      writes.push("board.create");
      return { ...data, boardId: "board_test_id", slug: data.slug ?? "test-slug" };
    },
  },
  creditTransaction: { create: async () => (writes.push("creditTransaction.create"), {}) },
  square: { createMany: async () => (writes.push("square.createMany"), { count: 100 }) },
  boardCollaborator: { create: async () => (writes.push("boardCollaborator.create"), {}) },
  event: { create: async () => (writes.push("event.create"), {}) },
};

mock.module("@/lib/prisma", {
  namedExports: {
    prisma: {
      host: { findUnique: async () => currentHost },
      // No slug collision, and no board awaiting payment.
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

function host(over: Record<string, unknown> = {}) {
  return {
    id: "host_test",
    supabaseUserId: "supabase_user_test",
    paymentPreference: "cash",
    stripeChargesEnabled: false,
    stripeAccountId: null,
    boardCredits: 2,
    ...over,
  };
}

/** A Game Day body that passes every validation the route applies. */
function validBody(over: Record<string, unknown> = {}) {
  return {
    gameName: "Gate wiring test",
    sportType: "nfl",
    squarePrice: 500,
    teamRow: "Home",
    teamCol: "Away",
    gridType: "standard",
    hostCutPercent: 0,
    payoutStructure: { Q1: 25, Q2: 25, Q3: 25, Final: 25 },
    ...over,
  };
}

function post(body: unknown) {
  return POST(
    new Request("https://test.local/api/boards", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

describe("POST /api/boards — gate #4 wiring", () => {
  beforeEach(() => {
    writes = [];
  });

  test("cash host is allowed through and the board is created", async () => {
    currentHost = host({ paymentPreference: "cash", stripeChargesEnabled: false });
    const res = await post(validBody());
    assert.equal(res.status, 200);
    const json = (await res.json()) as { boardId?: string };
    assert.equal(json.boardId, "board_test_id");
    // The gate did not merely fail to refuse — creation actually happened.
    assert.ok(writes.includes("board.create"));
  });

  test("stripe host with charges enabled is allowed through", async () => {
    currentHost = host({ paymentPreference: "stripe", stripeChargesEnabled: true });
    const res = await post(validBody());
    assert.equal(res.status, 200);
  });

  test("null preference is refused 403 with destination /host/payment-setup", async () => {
    currentHost = host({ paymentPreference: null });
    const res = await post(validBody());
    assert.equal(res.status, 403);
    const json = (await res.json()) as { error?: string; reason?: string; destination?: string };
    assert.equal(json.destination, "/host/payment-setup");
    assert.equal(json.reason, "no-preference");
    assert.ok(json.error && json.error.length > 0);
    // NOTHING WAS WRITTEN. A refusal that still created the board would pass a
    // status-code assertion and be a catastrophe.
    assert.deepEqual(writes, []);
  });

  test("stripe host without charges enabled is refused 403 to /host/stripe", async () => {
    currentHost = host({ paymentPreference: "stripe", stripeChargesEnabled: false });
    const res = await post(validBody());
    assert.equal(res.status, 403);
    const json = (await res.json()) as { reason?: string; destination?: string };
    assert.equal(json.destination, "/host/stripe");
    assert.equal(json.reason, "stripe-not-ready");
    assert.deepEqual(writes, []);
  });

  test("unrecognized preference is refused to payment-setup, raw value withheld", async () => {
    currentHost = host({ paymentPreference: "card" });
    const res = await post(validBody());
    assert.equal(res.status, 403);
    const json = (await res.json()) as { error?: string; destination?: string };
    assert.equal(json.destination, "/host/payment-setup");
    assert.ok(!json.error?.includes("card"));
    assert.deepEqual(writes, []);
  });

  // THE ORDERING FAULT, ISOLATED. If the gate were moved below body validation,
  // a refused host would get 400 about a missing game name and the destination
  // would never reach the client. The gate must answer first.
  test("the gate runs BEFORE body validation", async () => {
    currentHost = host({ paymentPreference: null });
    const res = await post(validBody({ gameName: "", squarePrice: 1, payoutStructure: null }));
    assert.equal(res.status, 403);
    const json = (await res.json()) as { destination?: string };
    assert.equal(json.destination, "/host/payment-setup");
  });

  // The mirror of the above: an allowed host with the same broken body must
  // reach validation and be told what is actually wrong.
  test("an allowed host with a bad body reaches validation, not the gate", async () => {
    currentHost = host({ paymentPreference: "cash" });
    const res = await post(validBody({ gameName: "" }));
    assert.equal(res.status, 400);
    assert.deepEqual(writes, []);
  });

  test("an unauthenticated host row is 404, not a gate refusal", async () => {
    currentHost = null;
    const res = await post(validBody());
    assert.equal(res.status, 404);
  });
});
