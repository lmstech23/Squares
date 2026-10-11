import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  planOrganizerProfiles,
  maskEmail,
  type AuthUserRow,
  type HostNameRow,
} from "./organizer-profile-backfill.ts";

// The organizer_profiles backfill — Daali Slice 1 S1.1, with Game Day access
// from S1.7 (Auth spec, "Backfill for existing users", amended Oct 11). Pure
// planning only; the reads and the one insert-only write are in
// organizer-profile-backfill-db.ts, exercised against a real database by
// backfill.local.test.ts.

const user = (id: string, email: string | null, isAnonymous = false): AuthUserRow => ({ id, email, isAnonymous });
const host = (supabaseUserId: string | null, name: string | null): HostNameRow => ({ supabaseUserId, name });
const plan = (users: AuthUserRow[], hosts: HostNameRow[] = [], owners: string[] = [], existing: { userId: string; legacyBoardsEnabled: boolean }[] = []) =>
  planOrganizerProfiles({ users, hosts, gameDayOwnerUserIds: owners, existingProfiles: existing });

describe("planOrganizerProfiles", () => {
  test("anonymous users are excluded", () => {
    const p = plan([user("u-anon", null, true), user("u-anon-email", "anon@example.com", true), user("u-real", "real@example.com")]);
    assert.deepEqual(p.create.map((r) => r.userId), ["u-real"]);
  });

  test("Host.name is copied into display_name, trimmed", () => {
    const p = plan([user("u1", "a@example.com")], [host("u1", "  Daaliyah Tate  ")]);
    assert.equal(p.create[0].displayName, "Daaliyah Tate");
  });

  test("a user with no Host still gets a profile, with a null display_name and no Game Day", () => {
    assert.deepEqual(plan([user("u1", "a@example.com")], [host("someone-else", "Other Person")]).create, [
      { userId: "u1", displayName: null, legacyBoardsEnabled: false, createdVia: "BACKFILL" },
    ]);
  });

  test("a Host with an empty or blank name gives a null display_name", () => {
    const p = plan(
      [user("u-empty", "e@example.com"), user("u-blank", "b@example.com"), user("u-null", "n@example.com")],
      [host("u-empty", ""), host("u-blank", "   "), host("u-null", null)]
    );
    assert.deepEqual(p.create.map((r) => r.displayName), [null, null, null]);
  });

  test("T33: legacy_boards_enabled is true for exactly the Game Day owners", () => {
    const users = [user("owner-a", "a@example.com"), user("owner-b", null), user("fundraiser-only", "f@example.com"), user("none", "n@example.com")];
    const p = plan(users, [], ["owner-a", "owner-b"]);
    assert.deepEqual(
      p.create.map((r) => [r.userId, r.legacyBoardsEnabled]),
      [["owner-a", true], ["owner-b", true], ["fundraiser-only", false], ["none", false]]
    );
  });

  test("every planned row is created_via BACKFILL", () => {
    const p = plan([user("u1", "a@example.com"), user("u2", null)]);
    assert.ok(p.create.length === 2 && p.create.every((r) => r.createdVia === "BACKFILL"));
  });

  test("INSERT-ONLY: a user who already has a row is never planned, whatever their flag", () => {
    const users = [user("u1", "a@example.com"), user("u2", "b@example.com")];
    const p = plan(users, [], ["u1", "u2"], [
      { userId: "u1", legacyBoardsEnabled: false }, // access removed by an administrator
      { userId: "u2", legacyBoardsEnabled: true },
    ]);
    assert.deepEqual(p.create, []);
  });

  test("a rerun cannot clear access a link granted (non-owner with the flag is left alone)", () => {
    const p = plan([user("granted", "g@example.com")], [], [], [{ userId: "granted", legacyBoardsEnabled: true }]);
    assert.deepEqual(p.create, []);
    assert.deepEqual(p.ownersWithRowWithoutFlag, []);
  });

  test("a Game Day owner with a row but no flag is only counted, never changed", () => {
    const p = plan([user("owner", "o@example.com"), user("other", "x@example.com")], [], ["owner"], [
      { userId: "owner", legacyBoardsEnabled: false },
      { userId: "other", legacyBoardsEnabled: false },
    ]);
    assert.deepEqual(p.ownersWithRowWithoutFlag, ["owner"]);
    assert.deepEqual(p.create, []);
  });
});

describe("maskEmail", () => {
  test("keeps only the first character of local part and domain, and the TLD", () => {
    assert.equal(maskEmail("sarah.jones@example.com"), "s**********@e******.com");
    assert.equal(maskEmail("a@b.io"), "a@b.io");
  });
  test("handles missing or malformed input without echoing it", () => {
    assert.equal(maskEmail(null), "(no email)");
    assert.equal(maskEmail("not-an-email"), "************");
  });
});
