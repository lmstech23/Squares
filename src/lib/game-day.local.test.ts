import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";
import {
  createGameDayLink,
  hashGameDayToken,
  redeemGameDayLink,
  removeGameDayAccess,
  revokeGameDayLink,
} from "./game-day-links.ts";

// T31 (and the storage half of T32) against the LOCAL stack's database —
// Daali Slice 1, S1.7. The real conditional UPDATEs, raced for real: several
// Prisma clients, so the statements run on separate connections at once.
//
//   DAALI_LOCAL_AUTH=1 node --env-file=.env.local --experimental-strip-types \
//     --experimental-test-module-mocks --import ./scripts/test-alias-only.mjs \
//     --test src/lib/game-day.local.test.ts
//
// SKIPPED unless DAALI_LOCAL_AUTH=1; refuses any non-loopback database. Works on
// temporary organizer_profiles rows (user ids that exist nowhere else) and
// temporary links, all removed afterwards.

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

const clients = enabled ? Array.from({ length: 4 }, () => new PrismaClient({ datasources: { db: { url: DB_URL } } })) : [];
const db = clients[0];
const tempUsers: string[] = [];
const tempLinks: string[] = [];

async function account(enabled = false): Promise<string> {
  const userId = `s17-test-${randomUUID()}`;
  await db.organizerProfile.create({ data: { userId, displayName: "Temp", createdVia: "SIGNUP", legacyBoardsEnabled: enabled } });
  tempUsers.push(userId);
  return userId;
}
async function link(adminUserId = "s17-test-admin") {
  const l = await createGameDayLink(db, adminUserId);
  tempLinks.push(l.id);
  return l;
}
const flag = async (userId: string) => (await db.organizerProfile.findUniqueOrThrow({ where: { userId } })).legacyBoardsEnabled;
const linkRow = (id: string) => db.daaliGameDayLink.findUniqueOrThrow({ where: { id } });

