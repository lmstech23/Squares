import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { postAuthDestination } from "./post-auth-destination.ts";
import { setupSteps, checkDisplayName, e164 } from "./setup-steps.ts";

// Daali Slice 1 S1.5 — the pure pieces of /setup and the post-auth gate.
// The flows against Supabase are in setup-flows.local.test.ts.

const BOARD = "0b6f3c1e-8d2a-4f5b-9c7e-1a2b3c4d5e6f";
const INVITE = "/invite/" + "a".repeat(43);

describe("postAuthDestination: where each resolver state lands", () => {
  test("SIGNED_OUT goes to /sign-in, whatever next says", () => {
    assert.equal(postAuthDestination("SIGNED_OUT", null), "/sign-in");
    assert.equal(postAuthDestination("SIGNED_OUT", `/host/boards/${BOARD}`), "/sign-in");
  });

  test("NO_PROFILE and SETUP_INCOMPLETE go to /setup", () => {
    for (const s of ["NO_PROFILE", "SETUP_INCOMPLETE"] as const) {
      assert.equal(postAuthDestination(s, null), "/setup", s);
      assert.equal(postAuthDestination(s, "//evil.com"), "/setup", s);
      assert.equal(postAuthDestination(s, "/home"), "/setup", s);
    }
  });

  test("COMPLETE lands on /home (S1.6), including when next is /home", () => {
    assert.equal(postAuthDestination("COMPLETE", null), "/home");
    assert.equal(postAuthDestination("COMPLETE", "/setup"), "/home");
    assert.equal(postAuthDestination("COMPLETE", "/home"), "/home");
    assert.equal(postAuthDestination("COMPLETE", "//evil.com"), "/home");
  });

  test("T16: no state and no next leads to a retired legacy destination", () => {
    const nexts = [null, "/host", "/host/boards", "/host/boards/new", "/host/payment-setup", "/host/stripe", "/host/stripe/return", "/login", "/home", "/setup"];
    for (const s of ["SIGNED_OUT", "NO_PROFILE", "SETUP_INCOMPLETE", "COMPLETE"] as const) {
      for (const n of nexts) {
        const d = postAuthDestination(s, n);
        assert.ok(!d.startsWith("/host"), `${s} next=${n} -> ${d}`);
      }
    }
  });

  test("an allowlisted /host or /invite next is honoured for any signed-in state (T15, T18)", () => {
    for (const s of ["NO_PROFILE", "SETUP_INCOMPLETE", "COMPLETE"] as const) {
      assert.equal(postAuthDestination(s, `/host/boards/${BOARD}/donations`), `/host/boards/${BOARD}/donations`, s);
      assert.equal(postAuthDestination(s, INVITE), INVITE, s);
    }
  });
});

const CONFIRMED = "2026-10-10T00:00:00Z";
const u = (o: { phone?: boolean; email?: boolean; newPhone?: string; newEmail?: string } = {}) => ({
  phone_confirmed_at: o.phone ? CONFIRMED : undefined,
  email_confirmed_at: o.email ? CONFIRMED : undefined,
  new_phone: o.newPhone,
  new_email: o.newEmail,
});

