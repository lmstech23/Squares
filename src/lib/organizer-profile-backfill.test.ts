import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  planOrganizerProfiles,
  maskEmail,
  type AuthUserRow,
  type HostNameRow,
} from "./organizer-profile-backfill.ts";

// The organizer_profiles backfill, Daali Slice 1 S1.1. Pure planning only; the
// script that reads auth.users and hosts and writes the rows is separate.

const user = (id: string, email: string | null, isAnonymous = false): AuthUserRow => ({ id, email, isAnonymous });
const host = (supabaseUserId: string | null, name: string | null): HostNameRow => ({ supabaseUserId, name });

describe("planOrganizerProfiles", () => {
  test("anonymous users are excluded", () => {
    const plan = planOrganizerProfiles(
      [user("u-anon", null, true), user("u-anon-email", "anon@example.com", true), user("u-real", "real@example.com")],
      []
    );
    assert.deepEqual(plan.map((p) => p.userId), ["u-real"]);
  });

  test("Host.name is copied into display_name, trimmed", () => {
    const plan = planOrganizerProfiles([user("u1", "a@example.com")], [host("u1", "  Daaliyah Tate  ")]);
    assert.equal(plan.length, 1);
    assert.equal(plan[0].displayName, "Daaliyah Tate");
  });

  test("a user with no Host still gets a profile, with a null display_name", () => {
    const plan = planOrganizerProfiles([user("u1", "a@example.com")], [host("someone-else", "Other Person")]);
    assert.deepEqual(plan, [
      { userId: "u1", displayName: null, legacyBoardsVisible: false, createdVia: "BACKFILL" },
    ]);
  });

  test("a Host with an empty or blank name gives a null display_name", () => {
    const plan = planOrganizerProfiles(
      [user("u-empty", "e@example.com"), user("u-blank", "b@example.com"), user("u-null", "n@example.com")],
      [host("u-empty", ""), host("u-blank", "   "), host("u-null", null)]
    );
    assert.deepEqual(plan.map((p) => p.displayName), [null, null, null]);
  });

  test("--legacy-tester makes legacy Boards visible for that email only", () => {
    const users = [user("u1", "Tester@Example.com"), user("u2", "other@example.com"), user("u3", null)];
    const plan = planOrganizerProfiles(users, [], { legacyTesterEmail: "  tester@example.COM " });
    assert.deepEqual(
      plan.map((p) => [p.userId, p.legacyBoardsVisible]),
      [["u1", true], ["u2", false], ["u3", false]]
    );
  });

  test("without --legacy-tester nobody's legacy Boards are visible", () => {
    const plan = planOrganizerProfiles([user("u1", "tester@example.com"), user("u2", "o@example.com")], []);
    assert.ok(plan.every((p) => p.legacyBoardsVisible === false));
  });

  test("every planned row is created_via BACKFILL", () => {
    const plan = planOrganizerProfiles([user("u1", "a@example.com"), user("u2", null)], []);
    assert.ok(plan.length === 2 && plan.every((p) => p.createdVia === "BACKFILL"));
  });

  test("users who already have a profile are skipped, so a re-run plans nothing new", () => {
    const users = [user("u1", "a@example.com"), user("u2", "b@example.com")];
    assert.deepEqual(planOrganizerProfiles(users, [], { existingUserIds: ["u1"] }).map((p) => p.userId), ["u2"]);
    assert.deepEqual(planOrganizerProfiles(users, [], { existingUserIds: ["u1", "u2"] }), []);
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
