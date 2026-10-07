import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";

// Phase 0B capacity harness (D9), ported from the recovered package's
// tests/concurrency.mjs. Scenarios, contention counts, expected outcomes and
// order are unchanged; each original PASS check is exactly one assertion here.
//
// What it proves: the RSVP strategy — lock the event row, derive seats from
// CONFIRMED registrations, all-or-nothing — holds under real concurrency, and
// the partial unique index daali_registrations_live_key allows one live RSVP per
// person. The SQL below is the harness's own, against the daali_* tables.
//
// The raw pg pool is gone; this uses the repo's convention instead: PrismaClient
// on TEST_DATABASE_URL, skipped without it. Two driver-level notes:
//   - the original pool had max: 30, so 20 RSVPs genuinely contend. Prisma's
//     default pool is smaller and would queue them (and could time them out,
//     turning "rejected: full" into "rejected: timeout"), so this client sets
//     connection_limit=30 to keep the contention the harness was written for.
//   - pg exposed the Postgres error code as e.code; Prisma reports a failed raw
//     statement as P2010 with the Postgres code in meta.code. pgCode() reads it.
//
// Guarded on TEST_DATABASE_URL, like confirm-square.integration.test.ts.
// DELIBERATELY NO SKIP MARKER HERE — that file already carries the one that
// signals real-database coverage did not run.
//
//   npm run test:db:up
//   TEST_DATABASE_URL=postgresql://postgres:daali@localhost:55432/daali_test \
//     node --experimental-strip-types --test src/db/capacity.integration.test.ts

const url = process.env.TEST_DATABASE_URL;

function withConnectionLimit(u: string, limit: number): string {
  const parsed = new URL(u);
  parsed.searchParams.set("connection_limit", String(limit));
  return parsed.toString();
}

const prisma = url
  ? new PrismaClient({ datasources: { db: { url: withConnectionLimit(url, 30) } } })
  : null;

/** The Postgres SQLSTATE behind a failed statement, whichever client raised it. */
function pgCode(e: unknown): string | undefined {
  const err = e as { meta?: { code?: unknown }; code?: unknown };
  if (typeof err.meta?.code === "string") return err.meta.code;
  return typeof err.code === "string" ? err.code : undefined;
}

/** Thrown inside the transaction to roll it back, as the harness's ROLLBACK did. */
// The field is declared rather than a constructor parameter property, which
// node --experimental-strip-types (the repo test runner) does not support.
class OverCapacity extends Error {
  readonly remaining: number;
  constructor(remaining: number) {
    super("over capacity");
    this.remaining = remaining;
  }
}

type RsvpResult = { ok: true } | { ok: false; remaining?: number; error?: string };

