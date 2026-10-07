import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";

// Phase 0C sign-up harness (D9), ported from the recovered package's
// tests/signup-concurrency.mjs. Scenarios, contention counts, expected outcomes
// and order are unchanged; each original PASS check is exactly one assertion
// here (12; the recovery run's "13 pass" counted the ALL PASS line).
//
// What it proves: capacity on a slot is enforced by the unique index on
// (slotId, position), not by a lock or a counter; claims are all-or-nothing;
// losers of a race retry on a fresh read; the composite foreign key rejects a
// position attached to another slot's commitment; cancelling frees positions.
// The SQL below is the harness's own, against the daali_* tables.
//
// The raw pg pool is gone; this uses the repo's convention instead: PrismaClient
// on TEST_DATABASE_URL, skipped without it. Driver-level notes:
//   - the original pool had max: 30, so parallel claims genuinely race. This
//     client sets connection_limit=30 so Prisma does not queue them.
//   - pg exposed the Postgres error code as e.code; Prisma reports a failed raw
//     statement as P2010 with the Postgres code in meta.code. pgCode() reads it.
//   - pg sent parameters untyped, so slotType bound straight to the enum column.
//     Prisma binds strings as text, which Postgres will not implicitly cast to an
//     enum, so that one parameter carries ::daali_slot_type. Same value.
//
// Guarded on TEST_DATABASE_URL, like confirm-square.integration.test.ts.
// DELIBERATELY NO SKIP MARKER HERE — that file already carries the one that
// signals real-database coverage did not run.
//
//   npm run test:db:up
//   TEST_DATABASE_URL=postgresql://postgres:daali@localhost:55432/daali_test \
//     node --experimental-strip-types --test src/db/signups.integration.test.ts

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
class SlotFull extends Error {
  readonly remaining: number;
  constructor(remaining: number) {
    super("slot full");
    this.remaining = remaining;
  }
}

type ClaimResult =
  | { ok: true; positions: number[] }
  | { ok: false; remaining?: number; error?: string; reason: "FULL" | "RACE" | "RACE_EXHAUSTED" };

