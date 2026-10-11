import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import { insertPlannedProfiles, loadBackfillPlan } from "./organizer-profile-backfill-db.ts";

// T33 against the LOCAL stack's database — Daali Slice 1, S1.7. The backfill's
// own read and write functions (the ones scripts/backfill-organizer-profiles.mts
// runs) on the seeded fixtures:
//   - the dry run grants exactly the Game Day owners that have no row yet;
//   - a rerun after an administrator removed access, and after a link granted
//     it, changes neither row;
//   - the write is INSERT … ON CONFLICT DO NOTHING (captured from Prisma's log).
//
//   node --env-file=.env.local --experimental-strip-types scripts/seed-local-auth.mts
//   DAALI_LOCAL_AUTH=1 node --env-file=.env.local --experimental-strip-types \
//     --experimental-test-module-mocks --import ./scripts/test-alias-only.mjs \
//     --test src/lib/backfill.local.test.ts
//
// SKIPPED unless DAALI_LOCAL_AUTH=1; refuses any non-loopback database. It
// writes organizer_profiles rows: re-seed afterwards.

const enabled = process.env.DAALI_LOCAL_AUTH === "1";
const DB_URL = process.env.DATABASE_URL ?? "";
const loopback = (u: string) => {
  try {
    return ["127.0.0.1", "localhost", "[::1]"].includes(new URL(u).hostname);
  } catch {
    return false;
  }
};
if (enabled && !loopback(DB_URL)) throw new Error("DAALI_LOCAL_AUTH=1 but DATABASE_URL is not loopback. Refusing.");

const queries: string[] = [];
const db = enabled
  ? new PrismaClient({ datasources: { db: { url: DB_URL } }, log: [{ emit: "event", level: "query" }] })
  : null;
db?.$on("query", (e: { query: string }) => queries.push(e.query));

async function idFor(where: string): Promise<string> {
  const [r] = await db!.$queryRawUnsafe<{ id: string }[]>(`SELECT id::text AS id FROM auth.users WHERE ${where}`);
  if (!r) throw new Error(`fixture missing (${where}): run scripts/seed-local-auth.mts`);
  return r.id;
}
const row = (userId: string) => db!.organizerProfile.findUnique({ where: { userId } });

describe("T33 backfill (local database)", { skip: !enabled && "DAALI_LOCAL_AUTH not set" }, () => {
  let phoneOwner = "", owner = "", flagHolder = "", nonOwner = "";

  before(async () => {
    phoneOwner = await idFor("phone = '15555550101'"); // Game Day owner, no row
    owner = await idFor("email = 'owner.many@example.com'"); // Game Day owner, row with flag
    flagHolder = await idFor("email = 'legacy.tester@example.com'"); // Game Day owner, row with flag
    nonOwner = await idFor("email = 'no.name@example.com'"); // no Host, no row
  });

  after(async () => {
    await db!.$disconnect();
  });

  test("dry run: the flag goes to exactly the Game Day owners without a row; no one else", async () => {
    const { plan } = await loadBackfillPlan(db!);
    const owners = (
      await db!.$queryRaw<{ id: string }[]>`
        SELECT DISTINCT h.supabase_user_id AS id FROM hosts h JOIN boards b ON b.host_id = h.id WHERE b.board_type = 'game'`
    ).map((r) => r.id);
    assert.deepEqual(new Set(owners), new Set([phoneOwner, owner, flagHolder]), "fixture shape");

    const flagged = plan.create.filter((p) => p.legacyBoardsEnabled).map((p) => p.userId);
    assert.deepEqual(flagged, [phoneOwner], "only the owner who has no row yet is planned with the flag");
    assert.ok(plan.create.some((p) => p.userId === nonOwner && !p.legacyBoardsEnabled), "a non-owner is planned without it");
    assert.ok(!plan.create.some((p) => p.userId === owner || p.userId === flagHolder), "existing rows are never planned");
    assert.deepEqual(plan.ownersWithRowWithoutFlag, []);
    // Every Game Day owner ends up entitled: the ones with rows already are.
    for (const id of [owner, flagHolder]) assert.equal((await row(id))?.legacyBoardsEnabled, true);
  });

  test("apply, then: admin removes access, a link grants access, rerun — neither row changes", async () => {
    const first = await loadBackfillPlan(db!);
    await insertPlannedProfiles(db!, first.plan);
    assert.equal((await row(phoneOwner))?.legacyBoardsEnabled, true);
    assert.equal((await row(nonOwner))?.legacyBoardsEnabled, false);

    // (a) An administrator removes Game Day access from the owner.
    await db!.organizerProfile.update({ where: { userId: phoneOwner }, data: { legacyBoardsEnabled: false } });
    // (b) An access link grants it to someone who owns no Game Day board.
    await db!.organizerProfile.update({ where: { userId: nonOwner }, data: { legacyBoardsEnabled: true } });
    const before = { removed: await row(phoneOwner), granted: await row(nonOwner) };

    queries.length = 0;
    const rerun = await loadBackfillPlan(db!);
    assert.deepEqual(rerun.plan.create.filter((p) => p.userId === phoneOwner || p.userId === nonOwner), []);
    assert.ok(rerun.plan.ownersWithRowWithoutFlag.includes(phoneOwner), "reported as a count, not changed");
    await insertPlannedProfiles(db!, rerun.plan);

    // Even a STALE plan (the first one, which still lists both users) inserts
    // nothing over them: the statement is insert-or-nothing.
    const staleInserted = await insertPlannedProfiles(db!, first.plan);
    assert.equal(staleInserted, 0);

    assert.deepEqual(await row(phoneOwner), before.removed, "access an administrator removed is not restored");
    assert.deepEqual(await row(nonOwner), before.granted, "access a link granted is not cleared");

    const writes = queries.filter((q) => /^\s*(INSERT|UPDATE|DELETE)/i.test(q) && /organizer_profiles/.test(q));
    assert.ok(writes.length > 0 && writes.every((q) => /^\s*INSERT/i.test(q) && /ON CONFLICT DO NOTHING/i.test(q)), writes.join("\n"));
  });
});
