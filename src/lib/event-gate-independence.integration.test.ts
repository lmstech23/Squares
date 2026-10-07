import { test, describe, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "crypto";
import { spawnSync } from "child_process";
import { PrismaClient } from "@prisma/client";

// T1–T7, the acceptance tests of docs/phase0/event-path-gate-independence.md §6,
// against a REAL database (Port Plan P6).
//
// WHY THIS FILE LIVES IN src/lib AND NOT ON THE EVENT PATH. To prove the Event
// path ignores Board state, T2–T4 must first CREATE that state: a hosts row
// with paymentPreference, stripeChargesEnabled and boardCredits set. Those are
// exactly the identifiers scripts/check-event-isolation.sh forbids on the Event
// path, so this file sits beside the repo's other integration tests instead.
//
// THE PAGES ARE NOT PORTED (Port Plan: replaced, rebuilt from Figma in Slices
// 3–4), so the page-level wording of T1, T5 and T6 is tested at the API level:
//   T1 "public page renders"  -> the event is published with a slug, the domain
//                                rule says it is publicly visible, and the
//                                public RSVP route accepts a guest
//   T5 "RSVP at /e/[slug]"     -> POST /api/events/[id]/registrations, the route
//                                that page calls
//   T6 "reachable by navigation" -> creation is reachable from a clean login in
//                                the T3 state without passing /host/boards, and
//                                no middleware redirects an Event path. The
//                                navigation entry point itself (a link, the
//                                post-login destination) arrives with Slices 1/3
//                                and is NOT proven here.
//
// The Supabase session is faked by mocking @/lib/supabase/server (as
// fundraiser-details-route.integration.test.ts does) and @supabase/ssr (for the
// middleware). No mail can be sent: RESEND_API_KEY must be unset, which selects
// the console provider, and APP_URL is unset, so a delivery fails before any
// message is built. Both are asserted.
//
// Guarded on TEST_DATABASE_URL, like confirm-square.integration.test.ts.
// DELIBERATELY NO SKIP MARKER HERE — that file already carries the one that
// signals real-database coverage did not run.
//
//   npm run test:db:up
//   TEST_DATABASE_URL=postgresql://postgres:daali@localhost:55432/daali_test \
//     node --experimental-strip-types --experimental-test-module-mocks \
//       --import ./scripts/test-alias-only.mjs --test src/lib/event-gate-independence.integration.test.ts

const url = process.env.TEST_DATABASE_URL;
const prisma = url ? new PrismaClient({ datasources: { db: { url } } }) : null;

/** The fake session. null = signed out. */
let sessionUserId: string | null = null;

if (url) {
  // The route modules below construct the @/lib/prisma singleton when they are
  // first imported, which is AFTER this line: they talk to the test database.
  process.env.DATABASE_URL = url;
  process.env.DIRECT_URL = url;
  // A throwaway HMAC key for the access-token routes. Not a secret.
  process.env.ACCESS_TOKEN_SECRET ??= "test-only-access-token-secret-not-a-secret-000";

  const fakeAuth = {
    auth: {
      getUser: async () =>
        sessionUserId
          ? { data: { user: { id: sessionUserId, email: sessionUserId + "@example.com" } }, error: null }
          : { data: { user: null }, error: null },
    },
  };
  mock.module("@/lib/supabase/server", { namedExports: { createClient: async () => fakeAuth } });
  mock.module("@supabase/ssr", { namedExports: { createServerClient: () => fakeAuth } });
}

type Handler = (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
type Routes = {
  createEvent: (req: Request) => Promise<Response>;
  publish: Handler;
  close: Handler;
  addSlot: Handler;
  rsvp: Handler;
  claim: Handler;
  middleware: (req: import("next/server").NextRequest) => Promise<Response>;
  NextRequest: typeof import("next/server").NextRequest;
  isPubliclyVisible: (s: "DRAFT" | "PUBLISHED" | "CLOSED") => boolean;
  emailProvider: () => { name: string };
};

const routes: Routes | null = url
  ? {
      createEvent: (await import("../app/api/events/route.ts")).POST,
      publish: (await import("../app/api/events/[id]/publish/route.ts")).POST,
      close: (await import("../app/api/events/[id]/close/route.ts")).POST,
      addSlot: (await import("../app/api/events/[id]/slots/route.ts")).POST,
      rsvp: (await import("../app/api/events/[id]/registrations/route.ts")).POST,
      claim: (await import("../app/api/slots/[id]/claim/route.ts")).POST,
      middleware: (await import("../middleware.ts")).middleware as Routes["middleware"],
      NextRequest: (await import("next/server")).NextRequest,
      isPubliclyVisible: (await import("../domain/eventStatus.ts")).isPubliclyVisible,
      emailProvider: (await import("../notifications/providers/index.ts")).emailProvider,
    }
  : null;

describe("Event path gate independence T1–T7 (integration)", { skip: !url && "TEST_DATABASE_URL not set" }, () => {
  const db = prisma!;
  const r = routes!;
  const eventIds: string[] = [];
  const hostIds: string[] = [];

  const post = (path: string, body: unknown = {}) =>
    new Request("http://localhost" + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const ctx = (params: { id: string }) => ({ params: Promise.resolve(params) });

  /** A route response that is neither a redirect nor carries a Location header. */
  function assertNoRedirect(res: Response, what: string) {
    assert.ok(res.status < 300 || res.status >= 400, `${what}: redirected with ${res.status}`);
    assert.equal(res.headers.get("location"), null, `${what}: Location ${res.headers.get("location")}`);
  }

  async function expectJson(res: Response, status: number, what: string) {
    assertNoRedirect(res, what);
    const body = await res.json();
    assert.equal(res.status, status, `${what}: ${res.status} ${JSON.stringify(body)}`);
    return body;
  }

  /** A host row in a given Board state, for the signed-in user. */
  async function seedHost(userId: string, data: Record<string, unknown>) {
    const host = await db.host.create({ data: { supabaseUserId: userId, email: userId + "@example.com", ...data } });
    hostIds.push(host.id);
    return host;
  }

  /**
   * The full organizer flow through the routes: create, publish, add a slot,
   * a public RSVP, a public slot claim, close. Returns what it created.
   */
  async function fullFlow(userId: string, label: string) {
    sessionUserId = userId;
    const created = await expectJson(
      await r.createEvent(post("/api/events", {
        title: `Gate ${label} ${randomUUID().slice(0, 6)}`,
        startsAt: new Date(Date.now() + 7 * 864e5).toISOString(),
        timezone: "America/New_York",
        capacity: 20,
      })),
      201, `${label} create`);
    const eventId: string = created.eventId;
    eventIds.push(eventId);

    await expectJson(await r.publish(post(`/api/events/${eventId}/publish`), ctx({ id: eventId })), 200, `${label} publish`);
    const slot = await expectJson(
      await r.addSlot(post(`/api/events/${eventId}/slots`, { slotType: "SHIFT", name: "Gate", capacity: 2 }), ctx({ id: eventId })),
      201, `${label} add slot`);

    sessionUserId = null; // the public surfaces: no session at all
    await expectJson(
      await r.rsvp(post(`/api/events/${eventId}/registrations`, { name: "Guest", email: `g-${randomUUID()}@example.com`, partySize: 1 }), ctx({ id: eventId })),
      201, `${label} public RSVP`);
    await expectJson(
      await r.claim(post(`/api/slots/${slot.slotId}/claim`, { name: "Helper", email: `h-${randomUUID()}@example.com`, quantity: 1 }), ctx({ id: slot.slotId })),
      201, `${label} public slot claim`);

    sessionUserId = userId;
    await expectJson(await r.close(post(`/api/events/${eventId}/close`), ctx({ id: eventId })), 200, `${label} close`);
    return { eventId, slotId: slot.slotId as string };
  }

  /** No middleware redirect on any Event path, signed in or not. */
  async function assertMiddlewarePasses(userId: string | null, what: string) {
    for (const path of ["/events", "/events/x", "/e/x", "/api/events", "/api/events/x/publish", "/api/registrations/x/cancel",
                        "/api/slots/x/claim", "/api/signups/x/cancel", "/api/notifications/x/resend"]) {
      sessionUserId = userId;
      const res = await r.middleware(new r.NextRequest("http://localhost" + path));
      assertNoRedirect(res, `${what} middleware ${path}`);
    }
  }

  const hostCount = (userId: string) => db.host.count({ where: { supabaseUserId: userId } });

  before(() => {
    // No real mail, ever: the console provider, and no APP_URL to build a link.
    assert.equal(process.env.RESEND_API_KEY, undefined, "RESEND_API_KEY must be unset for these tests");
    assert.equal(r.emailProvider().name, "console");
    assert.equal(process.env.APP_URL, undefined, "APP_URL must be unset for these tests");
  });

  after(async () => {
    sessionUserId = null;
    // Every daali_* row cascades from its event. Hosts made here are removed too.
    if (eventIds.length) await db.$executeRaw`DELETE FROM daali_events WHERE id = ANY(${eventIds})`;
    if (hostIds.length) await db.host.deleteMany({ where: { id: { in: hostIds } } });
    await db.$disconnect();
  });

  test("T1 — no host record: create, publish, close; publicly visible; no hosts row created", async () => {
    const userId = "t1-" + randomUUID();
    const hostsBefore = await db.host.count();
    assert.equal(await hostCount(userId), 0);
    const { eventId } = await fullFlow(userId, "T1");
    // API-level stand-in for "public page renders" (the page is not ported).
    const ev = await db.daaliEvent.findUniqueOrThrow({ where: { id: eventId } });
    assert.equal(ev.organizerUserId, userId);
    assert.ok(ev.slug, "published event has a public slug");
    assert.equal(r.isPubliclyVisible("PUBLISHED"), true);
    assert.equal(r.isPubliclyVisible(ev.status), true, "closed event stays publicly visible");
    assert.equal(await hostCount(userId), 0, "no hosts row for the organizer");
    assert.equal(await db.host.count(), hostsBefore, "no hosts row created at any point");
  });

  test("T2 — null paymentPreference: full flow, no redirect to /host/payment-setup", async () => {
    const userId = "t2-" + randomUUID();
    await seedHost(userId, { paymentPreference: null });
    await fullFlow(userId, "T2");
    await assertMiddlewarePasses(userId, "T2");
  });

  test("T3 — the exact failing case: stripe preference, charges disabled, no account; no redirect to /host/stripe", async () => {
    const userId = "t3-" + randomUUID();
    const host = await seedHost(userId, { paymentPreference: "stripe", stripeChargesEnabled: false, stripeAccountId: null });
    await fullFlow(userId, "T3");
    await assertMiddlewarePasses(userId, "T3");
    const after = await db.host.findUniqueOrThrow({ where: { id: host.id } });
    assert.equal(after.paymentPreference, "stripe", "the host's Board state is untouched");
    assert.equal(after.stripeChargesEnabled, false);
    assert.equal(after.stripeAccountId, null);
  });

  test("T4 — zero credits: creation succeeds, consumes no credit, creates no CreditTransaction", async () => {
    const userId = "t4-" + randomUUID();
    const host = await seedHost(userId, { boardCredits: 0 });
    const txBefore = await db.creditTransaction.count({ where: { hostId: host.id } });
    sessionUserId = userId;
    const created = await expectJson(
      await r.createEvent(post("/api/events", {
        title: "Gate T4 " + randomUUID().slice(0, 6),
        startsAt: new Date(Date.now() + 7 * 864e5).toISOString(),
        timezone: "America/New_York",
      })),
      201, "T4 create");
    eventIds.push(created.eventId);
    const after = await db.host.findUniqueOrThrow({ where: { id: host.id } });
    assert.equal(after.boardCredits, 0, "no credit consumed");
    assert.equal(txBefore, 0);
    assert.equal(await db.creditTransaction.count({ where: { hostId: host.id } }), 0, "no CreditTransaction row");
  });

  test("T5 — public surfaces: RSVP and slot claim with no session, for an organizer in the T3 state", async () => {
    const userId = "t5-" + randomUUID();
    await seedHost(userId, { paymentPreference: "stripe", stripeChargesEnabled: false, stripeAccountId: null });
    sessionUserId = userId;
    const created = await expectJson(
      await r.createEvent(post("/api/events", {
        title: "Gate T5 " + randomUUID().slice(0, 6),
        startsAt: new Date(Date.now() + 7 * 864e5).toISOString(),
        timezone: "America/New_York",
        capacity: 5,
      })),
      201, "T5 create");
    const eventId: string = created.eventId;
    eventIds.push(eventId);
    await expectJson(await r.publish(post(`/api/events/${eventId}/publish`), ctx({ id: eventId })), 200, "T5 publish");
    const slot = await expectJson(
      await r.addSlot(post(`/api/events/${eventId}/slots`, { slotType: "ITEM", name: "Water", capacity: 6, unitLabel: "case" }), ctx({ id: eventId })),
      201, "T5 add slot");

    sessionUserId = null;
    const rsvp = await expectJson(
      await r.rsvp(post(`/api/events/${eventId}/registrations`, { name: "Guest", email: `g-${randomUUID()}@example.com`, partySize: 2 }), ctx({ id: eventId })),
      201, "T5 public RSVP");
    const claim = await expectJson(
      await r.claim(post(`/api/slots/${slot.slotId}/claim`, { name: "Helper", email: `h-${randomUUID()}@example.com`, quantity: 2 }), ctx({ id: slot.slotId })),
      201, "T5 public slot claim");
    assert.ok(rsvp.eventPersonId, "RSVP recorded with no session");
    assert.ok(claim.eventPersonId, "claim recorded with no session and no RSVP");
    // The confirmation could not be sent: no APP_URL, console provider, no mail.
    const deliveries = await db.daaliNotificationDelivery.findMany({ where: { registration: { eventId } } });
    assert.ok(deliveries.every((d) => d.status !== "sent"), "no message was sent");
  });

  test("T6 — reachability (API-level substitute): from a clean login in the T3 state, creation is reachable without /host/boards", async () => {
    const userId = "t6-" + randomUUID();
    await seedHost(userId, { paymentPreference: "stripe", stripeChargesEnabled: false, stripeAccountId: null });
    // A clean login: the session exists; nothing on the Board path has run.
    await assertMiddlewarePasses(userId, "T6");
    sessionUserId = userId;
    const created = await expectJson(
      await r.createEvent(post("/api/events", {
        title: "Gate T6 " + randomUUID().slice(0, 6),
        startsAt: new Date(Date.now() + 7 * 864e5).toISOString(),
        timezone: "America/New_York",
      })),
      201, "T6 create");
    eventIds.push(created.eventId);
  });

  test("T7 — static guard: the isolation script passes and the spec's identifiers have zero hits", () => {
    const run = spawnSync("bash", ["scripts/check-event-isolation.sh"], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    // The spec's own list, over the Event route tree, independently of the script.
    const tree = ["src/app/events", "src/app/e", "src/app/api/events", "src/app/api/registrations",
                  "src/app/api/slots", "src/app/api/signups", "src/app/api/notifications"];
    const pattern = "\\bgetHost\\b|\\bpaymentPreference\\b|\\bboardCredits\\b|\\bstripeAccountId\\b|\\bstripeChargesEnabled\\b|\\bstripePayoutsEnabled\\b|\\bprisma\\.host\\b";
    const grep = spawnSync("grep", ["-rnE", "--include=*.ts", "--include=*.tsx", pattern, ...tree], { encoding: "utf8" });
    assert.equal(grep.stdout, "", "forbidden identifiers on the Event route tree:\n" + grep.stdout);
  });
});
