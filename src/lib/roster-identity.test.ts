import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeEmail,
  normalizePhone,
  identityKeys,
  matchIdentity,
} from "./roster-identity.ts";

// Written BEFORE anything reads these, and before the backfill that runs 63
// production phone numbers through normalizePhone.

describe("normalizeEmail", () => {
  test("trims and lowercases", () => {
    assert.equal(normalizeEmail("  Liyah@Example.COM "), "liyah@example.com");
  });

  // Provider folklore, deliberately not implemented. `a.b@` and `ab@` are one
  // inbox at Gmail and two addresses almost everywhere else.
  test("does NOT strip Gmail dots", () => {
    assert.equal(normalizeEmail("a.b@gmail.com"), "a.b@gmail.com");
    assert.notEqual(normalizeEmail("a.b@gmail.com"), normalizeEmail("ab@gmail.com"));
  });

  test("does NOT strip +tags", () => {
    assert.equal(normalizeEmail("me+daali@x.com"), "me+daali@x.com");
    assert.notEqual(normalizeEmail("me+daali@x.com"), normalizeEmail("me@x.com"));
  });

  // Empty after trimming is ABSENT, not a key. There is no empty-string
  // fallthrough any more.
  test("absent values are null", () => {
    for (const v of ["", "   ", null, undefined]) {
      assert.equal(normalizeEmail(v), null);
    }
  });
});

describe("normalizePhone", () => {
  // The ruling, as a number: a bare ten digits and the same with a leading 1
  // are the same phone.
  test("10 digits and 1+10 digits are the same phone", () => {
    assert.equal(normalizePhone("6785551234"), "+16785551234");
    assert.equal(normalizePhone("16785551234"), "+16785551234");
    assert.equal(normalizePhone("6785551234"), normalizePhone("16785551234"));
  });

  test("formatting is irrelevant", () => {
    const want = "+16785551234";
    for (const v of [
      "(678) 555-1234",
      "678-555-1234",
      "678.555.1234",
      " 678 555 1234 ",
      "1 (678) 555-1234",
      "+1 678 555 1234",
    ]) {
      assert.equal(normalizePhone(v), want, v);
    }
  });

  // US-DEFAULT, not US-only. A leading + is trusted as international.
  test("an explicit country code is preserved", () => {
    assert.equal(normalizePhone("+44 20 7946 0958"), "+442079460958");
    assert.equal(normalizePhone("+33612345678"), "+33612345678");
  });

  // Never guesses. A short or malformed value is rejected so the caller can
  // say so, rather than padded into a number that belongs to someone else.
  test("unusable values are null, never guessed", () => {
    for (const v of [
      "",
      "   ",
      null,
      undefined,
      "555-1234", // 7 digits, no area code
      "abc",
      "12345",
      "123456789012345678", // 18 digits, no +
      "+123", // + with too few digits
    ]) {
      assert.equal(normalizePhone(v), null, JSON.stringify(v));
    }
  });

  // THE BACKFILL ASSERTION, as a property: normalizing an already-normalized
  // value must change nothing, or re-running the backfill would corrupt it.
  test("normalizing twice is a no-op", () => {
    for (const v of ["6785551234", "1 (678) 555-1234", "+442079460958"]) {
      const once = normalizePhone(v)!;
      assert.equal(normalizePhone(once), once, v);
    }
  });

  // Both shapes present in production today.
  test("the two shapes in production both normalize", () => {
    assert.equal(normalizePhone("6785237571"), "+16785237571");
    assert.equal(normalizePhone("16785237571"), "+16785237571");
  });
});

describe("identityKeys", () => {
  test("both keys, both mandatory", () => {
    assert.deepEqual(identityKeys({ email: " A@X.com ", phone: "(678) 555-1234" }), {
      emailKey: "a@x.com",
      phoneKey: "+16785551234",
    });
  });

  test("a missing or unusable field is an error, never a partial identity", () => {
    assert.deepEqual(identityKeys({ email: "  ", phone: "6785551234" }), { error: "email" });
    assert.deepEqual(identityKeys({ email: "a@x.com", phone: "  " }), { error: "phone" });
    assert.deepEqual(identityKeys({ email: "a@x.com", phone: "555-1234" }), { error: "phone" });
  });
});

describe("matchIdentity", () => {
  const keys = { emailKey: "a@x.com", phoneKey: "+16785551234" };

  test("email wins when both would match different identities", () => {
    const byEmail = new Map([["a@x.com", "BY_EMAIL"]]);
    const byPhone = new Map([["+16785551234", "BY_PHONE"]]);
    assert.equal(matchIdentity(byEmail, byPhone, keys), "BY_EMAIL");
  });

  // THE ONLY PATH PHONE IDENTITY TAKES now that both fields are mandatory:
  // a new email on a known phone binds to the existing identity.
  test("a new email on a known phone binds to the existing identity", () => {
    const byEmail = new Map<string, string>();
    const byPhone = new Map([["+16785551234", "EXISTING"]]);
    assert.equal(matchIdentity(byEmail, byPhone, keys), "EXISTING");
  });

  test("neither matching means a new identity, not a rejection", () => {
    assert.equal(matchIdentity(new Map(), new Map(), keys), null);
  });

  // `email OR phone` would chain A-B-C transitively. Ordered lookup binds to
  // at most one, and this is the shape that proves it: the phone map holds a
  // DIFFERENT identity, and it is not consulted.
  test("never ORs the two", () => {
    const byEmail = new Map([["a@x.com", "A"]]);
    const byPhone = new Map([["+16785551234", "C"]]);
    assert.equal(matchIdentity(byEmail, byPhone, keys), "A");
  });
});