describe("0C sign-up harness (integration)", { skip: !url && "TEST_DATABASE_URL not set" }, () => {
  const db = prisma!;
  const eventIds: string[] = [];

  const uid = () => "c" + Math.random().toString(36).slice(2, 12);

  async function seedSlot(slotType: "SHIFT" | "ITEM", capacity: number, unitLabel: string | null = null) {
    const eventId = uid(), sheetId = uid(), slotId = uid();
    await db.$executeRaw`INSERT INTO daali_events(id,"organizerUserId",title,"startsAt",timezone,status,"updatedAt")
      VALUES (${eventId},'org','E',now(),'America/New_York','PUBLISHED',now())`;
    eventIds.push(eventId);
    await db.$executeRaw`INSERT INTO daali_signup_sheets(id,"eventId","updatedAt") VALUES (${sheetId},${eventId},now())`;
    await db.$executeRaw`INSERT INTO daali_signup_slots(id,"sheetId","slotType",name,capacity,"unitLabel","updatedAt")
      VALUES (${slotId},${sheetId},${slotType}::daali_slot_type,'Slot',${capacity},${unitLabel},now())`;
    return { eventId, slotId };
  }

  async function seedPerson(eventId: string, i: number): Promise<string> {
    const id = uid();
    await db.$executeRaw`INSERT INTO daali_event_people(id,"eventId","identityKey",name,email,"updatedAt")
      VALUES (${id},${eventId},${`h${i}-${id}@x.com`},${`H${i}`},${`h${i}@x.com`},now())`;
    return id;
  }

  /**
   * EXACTLY the algorithm src/db/signups.ts uses.
   *
   * Capacity is enforced by the unique index on (slotId, position) — NOT by a row
   * lock and NOT by a counter. Losers of a race take a unique violation, roll back,
   * re-read, and retry once. Then they report what is actually left.
   */
  const MAX_CLAIM_ATTEMPTS = 5;

  async function claim(slotId: string, personId: string, quantity: number, capacity: number): Promise<ClaimResult> {
    for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS; attempt++) {
      try {
        const free = await db.$transaction(async (tx) => {
          const hs = await tx.$queryRaw<{ id: string }[]>`
            INSERT INTO daali_helper_signups(id,"slotId","eventPersonId","actorKind")
            VALUES (${uid()},${slotId},${personId},'HUMAN')
            ON CONFLICT ("slotId","eventPersonId") DO UPDATE SET "slotId"=EXCLUDED."slotId"
            RETURNING id`;
          const signupId = hs[0].id;

          const takenRows = await tx.$queryRaw<{ position: number }[]>`
            SELECT position FROM daali_helper_signup_positions WHERE "slotId"=${slotId}`;
          const taken = new Set(takenRows.map((r) => r.position));

          const free: number[] = [];
          for (let p = 1; p <= capacity && free.length < quantity; p++) if (!taken.has(p)) free.push(p);

          // All or nothing. Never silently give them fewer.
          if (free.length < quantity) {
            throw new SlotFull(capacity - taken.size);
          }

          for (const p of free) {
            await tx.$executeRaw`
              INSERT INTO daali_helper_signup_positions(id,"helperSignupId","slotId",position)
              VALUES (${uid()},${signupId},${slotId},${p})`;
          }
          return free;
        });
        return { ok: true, positions: free };
      } catch (e) {
        if (e instanceof SlotFull) return { ok: false, remaining: e.remaining, reason: "FULL" };
        // Lost a race. Retry — the TERMINAL condition is "the slot is actually
        // full", checked on a fresh read at the top of the loop, never "I have
        // tried N times". Giving up on attempt count tells a helper the slot is
        // full while positions remain.
        const code = pgCode(e);
        if (code === "23505" && attempt < MAX_CLAIM_ATTEMPTS - 1) continue;
        return { ok: false, error: code, reason: "RACE" };
      }
    }
    return { ok: false, reason: "RACE_EXHAUSTED" };
  }

  const positions = async (slotId: string): Promise<number[]> =>
    (
      await db.$queryRaw<{ position: number }[]>`
        SELECT position FROM daali_helper_signup_positions WHERE "slotId"=${slotId} ORDER BY position`
    ).map((r) => r.position);

  after(async () => {
    // Every daali_* row these scenarios create cascades from its event.
    if (eventIds.length) await db.$executeRaw`DELETE FROM daali_events WHERE id = ANY(${eventIds})`;
    await db.$disconnect();
  });

  // ── THE 0C test ──────────────────────────────────────────────────────────
  test("10 parallel claims on the FINAL available position (capacity 1)", async () => {
    const { eventId, slotId } = await seedSlot("SHIFT", 1);
    const people = await Promise.all([...Array(10)].map((_, i) => seedPerson(eventId, i)));
    const r = await Promise.all(people.map((p) => claim(slotId, p, 1, 1)));
    const won = r.filter((x) => x.ok).length;
    assert.ok(won === 1, `exactly one claimant wins — ${won} won, ${10 - won} rejected`);
    assert.ok((await positions(slotId)).length === 1, "slot holds exactly one position");
  });

  test("8 parallel claims against a 3-person shift", async () => {
    const { eventId, slotId } = await seedSlot("SHIFT", 3);
    const people = await Promise.all([...Array(8)].map((_, i) => seedPerson(eventId, i)));
    const r = await Promise.all(people.map((p) => claim(slotId, p, 1, 3)));
    const won = r.filter((x) => x.ok).length;
    const pos = await positions(slotId);
    assert.ok(won === 3, `exactly 3 claimed — ${won} won`);
    assert.ok(JSON.stringify(pos) === "[1,2,3]", `positions are 1,2,3 with no gaps or dupes — ${JSON.stringify(pos)}`);
  });

  test("4 parallel claims of 2 cases against a 6-case item", async () => {
    const { eventId, slotId } = await seedSlot("ITEM", 6, "case of water");
    const people = await Promise.all([...Array(4)].map((_, i) => seedPerson(eventId, i)));
    const r = await Promise.all(people.map((p) => claim(slotId, p, 2, 6)));
    const won = r.filter((x) => x.ok).length;
    const pos = await positions(slotId);
    assert.ok(won === 3, `exactly 3 claimants fit — ${won} won`);
    assert.ok(pos.length % 2 === 0 && pos.length === 6, `no claimant was partially filled — ${pos.length} positions`);
  });

  test("composite FK integrity", async () => {
    const a = await seedSlot("SHIFT", 5);
    const b = await seedSlot("SHIFT", 5);
    const person = await seedPerson(a.eventId, 0);
    await claim(a.slotId, person, 1, 5);
    const hs = (
      await db.$queryRaw<{ id: string }[]>`SELECT id FROM daali_helper_signups WHERE "slotId"=${a.slotId}`
    )[0].id;
    let rejected = false;
    try {
      // A coding error attaching slot B's position to slot A's commitment.
      // Two independent FKs would ACCEPT this and the roster would be quietly wrong.
      await db.$executeRaw`INSERT INTO daali_helper_signup_positions(id,"helperSignupId","slotId",position)
        VALUES (${uid()},${hs},${b.slotId},1)`;
    } catch (e) { rejected = pgCode(e) === "23503"; }
    assert.ok(rejected, "cross-slot position is rejected by the composite FK");
  });

  test("cancellation frees positions for reuse", async () => {
    const { eventId, slotId } = await seedSlot("SHIFT", 2);
    const [a, b, c] = await Promise.all([0, 1, 2].map((i) => seedPerson(eventId, i)));
    await claim(slotId, a, 1, 2); await claim(slotId, b, 1, 2);
    assert.ok(!(await claim(slotId, c, 1, 2)).ok, "third is blocked while full");
    // Cancelling deletes the commitment; positions cascade.
    await db.$executeRaw`DELETE FROM daali_helper_signups WHERE "slotId"=${slotId} AND "eventPersonId"=${a}`;
    assert.ok((await positions(slotId)).length === 1, "positions cascaded away");
    const after = await claim(slotId, c, 1, 2);
    assert.ok(after.ok, `freed position is reclaimable — got position ${after.ok ? after.positions : undefined}`);
  });

  test("adding to an existing commitment", async () => {
    const { eventId, slotId } = await seedSlot("ITEM", 6, "dozen cookies");
    const p = await seedPerson(eventId, 0);
    await claim(slotId, p, 2, 6);
    await claim(slotId, p, 1, 6);
    const rows = await db.$queryRaw<{ c: number }[]>`SELECT count(*)::int c FROM daali_helper_signups WHERE "slotId"=${slotId}`;
    const pos = await db.$queryRaw<{ c: number }[]>`
      SELECT count(*)::int c FROM daali_helper_signup_positions WHERE "slotId"=${slotId}`;
    assert.ok(rows[0].c === 1, `still ONE commitment row — ${rows[0].c} rows`);
    assert.ok(pos[0].c === 3, `quantity is derived from 3 positions — ${pos[0].c} positions`);
  });
});
