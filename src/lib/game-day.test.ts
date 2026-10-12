import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAdminUserIds } from "./admin.ts";
import { allowedNext } from "./next-path.ts";
import { postAuthDestination } from "./post-auth-destination.ts";
import { hashGameDayToken, linkStatus } from "./game-day-links.ts";

// Game Day access, Daali Slice 1 S1.7 — the pure pieces and the shape of every
// administrator handler. The real-database behaviour (concurrency, revoke vs
// redeem) is game-day.local.test.ts; the endpoints over HTTP are in the S1.7
// browser walkthrough.

const TOKEN = "Abc_DEF-123456789012345678901234567890abcde";

describe("administrators: DAALI_ADMIN_USER_IDS", () => {
  test("comma-separated, trimmed, blanks ignored", () => {
    assert.deepEqual([...parseAdminUserIds(" a , b,,c ")], ["a", "b", "c"]);
    assert.equal(parseAdminUserIds(undefined).size, 0);
    assert.equal(parseAdminUserIds("").size, 0);
  });
});

describe("/gameday/<token> as a next", () => {
  test("allowlisted; still refuses traversal and encoding tricks", () => {
    assert.equal(allowedNext(`/gameday/${TOKEN}`), `/gameday/${TOKEN}`);
    for (const bad of ["/gameday/short", `/gameday/${TOKEN}/x`, `/gameday/${TOKEN}?a=1`, "//gameday/x", `/gameday/../host/${TOKEN}`]) {
      assert.equal(allowedNext(bad), null, bad);
    }
  });

  test("COMPLETE goes straight to the link; anything less goes through /setup carrying it (ruled Oct 11)", () => {
    const next = `/gameday/${TOKEN}`;
    assert.equal(postAuthDestination("COMPLETE", next), next);
    for (const s of ["NO_PROFILE", "SETUP_INCOMPLETE"] as const) {
      assert.equal(postAuthDestination(s, next), `/setup?next=${encodeURIComponent(next)}`, s);
    }
    assert.equal(postAuthDestination("SIGNED_OUT", next), "/sign-in");
  });
});

describe("links: status and hashing", () => {
  const now = new Date("2026-10-12T00:00:00Z");
  const base = { usedAt: null, revokedAt: null, expiresAt: new Date("2026-10-20T00:00:00Z") };
  test("unused, used, expired, revoked", () => {
    assert.equal(linkStatus(base, now), "unused");
    assert.equal(linkStatus({ ...base, usedAt: now }, now), "used");
    assert.equal(linkStatus({ ...base, expiresAt: now }, now), "expired");
    assert.equal(linkStatus({ ...base, revokedAt: now }, now), "revoked");
  });
  test("only a SHA-256 is stored: 64 hex characters, never the token", () => {
    const h = hashGameDayToken(TOKEN);
    assert.match(h, /^[0-9a-f]{64}$/);
    assert.notEqual(h, TOKEN);
  });
});

// T32 (structure): every administrator handler checks the administrator itself,
// as its FIRST statement, before any read or write.
describe("every administrator endpoint checks the administrator first", () => {
  const api = join(import.meta.dirname, "..", "app", "api", "admin", "game-day");
  const handlers: [string, string][] = [
    ["links/route.ts", "GET"],
    ["links/route.ts", "POST"],
    ["links/[id]/revoke/route.ts", "POST"],
    ["access/[userId]/remove/route.ts", "POST"],
  ];
  for (const [file, method] of handlers) {
    test(`${method} ${file}`, () => {
      const src = readFileSync(join(api, file), "utf8");
      const start = src.indexOf(`export async function ${method}(`);
      assert.ok(start >= 0, "handler exists");
      const body = src.slice(src.indexOf("{", src.indexOf(")", start)) + 1);
      const firstStatement = body.trimStart().split("\n")[0];
      assert.match(firstStatement, /getAdminUserId\(\)/, `first statement: ${firstStatement}`);
      assert.match(src, /status: 404/, "refuses with 404");
    });
  }

  test("the admin page checks before it reads, and the check never reads hosts", () => {
    const page = readFileSync(join(import.meta.dirname, "..", "app", "(daali)", "admin", "game-day", "page.tsx"), "utf8");
    const check = page.indexOf("await getAdminUserId()");
    assert.ok(check > 0 && check < page.indexOf("listGameDayLinks(prisma)") && check < page.indexOf("listGameDayAccounts(prisma)"));
    assert.match(page, /if \(!adminUserId\) notFound\(\);/);
    const code = readFileSync(join(import.meta.dirname, "admin.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    assert.doesNotMatch(code, /prisma|hosts|getHost/, "the check reads the session and the env list only");
  });
});
