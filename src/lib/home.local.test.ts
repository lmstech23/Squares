import { test, describe, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";

// Your Daali's read model against the LOCAL stack's database and the seeded
// fixtures — Daali Slice 1, S1.6 (T21, T22, T23).
//
//   node --env-file=.env.local --experimental-strip-types scripts/seed-local-auth.mts
//   DAALI_LOCAL_AUTH=1 node --env-file=.env.local --experimental-strip-types \
//     --experimental-test-module-mocks --import ./scripts/test-alias-only.mjs \
//     --test src/lib/home.local.test.ts
//
// SKIPPED unless DAALI_LOCAL_AUTH=1; refuses any non-loopback database.

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

const prisma = enabled ? new PrismaClient({ datasources: { db: { url: DB_URL } } }) : null;
if (enabled) mock.module("@/lib/prisma", { namedExports: { prisma } });
const { listOrganizerItems } = enabled ? await import("./organizer-items.ts") : ({} as never);

async function userId(email: string): Promise<string> {
  const [r] = await prisma!.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM auth.users WHERE email = ${email}`;
  if (!r) throw new Error(`fixture ${email} missing: run scripts/seed-local-auth.mts`);
  return r.id;
}

/**
 * Row counts and a content hash of every table Your Daali could conceivably
 * touch. Boards have no updated_at, so the whole row is hashed instead.
 */
async function snapshot() {
  const [r] = await prisma!.$queryRaw<Record<string, string>[]>`
    SELECT
      (SELECT count(*)::text || ':' || md5(coalesce(string_agg(b::text, '|' ORDER BY b.board_id), '')) FROM boards b) AS boards,
      (SELECT count(*)::text || ':' || md5(coalesce(string_agg(h::text, '|' ORDER BY h.id), '')) FROM hosts h) AS hosts,
      (SELECT count(*)::text || ':' || md5(coalesce(string_agg(c::text, '|' ORDER BY c.id), '')) FROM board_collaborators c) AS grants,
      (SELECT count(*)::text || ':' || md5(coalesce(string_agg(i::text, '|' ORDER BY i.id), '')) FROM board_invites i) AS invites,
      (SELECT count(*)::text || ':' || md5(coalesce(string_agg(p::text, '|' ORDER BY p.user_id), '')) FROM organizer_profiles p) AS profiles`;
  return r;
}

describe("Your Daali read model (local database)", { skip: !enabled && "DAALI_LOCAL_AUTH not set" }, () => {
  let owner = "", collab = "", signup = "", flag = "";

  before(async () => {
    owner = await userId("owner.many@example.com");
    collab = await userId("helper.one@example.com");
    signup = await userId("new.signup@example.com");
    flag = await userId("legacy.tester@example.com");
  });

  after(async () => {
    await prisma!.$disconnect();
  });

  test("T21: an owner sees every fundraiser except expired, as Fundraisers, newest first; no Game Day", async () => {
    const items = await listOrganizerItems(owner);
    assert.deepEqual(
      items.map((i) => [i.title, i.type, i.status, i.role]).sort(),
      [
        ["Fall Garden Fund", "FUNDRAISER", "CLOSED", "OWNER"],
        ["Spring Book Drive", "FUNDRAISER", "LIVE", "OWNER"],
        ["Summer Camp Scholarships", "FUNDRAISER", "DRAFT", "OWNER"],
        ["Winter Coat Collection", "FUNDRAISER", "CLOSED", "OWNER"],
      ]
    );
    for (let i = 1; i < items.length; i++) assert.ok(items[i - 1].updatedAt >= items[i].updatedAt, "newest first");
    for (const i of items) {
      assert.match(i.manageUrl, /^\/host\/boards\/[0-9a-f-]{36}$/);
      assert.match(i.publicUrl ?? "", /^\/board\/fixture-owner-1/);
    }
  });

  test("T21: owning is enough — the owner has no legacy_boards_visible", async () => {
    const p = await prisma!.organizerProfile.findUniqueOrThrow({ where: { userId: owner } });
    assert.equal(p.legacyBoardsVisible, false);
    assert.ok((await listOrganizerItems(owner)).length > 0);
  });

  test("a collaborator sees the fundraiser they help run, as COLLABORATOR", async () => {
    const items = await listOrganizerItems(collab);
    assert.deepEqual(items.map((i) => [i.title, i.role, i.status]), [["Spring Book Drive", "COLLABORATOR", "LIVE"]]);
  });

  test("T22: Game Day boards never appear, even for the flag holder", async () => {
    const items = await listOrganizerItems(flag);
    assert.deepEqual(items.map((i) => i.title), ["Neighborhood Library Fund"]);
  });

  test("a new SIGNUP account has no items, and listing them creates no Host", async () => {
    assert.deepEqual(await listOrganizerItems(signup), []);
    assert.equal(await prisma!.host.count({ where: { supabaseUserId: signup } }), 0);
  });

  test("T23: listing items writes nothing — row counts and contents unchanged", async () => {
    const before = await snapshot();
    for (const u of [owner, collab, signup, flag]) await listOrganizerItems(u);
    assert.deepEqual(await snapshot(), before);
  });
});