describe("setupSteps: /setup shows only what's missing (T14)", () => {
  test("nothing missing: no steps", () => {
    assert.deepEqual(setupSteps(u({ phone: true, email: true }), { displayName: "Pat" }), []);
  });

  test("name only", () => {
    assert.deepEqual(setupSteps(u({ phone: true, email: true }), { displayName: "  " }), [
      { step: "details", askName: true, askPhone: false },
    ]);
  });

  test("phone only", () => {
    assert.deepEqual(setupSteps(u({ email: true }), { displayName: "Pat" }), [
      { step: "details", askName: false, askPhone: true },
    ]);
  });

  test("a new account: name and phone on one screen", () => {
    assert.deepEqual(setupSteps(u({ email: true }), { displayName: null }), [
      { step: "details", askName: true, askPhone: true },
    ]);
  });

  test("a code already sent to a new number resumes at the code (Screen 4)", () => {
    assert.deepEqual(setupSteps(u({ email: true, newPhone: "15555550105" }), { displayName: "Pat" }), [
      { step: "phone-code", phone: "+15555550105", askName: false },
    ]);
  });

  test("name saved, code sent: resumes at the code, the name is not asked again", () => {
    const [first] = setupSteps(u({ email: true, newPhone: "15555550105" }), { displayName: "Pat" });
    assert.equal(first.step, "phone-code");
  });

  test("existing phone-only account with a profile: name if missing, then email", () => {
    assert.deepEqual(setupSteps(u({ phone: true }), { displayName: null }), [
      { step: "details", askName: true, askPhone: false },
      { step: "email", pendingEmail: null },
    ]);
    assert.deepEqual(setupSteps(u({ phone: true }), { displayName: "Pat" }), [{ step: "email", pendingEmail: null }]);
  });

  test("a pending email resumes with the pending address (T27)", () => {
    assert.deepEqual(setupSteps(u({ phone: true, newEmail: "pat@example.com" }), { displayName: "Pat" }), [
      { step: "email", pendingEmail: "pat@example.com" },
    ]);
  });

  test("no profile row and no email: the email comes first; the name waits for the row", () => {
    assert.deepEqual(setupSteps(u({ phone: true }), null), [{ step: "email", pendingEmail: null }]);
  });

  test("a pending value is ignored once the field is confirmed", () => {
    assert.deepEqual(setupSteps(u({ phone: true, email: true, newPhone: "15555550105", newEmail: "x@example.com" }), { displayName: "Pat" }), []);
  });

  test("e164 adds the plus Supabase leaves off", () => {
    assert.equal(e164("15555550105"), "+15555550105");
    assert.equal(e164("+15555550105"), "+15555550105");
  });
});

describe("checkDisplayName: required, 1 to 60 characters, trimmed", () => {
  test("accepts and trims", () => {
    assert.deepEqual(checkDisplayName("  Pat Morgan "), { ok: true, name: "Pat Morgan" });
    assert.deepEqual(checkDisplayName("P"), { ok: true, name: "P" });
    assert.deepEqual(checkDisplayName("x".repeat(60)), { ok: true, name: "x".repeat(60) });
  });

  test("refuses empty, blank and over 60", () => {
    for (const raw of ["", "   ", "x".repeat(61), ` ${"x".repeat(61)} `]) assert.deepEqual(checkDisplayName(raw), { ok: false }, JSON.stringify(raw));
  });
});

// T13: no setup code path calls signInWithOtp({ phone }). Read every file the
// /setup route and its helpers are built from, and refuse any signInWithOtp
// call at all — setup only ever attaches (updateUser), so it cannot sign in or
// create a user.
describe("T13: setup never calls signInWithOtp", () => {
  const root = join(import.meta.dirname, "..");
  const setupDir = join(root, "app", "(daali)", "setup");
  const files = [
    ...readdirSync(setupDir).map((f) => join(setupDir, f)),
    join(root, "lib", "save-display-name.ts"),
    join(root, "lib", "setup-steps.ts"),
  ];

  test("no file in the setup path contains a signInWithOtp call", () => {
    assert.ok(files.length >= 4);
    for (const f of files) {
      assert.doesNotMatch(readFileSync(f, "utf8"), /\.signInWithOtp\s*\(/, f);
    }
  });

  test("the phone step attaches with updateUser and verifies as phone_change", () => {
    const flow = readFileSync(join(setupDir, "setup-flow.tsx"), "utf8");
    assert.match(flow, /\.updateUser\(\{ phone: e164 \}\)/);
    assert.match(flow, /verifyType="phone_change"/);
    assert.match(flow, /verifyType="email_change"/);
  });
});