describe("0B capacity harness (integration)", { skip: !url && "TEST_DATABASE_URL not set" }, () => {
  const db = prisma!;
  const eventIds: string[] = [];

  const uid = () => "c" + Math.random().toString(36).slice(2, 12);

  async function seedEvent(capacity: number | null): Promise<string> {
    const id = uid();
    await db.$executeRaw`
      INSERT INTO daali_events(id,"organizerUserId",title,"startsAt",timezone,status,capacity,"updatedAt")
      VALUES (${id},'org','Field Day', now(), 'America/New_York','PUBLISHED',${capacity}, now())`;
    eventIds.push(id);
    return id;
  }

  async function seedPerson(eventId: string, i: number): Promise<string> {
    const id = uid();
    await db.$executeRaw`
      INSERT INTO daali_event_people(id,"eventId","identityKey",name,email,"updatedAt")
      VALUES (${id},${eventId},${`p${i}@x.com`},${`P${i}`},${`p${i}@x.com`}, now())`;
    return id;
  }

  /**
   * EXACTLY the strategy registerForEvent uses:
   *   lock the Event row, derive seats from CONFIRMED registrations, all-or-nothing.
   * No stored counter anywhere.
   */
  async function rsvp(eventId: string, personId: string, partySize: number): Promise<RsvpResult> {
    try {
      return await db.$transaction(async (tx) => {
        const ev = await tx.$queryRaw<{ capacity: number | null }[]>`
          SELECT capacity FROM daali_events WHERE id=${eventId} FOR UPDATE`;
        const cap = ev[0].capacity;
        const taken = Number(
          (
            await tx.$queryRaw<{ seats: number }[]>`
              SELECT COALESCE(SUM("partySize"),0)::int AS seats FROM daali_registrations
               WHERE "eventId"=${eventId} AND status='CONFIRMED'`
          )[0].seats
        );

        if (cap !== null && taken + partySize > cap) {
          throw new OverCapacity(cap - taken);
        }
        await tx.$executeRaw`
          INSERT INTO daali_registrations(id,"eventId","eventPersonId","partySize",status,"actorKind")
          VALUES (${uid()},${eventId},${personId},${partySize},'CONFIRMED','HUMAN')`;
        return { ok: true as const };
      });
    } catch (e) {
      if (e instanceof OverCapacity) return { ok: false, remaining: e.remaining };
      return { ok: false, error: pgCode(e) };
    }
  }

  async function seats(eventId: string): Promise<number> {
    return Number(
      (
        await db.$queryRaw<{ s: number }[]>`
          SELECT COALESCE(SUM("partySize"),0)::int AS s FROM daali_registrations
           WHERE "eventId"=${eventId} AND status='CONFIRMED'`
      )[0].s
    );
  }

  after(async () => {
    // Every daali_* row these scenarios create cascades from its event.
    if (eventIds.length) await db.$executeRaw`DELETE FROM daali_events WHERE id = ANY(${eventIds})`;
    await db.$disconnect();
  });

  // ── THE test: 20 concurrent RSVPs, 10 seats ──────────────────────────────
  test("20 concurrent RSVPs against 10 seats", async () => {
    const eventId = await seedEvent(10);
    const people = await Promise.all([...Array(20)].map((_, i) => seedPerson(eventId, i)));
    const results = await Promise.all(people.map((p) => rsvp(eventId, p, 1)));
    const confirmed = results.filter((r) => r.ok).length;
    const taken = await seats(eventId);
    assert.ok(confirmed === 10, `exactly 10 confirmed — ${confirmed} confirmed, ${20 - confirmed} rejected`);
    assert.ok(taken === 10, `seats never exceed capacity — seatsTaken=${taken}`);
  });

  // ── party size: all-or-nothing, never a partial admit ────────────────────
  test("10 concurrent parties of 3 against 10 seats", async () => {
    const eventId = await seedEvent(10);
    const people = await Promise.all([...Array(10)].map((_, i) => seedPerson(eventId, i)));
    const results = await Promise.all(people.map((p) => rsvp(eventId, p, 3)));
    const confirmed = results.filter((r) => r.ok).length;
    const taken = await seats(eventId);
    assert.ok(confirmed === 3 && taken === 9, `3 parties fit, 1 seat left unsold — confirmed=${confirmed} seats=${taken}`);
    assert.ok(taken % 3 === 0, `no party was partially admitted — seatsTaken=${taken}`);
  });

  // ── cancellation frees seats, because the count is derived ───────────────
  test("cancellation frees seats", async () => {
    const eventId = await seedEvent(2);
    const [a, b, c] = await Promise.all([0, 1, 2].map((i) => seedPerson(eventId, i)));
    await rsvp(eventId, a, 1); await rsvp(eventId, b, 1);
    const blocked = await rsvp(eventId, c, 1);
    assert.ok(!blocked.ok, "third is rejected while full");
    await db.$executeRaw`
      UPDATE daali_registrations SET status='CANCELLED', "cancelledAt"=now()
       WHERE "eventPersonId"=${a}`;
    const after = await rsvp(eventId, c, 1);
    assert.ok(after.ok, `third gets in after a cancellation — seatsTaken=${await seats(eventId)}`);
  });

  // ── the partial unique index ─────────────────────────────────────────────
  test("one live registration per person", async () => {
    const eventId = await seedEvent(null);
    const p = await seedPerson(eventId, 0);
    const first = await rsvp(eventId, p, 1);
    const dup = await rsvp(eventId, p, 1);
    assert.ok(first.ok, "first RSVP succeeds");
    const dupError = dup.ok ? undefined : dup.error;
    assert.ok(!dup.ok && dupError === "23505", `duplicate live RSVP is blocked by the index — code=${dupError}`);
    await db.$executeRaw`UPDATE daali_registrations SET status='CANCELLED' WHERE "eventPersonId"=${p}`;
    const again = await rsvp(eventId, p, 1);
    assert.ok(again.ok, "re-RSVP after cancelling is allowed");
  });

  // ── uncapped events ──────────────────────────────────────────────────────
  test("uncapped event", async () => {
    const eventId = await seedEvent(null);
    const people = await Promise.all([...Array(15)].map((_, i) => seedPerson(eventId, i)));
    const r = await Promise.all(people.map((p) => rsvp(eventId, p, 2)));
    assert.ok(r.every((x) => x.ok), `all 15 admitted — seatsTaken=${await seats(eventId)}`);
  });
});
