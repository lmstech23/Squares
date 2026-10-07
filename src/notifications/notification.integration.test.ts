import { test, describe, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";

// Phase 0D.0 notification harness (D9), ported from the recovered package's
// tests/notification.mjs. Scenarios, counts, expected outcomes and order are
// unchanged; each original PASS check is exactly one assertion here.
//
// What it proves: the RSVP and its enqueue commit in ONE transaction, the send
// happens after commit and only ever writes the delivery row, so a failed or
// dead mail provider never rolls back or invalidates an RSVP; the dedupe key
// names the registration. The SQL below is the harness's own, against the
// daali_* tables.
//
// The raw pg pool is gone; this uses the repo's convention instead: PrismaClient
// on TEST_DATABASE_URL, skipped without it. The original pool had max: 10, so
// this client sets connection_limit=10 to match.
//
// Guarded on TEST_DATABASE_URL, like confirm-square.integration.test.ts.
// DELIBERATELY NO SKIP MARKER HERE — that file already carries the one that
// signals real-database coverage did not run.
//
//   npm run test:db:up
//   TEST_DATABASE_URL=postgresql://postgres:daali@localhost:55432/daali_test \
//     node --experimental-strip-types --test src/notifications/notification.integration.test.ts

const url = process.env.TEST_DATABASE_URL;

function withConnectionLimit(u: string, limit: number): string {
  const parsed = new URL(u);
  parsed.searchParams.set("connection_limit", String(limit));
  return parsed.toString();
}

const prisma = url
  ? new PrismaClient({ datasources: { db: { url: withConnectionLimit(url, 10) } } })
  : null;

/** The Postgres SQLSTATE behind a failed statement, whichever client raised it. */
function pgCode(e: unknown): string | undefined {
  const err = e as { meta?: { code?: unknown }; code?: unknown };
  if (typeof err.meta?.code === "string") return err.meta.code;
  return typeof err.code === "string" ? err.code : undefined;
}

// ── P6 additions ─────────────────────────────────────────────────────────
// 1. Explicit, generous interactive-transaction limits. Prisma's defaults
//    (maxWait 2s, timeout 5s) could expire under the contention these
//    scenarios create, and an expired transaction would read as a rejection.
const TX = { maxWait: 60_000, timeout: 120_000 };

// 2. Every rejected operation is classified by cause, and each scenario asserts
//    that only the causes it was written to expect occurred. A timeout or an
//    unrecognised failure therefore fails the run instead of passing as an
//    ordinary rejection.
type Cause = "capacity" | "full" | "unique" | "fk" | "timeout" | "simulated" | "other";

function classify(e: unknown): Cause {
  const code = pgCode(e);
  if (code === "23505") return "unique";
  if (code === "23503") return "fk";
  const err = e as { code?: unknown; message?: unknown };
  if (err.code === "P2028" || err.code === "P2024" || err.code === "P1008") return "timeout";
  if (typeof err.message === "string" && /timed? ?out|timeout|Unable to start a transaction/i.test(err.message)) return "timeout";
  return "other";
}

const unexpected = (seen: Cause[], allowed: Cause[]) => seen.filter((c) => !allowed.includes(c));

// 3. One original PASS check: printed in the harness's own format, so a run can
//    be compared line for line with the recovery output, then asserted.
function check(pass: boolean, message: string): void {
  console.log(`${pass ? "  PASS" : "  FAIL"}  ${message}`);
  assert.ok(pass, message);
}

type ProviderResult = { ok: true; id: string } | { ok: false; error: string };
// The harness returned { regId, deliveryId } on success and { regId: null, error }
// on failure, and destructured both the same way, so deliveryId reads as
// undefined after a failure. That shape is kept as is.
type Enqueued = { regId: string | null; deliveryId?: string | null; error?: string };

describe("0D.0 notification harness (integration)", { skip: !url && "TEST_DATABASE_URL not set" }, () => {
  const db = prisma!;
  const seen: Cause[] = [];
  beforeEach(() => { seen.length = 0; });
  const eventIds: string[] = [];

  const uid = () => "c" + Math.random().toString(36).slice(2, 12);

  async function seed() {
    const eventId = uid(), personId = uid();
    await db.$executeRaw`INSERT INTO daali_events(id,"organizerUserId",title,"startsAt",timezone,status,"updatedAt")
      VALUES (${eventId},'org','E',now(),'America/New_York','PUBLISHED',now())`;
    eventIds.push(eventId);
    await db.$executeRaw`INSERT INTO daali_event_people(id,"eventId","identityKey",name,email,"updatedAt")
      VALUES (${personId},${eventId},${`${personId}@x.com`},'P',${`${personId}@x.com`},now())`;
    return { eventId, personId };
  }

  /** registerForEvent: RSVP + enqueue in ONE transaction. The send is not here. */
  async function rsvpWithEnqueue(
    eventId: string,
    personId: string,
    { enqueueThrows = false }: { enqueueThrows?: boolean } = {}
  ): Promise<Enqueued> {
    const regId = uid();
    try {
      const deliveryId = await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT capacity FROM daali_events WHERE id=${eventId} FOR UPDATE`;
        await tx.$executeRaw`INSERT INTO daali_registrations(id,"eventId","eventPersonId","partySize",status,"actorKind")
          VALUES (${regId},${eventId},${personId},2,'CONFIRMED','HUMAN')`;

        if (enqueueThrows) throw new Error("simulated enqueue failure");

        const r = await tx.$queryRaw<{ id: string }[]>`INSERT INTO daali_notification_deliveries
          (id,"notificationType","dedupeKey","eventPersonId","registrationId",status,"updatedAt")
          VALUES (${uid()},'RSVP_CONFIRMED',${`registration:${regId}`},${personId},${regId},'pending',now())
          ON CONFLICT ("notificationType","dedupeKey") DO NOTHING RETURNING id`;
        return r[0]?.id ?? null;
      }, TX);
      return { regId, deliveryId };
    } catch (e) {
      // The scenario's own deliberate failure is its own cause; anything else is classified.
      seen.push(e instanceof Error && e.message === "simulated enqueue failure" ? "simulated" : classify(e));
      return { regId: null, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** deliverNotification: AFTER commit. Only ever writes NotificationDelivery. */
  async function deliver(deliveryId: string | null | undefined, providerResult: ProviderResult) {
    // pg bound an undefined parameter as NULL; ?? null reproduces that.
    const id = deliveryId ?? null;
    await db.$executeRaw`UPDATE daali_notification_deliveries SET attempts=attempts+1, "updatedAt"=now() WHERE id=${id}`;
    if (providerResult.ok) {
      await db.$executeRaw`UPDATE daali_notification_deliveries
        SET status='sent', "sentAt"=now(), "providerMessageId"=${providerResult.id}, "lastError"=NULL, "updatedAt"=now()
        WHERE id=${id}`;
    } else {
      await db.$executeRaw`UPDATE daali_notification_deliveries
        SET status='failed', "lastError"=${providerResult.error}, "updatedAt"=now() WHERE id=${id}`;
    }
  }

  type RegRow = { status: string; partySize: number };
  type DelRow = { status: string; attempts: number; lastError: string | null; sentAt: Date | null };
  const reg = async (id: string | null | undefined) =>
    (await db.$queryRaw<RegRow[]>`SELECT status,"partySize" FROM daali_registrations WHERE id=${id ?? null}`)[0];
  const del = async (id: string | null | undefined) =>
    (await db.$queryRaw<DelRow[]>`SELECT status,attempts,"lastError","sentAt" FROM daali_notification_deliveries WHERE id=${id ?? null}`)[0];

  after(async () => {
    // Every daali_* row these scenarios create cascades from its event.
    if (eventIds.length) await db.$executeRaw`DELETE FROM daali_events WHERE id = ANY(${eventIds})`;
    await db.$disconnect();
  });

  // ── THE invariant ────────────────────────────────────────────────────────
  test("A failed email must never roll back or invalidate the RSVP", async () => {
    const { eventId, personId } = await seed();
    const { regId, deliveryId } = await rsvpWithEnqueue(eventId, personId);

    await deliver(deliveryId, { ok: false, error: "provider 500" });

    const r = await reg(regId), d = await del(deliveryId);
    check(r?.status === "CONFIRMED", `RSVP is still CONFIRMED after a failed send — status=${r?.status}`);
    check(r?.partySize === 2, "party size untouched");
    check(d.status === "failed" && d.lastError === "provider 500", "delivery is visibly failed with the error");
    check(d.attempts === 1, `the failure is countable — attempts=${d.attempts}`);
    assert.deepEqual(unexpected(seen, []), [], `unexpected rejection causes: ${seen.join(", ")}`);
  });

  test("Total provider outage across many RSVPs", async () => {
    const { eventId } = await seed();
    const ids: (string | null)[] = [];
    for (let i = 0; i < 10; i++) {
      const p = uid();
      await db.$executeRaw`INSERT INTO daali_event_people(id,"eventId","identityKey",name,email,"updatedAt")
        VALUES (${p},${eventId},${`${p}@x.com`},'P',${`${p}@x.com`},now())`;
      const { regId, deliveryId } = await rsvpWithEnqueue(eventId, p);
      await deliver(deliveryId, { ok: false, error: "ECONNREFUSED" });
      ids.push(regId);
    }
    const confirmed = (
      await db.$queryRaw<{ c: number }[]>`
        SELECT count(*)::int c FROM daali_registrations WHERE id = ANY(${ids}) AND status='CONFIRMED'`
    )[0].c;
    check(confirmed === 10, `all 10 RSVPs survive a dead mail provider — ${confirmed}/10`);
    assert.deepEqual(unexpected(seen, []), [], `unexpected rejection causes: ${seen.join(", ")}`);
  });

  test("Manual resend after a failure", async () => {
    const { eventId, personId } = await seed();
    const { deliveryId } = await rsvpWithEnqueue(eventId, personId);
    await deliver(deliveryId, { ok: false, error: "timeout" });
    await deliver(deliveryId, { ok: true, id: "msg_123" });
    const d = await del(deliveryId);
    check(d.status === "sent", `delivery reaches sent — status=${d.status}`);
    check(d.lastError === null, "error is cleared on success");
    check(d.attempts === 2, `both attempts counted — attempts=${d.attempts}`);
    assert.deepEqual(unexpected(seen, []), [], `unexpected rejection causes: ${seen.join(", ")}`);
  });

  test("The dedupe key names the thing being communicated", async () => {
    const { eventId, personId } = await seed();
    const a = await rsvpWithEnqueue(eventId, personId);
    await deliver(a.deliveryId, { ok: true, id: "m1" });

    // Same person cancels and RSVPs again — a NEW registration deserves a NEW receipt.
    await db.$executeRaw`UPDATE daali_registrations SET status='CANCELLED' WHERE id=${a.regId ?? null}`;
    const b = await rsvpWithEnqueue(eventId, personId);
    check(b.deliveryId !== null && b.deliveryId !== a.deliveryId, "a second registration gets its own delivery");

    // Re-enqueueing the SAME registration must not duplicate.
    const dup = await db.$queryRaw<{ id: string }[]>`INSERT INTO daali_notification_deliveries
      (id,"notificationType","dedupeKey","eventPersonId","registrationId",status,"updatedAt")
      VALUES (${uid()},'RSVP_CONFIRMED',${`registration:${a.regId}`},${personId},${a.regId},'pending',now())
      ON CONFLICT ("notificationType","dedupeKey") DO NOTHING RETURNING id`;
    check(dup.length === 0, "re-enqueue of the same registration is a no-op");
    assert.deepEqual(unexpected(seen, []), [], `unexpected rejection causes: ${seen.join(", ")}`);
  });

  test("Enqueue is a local insert inside the RSVP transaction", async () => {
    const { eventId, personId } = await seed();
    const res = await rsvpWithEnqueue(eventId, personId, { enqueueThrows: true });
    const orphan = await db.$queryRaw<{ c: number }[]>`
      SELECT count(*)::int c FROM daali_registrations WHERE "eventPersonId"=${personId}`;
    check(
      res.regId === null && orphan[0].c === 0,
      `a failed enqueue rolls back with the RSVP — no unconfirmable registration — registrations=${orphan[0].c}`
    );
    assert.deepEqual(unexpected(seen, ["simulated"]), [], `unexpected rejection causes: ${seen.join(", ")}`);
  });
});