describe("Game Day links (local database)", { skip: !enabled && "DAALI_LOCAL_AUTH not set" }, () => {
  before(async () => {
    await Promise.all(clients.map((c) => c.$connect()));
  });

  after(async () => {
    await db.daaliGameDayLink.deleteMany({ where: { id: { in: tempLinks } } });
    await db.organizerProfile.deleteMany({ where: { userId: { in: tempUsers } } });
    await Promise.all(clients.map((c) => c.$disconnect()));
  });

  test("redeem: sets the flag and marks the link used, in one go", async () => {
    const u = await account();
    const l = await link();
    assert.equal(await redeemGameDayLink(db, l.token, u), "redeemed");
    assert.equal(await flag(u), true);
    const row = await linkRow(l.id);
    assert.equal(row.usedByUserId, u);
    assert.ok(row.usedAt && !row.revokedAt);
  });

  test("T31: a used link refuses the next account and grants nothing", async () => {
    const [a, b] = [await account(), await account()];
    const l = await link();
    assert.equal(await redeemGameDayLink(db, l.token, a), "redeemed");
    assert.equal(await redeemGameDayLink(db, l.token, b), "unusable");
    assert.equal(await flag(b), false);
  });

  test("T31: an expired link grants nothing and stays unused", async () => {
    const u = await account();
    const l = await link();
    await db.daaliGameDayLink.update({ where: { id: l.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    assert.equal(await redeemGameDayLink(db, l.token, u), "unusable");
    assert.equal(await flag(u), false);
    assert.equal((await linkRow(l.id)).usedAt, null);
  });

  test("T31: a revoked link grants nothing", async () => {
    const u = await account();
    const l = await link();
    assert.equal(await revokeGameDayLink(db, l.id), "revoked");
    assert.equal(await redeemGameDayLink(db, l.token, u), "unusable");
    assert.equal(await flag(u), false);
  });

  test("T31: an account that already has access leaves the link unused", async () => {
    const u = await account(true);
    const l = await link();
    assert.equal(await redeemGameDayLink(db, l.token, u), "already-entitled");
    assert.equal((await linkRow(l.id)).usedAt, null);
  });

  test("an account with no profile row cannot hold the flag; the link stays unused", async () => {
    const l = await link();
    assert.equal(await redeemGameDayLink(db, l.token, `s17-test-no-row-${randomUUID()}`), "no-profile");
    assert.equal((await linkRow(l.id)).usedAt, null);
  });

  test("T31: 20 accounts redeem ONE link at once — exactly one succeeds", async () => {
    const users = await Promise.all(Array.from({ length: 20 }, () => account()));
    const l = await link();
    const outcomes = await Promise.all(users.map((u, i) => redeemGameDayLink(clients[i % clients.length], l.token, u)));
    assert.equal(outcomes.filter((o) => o === "redeemed").length, 1, outcomes.join(","));
    assert.equal(outcomes.filter((o) => o === "unusable").length, 19);
    const winner = users[outcomes.indexOf("redeemed")];
    const flags = await Promise.all(users.map(flag));
    assert.equal(flags.filter(Boolean).length, 1);
    assert.equal((await linkRow(l.id)).usedByUserId, winner);
  });

  test("T31: redemption vs administrator revocation of the same link, 60 rounds — exactly one wins every time, and both orders occur", async () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    let redeemWins = 0;
    let revokeWins = 0;
    for (let round = 0; round < 60; round++) {
      const u = await account();
      const l = await link();
      // Redemption reads the profile before its UPDATE, so a simultaneous start
      // favours revocation. Give one side a 0-12 ms head start, alternating, so
      // the race is genuinely contested in both directions.
      const head = round % 13;
      const redeemFirst = round % 2 === 0;
      const redeemAfter = async () => {
        if (!redeemFirst) await sleep(head);
        return redeemGameDayLink(clients[1], l.token, u);
      };
      const revokeAfter = async () => {
        if (redeemFirst) await sleep(head);
        return revokeGameDayLink(clients[2], l.id);
      };
      const [redeem, revoke] = await Promise.all([redeemAfter(), revokeAfter()]);
      const row = await linkRow(l.id);
      assert.ok(!(row.usedAt && row.revokedAt), "never both used and revoked");
      if (redeem === "redeemed") {
        redeemWins++;
        assert.equal(revoke, "already-used", `round ${round}: redemption first, the revoke reports it can't be revoked as unused`);
        assert.equal(await flag(u), true);
        assert.ok(row.usedAt && !row.revokedAt);
      } else {
        revokeWins++;
        assert.equal(redeem, "unusable", `round ${round}`);
        assert.equal(revoke, "revoked", `round ${round}`);
        assert.equal(await flag(u), false, "revocation first: no access granted");
        assert.ok(row.revokedAt && !row.usedAt);
      }
    }
    console.log(`# redeem won ${redeemWins}, revoke won ${revokeWins}`);
    assert.equal(redeemWins + revokeWins, 60);
    assert.ok(redeemWins > 0 && revokeWins > 0, "both outcomes were exercised");
  });

  test("the database itself refuses a link that is both used and revoked", async () => {
    const l = await link();
    await assert.rejects(
      db.daaliGameDayLink.update({ where: { id: l.id }, data: { usedAt: new Date(), usedByUserId: "x", revokedAt: new Date() } }),
      /daali_game_day_links_used_or_revoked_check|23514|check constraint/i
    );
  });

  test("T32: only the hash is stored — the token appears nowhere in the row", async () => {
    const l = await link();
    const [r] = await db.$queryRaw<{ t: string; h: string }[]>`
      SELECT row_to_json(x)::text AS t, x.token_hash AS h FROM daali_game_day_links x WHERE x.id = ${l.id}::uuid`;
    assert.equal(r.h, hashGameDayToken(l.token));
    assert.ok(!r.t.includes(l.token));
  });

  test("T32: removing access clears the flag only", async () => {
    const u = await account(true);
    assert.equal(await removeGameDayAccess(db, u), true);
    assert.equal(await flag(u), false);
    assert.equal(await removeGameDayAccess(db, u), false, "nothing left to remove");
  });
});
