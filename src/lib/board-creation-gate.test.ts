import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  boardCreationGate,
  parsePaymentPreference,
  type BoardCreationGateHost,
} from "./board-creation-gate.ts";

// R1-R11 from board-new-gate-fix.md §7.
//
// Both gates — the `/host/boards/new` page and `POST /api/boards` — call this
// one function, so a case proved here is proved for both. That is the reason
// the function exists: the two gates drifted apart once already, and `b771c68`
// reverting the same fix in both files on the same day is what a duplicated
// condition buys you.
//
// THIS FILE IS THE REGRESSION GUARD §6 ASKS FOR. Something reverted this fix
// once and can revert it again; a red test here is the only thing that would
// say so before a host does.

function host(over: Partial<BoardCreationGateHost> = {}): BoardCreationGateHost {
  return {
    id: "host_test",
    paymentPreference: "cash",
    stripeChargesEnabled: false,
    ...over,
  };
}

describe("boardCreationGate — R1-R11", () => {
  test("R1 cash host, Stripe not enabled -> allowed (the primary case)", () => {
    const gate = boardCreationGate(
      host({ paymentPreference: "cash", stripeChargesEnabled: false })
    );
    assert.equal(gate.allow, true);
  });

  test("R2 stripe host, not enabled -> refused to /host/stripe", () => {
    const gate = boardCreationGate(
      host({ paymentPreference: "stripe", stripeChargesEnabled: false })
    );
    assert.equal(gate.allow, false);
    assert.ok(!gate.allow && gate.destination === "/host/stripe");
    assert.ok(!gate.allow && gate.reason === "stripe-not-ready");
  });

  test("R3 stripe host, enabled -> allowed", () => {
    const gate = boardCreationGate(
      host({ paymentPreference: "stripe", stripeChargesEnabled: true })
    );
    assert.equal(gate.allow, true);
  });

  // R4 — boardCredits is not an input to this gate at all, which is the
  // assertion. Credit behavior stays downstream and unchanged; a host with zero
  // credits reaches the form and is handled by the pending_payment path.
  test("R4 credits are not part of the condition", () => {
    const withCredits = { ...host(), boardCredits: 12 } as BoardCreationGateHost;
    const without = { ...host(), boardCredits: 0 } as BoardCreationGateHost;
    assert.deepEqual(boardCreationGate(withCredits), boardCreationGate(without));
  });

  test("R5 null preference -> /host/payment-setup, NOT /host/stripe", () => {
    const gate = boardCreationGate(
      host({ paymentPreference: null, stripeChargesEnabled: false })
    );
    assert.equal(gate.allow, false);
    assert.ok(!gate.allow && gate.destination === "/host/payment-setup");
    assert.ok(!gate.allow && gate.reason === "no-preference");
    // The regression this replaces: the old denylist sent this host to Stripe,
    // silently answering the question payment setup exists to ask.
    assert.ok(!gate.allow && gate.destination !== "/host/stripe");
  });

  // R6 — the case a fix reaching for `stripeAccountId` gets wrong. An abandoned
  // onboarding must not re-gate a cash host. The gate's input type does not
  // carry `stripeAccountId` at all, so it cannot be consulted by accident;
  // this asserts the behavior anyway.
  test("R6 cash host with abandoned Stripe onboarding -> still allowed", () => {
    const gate = boardCreationGate({
      ...host({ paymentPreference: "cash", stripeChargesEnabled: false }),
      // Deliberately extra: present on the real row, invisible to the gate.
      stripeAccountId: "acct_abandoned",
    } as BoardCreationGateHost);
    assert.equal(gate.allow, true);
  });

  // R7 — characterization. The platform owner has no bypass in either gate
  // today: `isPlatformOwner` is read only on the credit path in
  // `api/boards/route.ts` and for the dashboard banner. The owner is gated by
  // preference like everyone else, and the production owner's preference is
  // `cash`, so this gate allows them exactly as the old one did.
  test("R7 platform owner is gated by preference, unchanged", () => {
    assert.equal(boardCreationGate(host({ paymentPreference: "cash" })).allow, true);
  });

  test("R11 unrecognized preference -> /host/payment-setup, raw value withheld", () => {
    const gate = boardCreationGate(
      host({ id: "host_r11", paymentPreference: "card" })
    );
    assert.equal(gate.allow, false);
    assert.ok(!gate.allow && gate.destination === "/host/payment-setup");
    assert.ok(!gate.allow && gate.reason === "unrecognized-preference");
    // NOT SHOWN TO THE HOST. The message a host sees must not carry a column
    // value they never wrote.
    assert.ok(!gate.allow && !gate.message.includes("card"));
  });

  test("R11 unrecognized preference logs host id and raw value server-side", () => {
    const original = console.warn;
    const seen: unknown[][] = [];
    console.warn = (...args: unknown[]) => void seen.push(args);
    try {
      boardCreationGate(host({ id: "host_r11", paymentPreference: "CASH" }));
    } finally {
      console.warn = original;
    }
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0][1], { hostId: "host_r11", raw: "CASH" });
  });

  test("a recognized preference logs nothing", () => {
    const original = console.warn;
    let calls = 0;
    console.warn = () => void calls++;
    try {
      boardCreationGate(host({ paymentPreference: "cash" }));
      boardCreationGate(host({ paymentPreference: "stripe", stripeChargesEnabled: true }));
      boardCreationGate(host({ paymentPreference: null }));
    } finally {
      console.warn = original;
    }
    assert.equal(calls, 0);
  });

  // `stripeChargesEnabled` is `Boolean?` in the schema, so null is reachable and
  // is not readiness.
  test("null stripeChargesEnabled is not ready", () => {
    const gate = boardCreationGate(
      host({ paymentPreference: "stripe", stripeChargesEnabled: null })
    );
    assert.equal(gate.allow, false);
    assert.ok(!gate.allow && gate.destination === "/host/stripe");
  });
});

describe("parsePaymentPreference", () => {
  test("the four states", () => {
    assert.deepEqual(parsePaymentPreference(null), { kind: "UNSET" });
    assert.deepEqual(parsePaymentPreference(undefined), { kind: "UNSET" });
    assert.deepEqual(parsePaymentPreference("cash"), { kind: "CASH" });
    assert.deepEqual(parsePaymentPreference("stripe"), { kind: "STRIPE" });
    assert.deepEqual(parsePaymentPreference("card"), {
      kind: "UNRECOGNIZED",
      raw: "card",
    });
  });

  // UNSET and UNRECOGNIZED share a destination but are not the same fact. If
  // they were merged, the only evidence that something is writing garbage into
  // the column would be gone.
  test("empty string and casing are unrecognized, not unset", () => {
    assert.deepEqual(parsePaymentPreference(""), { kind: "UNRECOGNIZED", raw: "" });
    assert.deepEqual(parsePaymentPreference("Cash"), {
      kind: "UNRECOGNIZED",
      raw: "Cash",
    });
  });
});
