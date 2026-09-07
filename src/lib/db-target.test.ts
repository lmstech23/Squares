import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  deriveProjectRef,
  expectedProductionRef,
  assertProductionTarget,
  WrongDatabaseError,
  PRODUCTION_DB_REF_VAR,
  DEFAULT_PRODUCTION_DB_REF,
} from "./db-target.ts";

// The guard that stands in front of every production migration.
//
// The passwords below are obvious fakes. Nothing in this file is a real
// credential, and nothing in db-target.ts ever prints the string it is given.

const PROD = DEFAULT_PRODUCTION_DB_REF;
const OTHER = "abcdefghijklmnopqrst";

const pooler = (ref: string) =>
  `postgresql://postgres.${ref}:NOT-A-REAL-PASSWORD@aws-0-us-east-1.pooler.supabase.com:6543/postgres`;
const direct = (ref: string) =>
  `postgresql://postgres:NOT-A-REAL-PASSWORD@db.${ref}.supabase.co:5432/postgres`;

describe("deriving the project ref", () => {
  test("reads a pooler string", () => {
    assert.equal(deriveProjectRef(pooler(PROD)), PROD);
  });

  test("reads a direct string", () => {
    assert.equal(deriveProjectRef(direct(PROD)), PROD);
  });

  // Everything below is a REFUSAL at the call site, not a "not production".
  test("a local database yields no ref", () => {
    assert.equal(
      deriveProjectRef("postgresql://postgres:daali@localhost:55432/daali_test"),
      null
    );
  });

  test("an empty or absent string yields no ref", () => {
    assert.equal(deriveProjectRef(""), null);
    assert.equal(deriveProjectRef(undefined), null);
    assert.equal(deriveProjectRef(null), null);
  });

  test("a non-Supabase host yields no ref", () => {
    assert.equal(
      deriveProjectRef("postgresql://user:pw@db.example.com:5432/postgres"),
      null
    );
  });
});

describe("the expected ref is configuration, not source", () => {
  test("defaults to the established production project", () => {
    assert.equal(expectedProductionRef({}), PROD);
  });

  test("an environment value overrides the default", () => {
    assert.equal(
      expectedProductionRef({ [PRODUCTION_DB_REF_VAR]: OTHER }),
      OTHER
    );
  });

  // A variable that is present but blank is a set-and-forgot mistake, not an
  // instruction to accept anything.
  test("a blank value falls back rather than matching nothing", () => {
    assert.equal(expectedProductionRef({ [PRODUCTION_DB_REF_VAR]: "   " }), PROD);
  });
});

describe("assertProductionTarget", () => {
  test("passes on the expected production project, both string shapes", () => {
    assert.deepEqual(assertProductionTarget(pooler(PROD), {}), { ref: PROD });
    assert.deepEqual(assertProductionTarget(direct(PROD), {}), { ref: PROD });
  });

  // THE REGRESSION THIS FILE EXISTS FOR. A different Supabase project that
  // connects perfectly well and answers every query is exactly what produced a
  // false PASS on 2026-09-06.
  test("refuses a different Supabase project", () => {
    assert.throws(
      () => assertProductionTarget(pooler(OTHER), {}),
      (err: unknown) =>
        err instanceof WrongDatabaseError && err.reason === "mismatch"
    );
  });

  test("refuses a local database rather than treating it as harmless", () => {
    assert.throws(
      () =>
        assertProductionTarget(
          "postgresql://postgres:daali@localhost:55432/daali_test",
          {}
        ),
      (err: unknown) =>
        err instanceof WrongDatabaseError && err.reason === "underivable"
    );
  });

  test("refuses when no connection string was supplied", () => {
    assert.throws(
      () => assertProductionTarget(undefined, {}),
      (err: unknown) =>
        err instanceof WrongDatabaseError && err.reason === "missing"
    );
  });

  test("an override makes the previously-refused project the accepted one", () => {
    const env = { [PRODUCTION_DB_REF_VAR]: OTHER };
    assert.deepEqual(assertProductionTarget(pooler(OTHER), env), { ref: OTHER });
    assert.throws(
      () => assertProductionTarget(pooler(PROD), env),
      (err: unknown) =>
        err instanceof WrongDatabaseError && err.reason === "mismatch"
    );
  });

  // The message is read by whoever is mid-deploy. It must identify the problem
  // without leaking the string.
  test("no message ever contains the connection string", () => {
    for (const url of [pooler(OTHER), "postgresql://postgres:daali@localhost:5432/x"]) {
      try {
        assertProductionTarget(url, {});
        assert.fail("should have refused");
      } catch (err) {
        const msg = (err as Error).message;
        assert.ok(!msg.includes("NOT-A-REAL-PASSWORD"), "leaked a password");
        assert.ok(!msg.includes("daali@"), "leaked credentials");
        assert.ok(!msg.includes("postgresql://"), "leaked the connection string");
      }
    }
  });
});
