import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";

// Daali Slice 1 S1.4, the pure pieces of the account screens:
//   - which method "Email or mobile number" chooses (Auth spec, Welcome back)
//   - which Supabase error means "no account for that identifier"
//   - the row finalize would insert, and when it does not apply
//   - where /login sends a request: /sign-in, keeping next (the 308 itself is
//     checked against the running server)
//
// NO DATABASE, NO SUPABASE. The local-stack flows are in
// auth-flows.local.test.ts.

mock.module("@/lib/prisma", { namedExports: { prisma: {} } });

const { parseSignInIdentifier, normalizePhone } = await import("./sign-in-identifier.ts");
const { isUnknownIdentifier } = await import("./auth-errors.ts");
const { profileSeedFor } = await import("./finalize-organizer.ts");
const { loginRedirectTarget } = await import("./login-redirect.ts");

describe("parseSignInIdentifier", () => {
  test("anything with @ is an email, trimmed", () => {
    assert.deepEqual(parseSignInIdentifier("  pat@example.com "), { kind: "email", email: "pat@example.com" });
  });

  test("US numbers normalize to E.164", () => {
    for (const raw of ["5555550101", "(555) 555-0101", "555.555.0101", "1 555 555 0101", "+1 555-555-0101"]) {
      assert.deepEqual(parseSignInIdentifier(raw), { kind: "phone", phone: "+15555550101" }, raw);
    }
  });

  test("an explicit + keeps the number as given, 8 to 15 digits", () => {
    assert.equal(normalizePhone("+44 20 7946 0958"), "+442079460958");
    assert.equal(normalizePhone("+1234567"), null);
    assert.equal(normalizePhone("+1234567890123456"), null);
  });

  test("anything else is neither", () => {
    for (const raw of ["", "pat", "555-0101", "55555501011", "2555550101x", "call me"]) {
      assert.deepEqual(parseSignInIdentifier(raw), { kind: "invalid" }, raw);
    }
  });
});

describe("isUnknownIdentifier", () => {
  test("Supabase's refusal for an unknown email or phone", () => {
    assert.equal(isUnknownIdentifier({ code: "otp_disabled", status: 422, message: "Signups not allowed for otp" }), true);
    assert.equal(isUnknownIdentifier({ message: "Signups not allowed for otp" }), true);
  });

  test("every other error is not", () => {
    assert.equal(isUnknownIdentifier(null), false);
    assert.equal(isUnknownIdentifier({ code: "over_email_send_rate_limit", status: 429 }), false);
    assert.equal(isUnknownIdentifier({ code: "phone_provider_disabled", message: "Unsupported phone provider" }), false);
  });
});

const base = {
  id: "u1",
  is_anonymous: false,
  email: "pat@example.com",
  email_confirmed_at: "2026-10-10T00:00:00Z",
  app_metadata: {},
  user_metadata: {},
  identities: [],
};

describe("profileSeedFor (finalize)", () => {
  test("a confirmed-email user gets a SIGNUP row with nothing prefilled", () => {
    assert.deepEqual(profileSeedFor(base), { userId: "u1", displayName: null, avatarUrl: null, createdVia: "SIGNUP" });
  });

  test("Google prefills the name and picture, trimmed", () => {
    const google = {
      ...base,
      app_metadata: { provider: "google", providers: ["google"] },
      user_metadata: { full_name: "  Pat Morgan ", picture: "https://example.com/p.png" },
    };
    assert.deepEqual(profileSeedFor(google), {
      userId: "u1",
      displayName: "Pat Morgan",
      avatarUrl: "https://example.com/p.png",
      createdVia: "SIGNUP",
    });
  });

  test("metadata from a non-Google sign-in is not used", () => {
    const seed = profileSeedFor({ ...base, user_metadata: { full_name: "Someone" } });
    assert.equal(seed?.displayName, null);
  });

  test("not applicable: no user, anonymous, no email, or an unconfirmed email", () => {
    assert.equal(profileSeedFor(null), null);
    assert.equal(profileSeedFor({ ...base, is_anonymous: true }), null);
    assert.equal(profileSeedFor({ ...base, email: undefined, email_confirmed_at: undefined }), null);
    assert.equal(profileSeedFor({ ...base, email_confirmed_at: undefined }), null);
  });
});

describe("/login", () => {
  test("goes to /sign-in", () => {
    assert.equal(loginRedirectTarget({}), "/sign-in");
  });

  test("keeps next, and the rest of the query", () => {
    const next = "/invite/" + "a".repeat(43);
    assert.equal(loginRedirectTarget({ next }), `/sign-in?next=${encodeURIComponent(next)}`);
    assert.equal(loginRedirectTarget({ error: "auth" }), "/sign-in?error=auth");
    assert.equal(loginRedirectTarget({ a: ["1", "2"], b: undefined }), "/sign-in?a=1&a=2");
  });
});
