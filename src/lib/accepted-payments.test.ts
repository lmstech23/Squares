import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  acceptsCard,
  acceptedRails,
  acceptedHandles,
  acceptsAnyDirect,
} from "./accepted-payments.ts";

// THE NARROWING RULE, which is the whole reason this column is safe to add to
// boards that are already taking money.
//
//   capable AND accepted  ->  offered
//   capable, not accepted ->  not offered   (the new power: pausing a method)
//   accepted, not capable ->  not offered   (listing grants nothing)
//
// The third row is the one that matters most. If listing a method could make it
// available, a wrong value in this column would offer a contributor a payment
// that cannot complete. It can only ever offer LESS.

const HANDLES = {
  hostZelle: "host@example.com",
  hostCashapp: "$host",
  hostVenmo: "@host",
  hostPaypal: "paypal.me/host",
};

const LIVE_STRIPE = { stripeAccountId: "acct_x", stripeChargesEnabled: true };
const NO_STRIPE = { stripeAccountId: null, stripeChargesEnabled: false };

const board = (
  accepted: string[],
  over: Partial<Record<keyof typeof HANDLES, string | null>> = {}
) => ({
  acceptedPaymentMethods: accepted,
  ...HANDLES,
  ...over,
});

describe("acceptsCard — capability AND intent", () => {
  test("live account and listed: offered", () => {
    assert.equal(acceptsCard(board(["card"]), LIVE_STRIPE), true);
  });

  // THE NEW POWER. Before this column a live Stripe account meant card was on
  // for every fundraiser the host owned, with no way to say otherwise.
  test("live account, NOT listed: not offered", () => {
    assert.equal(acceptsCard(board(["zelle"]), LIVE_STRIPE), false);
  });

  // THE SAFETY PROPERTY. Listing grants nothing.
  test("listed, no live account: not offered", () => {
    assert.equal(acceptsCard(board(["card"]), NO_STRIPE), false);
  });

  test("an account id without charges enabled is not a live account", () => {
    assert.equal(
      acceptsCard(board(["card"]), { stripeAccountId: "acct_x", stripeChargesEnabled: false }),
      false
    );
    assert.equal(
      acceptsCard(board(["card"]), { stripeAccountId: null, stripeChargesEnabled: true }),
      false
    );
  });

  test("an empty list accepts nothing", () => {
    assert.equal(acceptsCard(board([]), LIVE_STRIPE), false);
  });
});

describe("acceptedRails — a handle is no longer the offer", () => {
  test("listed with a handle: offered", () => {
    assert.deepEqual(acceptedRails(board(["zelle"])), ["zelle"]);
  });

  // A handle the host has stored but paused. Impossible to express before:
  // populating a handle WAS the offer.
  test("handle present but not listed: not offered", () => {
    assert.deepEqual(acceptedRails(board(["cashapp"])), ["cashapp"]);
    assert.equal(acceptedRails(board(["cashapp"])).includes("zelle"), false);
  });

  test("listed with no handle: not offered", () => {
    assert.deepEqual(acceptedRails(board(["venmo"], { hostVenmo: null })), []);
  });

  test("several at once, in a stable order", () => {
    assert.deepEqual(acceptedRails(board(["paypal", "zelle", "card"])), [
      "zelle",
      "paypal",
    ]);
  });

  test("card is never a direct rail", () => {
    assert.deepEqual(acceptedRails(board(["card"])), []);
    assert.equal(acceptsAnyDirect(board(["card"])), false);
  });
});

describe("acceptedHandles — absent rails are absent, not blank", () => {
  test("only accepted rails carry their handle", () => {
    assert.deepEqual(acceptedHandles(board(["zelle", "venmo"])), {
      zelle: "host@example.com",
      cashapp: null,
      venmo: "@host",
      paypal: null,
    });
  });

  test("a listed rail with no handle stays null", () => {
    const h = acceptedHandles(board(["paypal"], { hostPaypal: null }));
    assert.equal(h.paypal, null);
  });

  test("an empty list yields no handles at all", () => {
    assert.deepEqual(acceptedHandles(board([])), {
      zelle: null,
      cashapp: null,
      venmo: null,
      paypal: null,
    });
  });
});

describe("the backfill shape reproduces old behaviour", () => {
  // Every board's backfilled list is "card if charges enabled, plus every
  // populated handle". Fed back through these helpers it must offer exactly
  // what the board offered before the column existed.
  test("a fully configured board on a live account offers everything", () => {
    const accepted = ["card", "zelle", "cashapp", "venmo", "paypal"];
    assert.equal(acceptsCard(board(accepted), LIVE_STRIPE), true);
    assert.deepEqual(acceptedRails(board(accepted)), [
      "zelle",
      "cashapp",
      "venmo",
      "paypal",
    ]);
  });

  test("a host with no Stripe backfills to rails only, and card stays off", () => {
    const accepted = ["zelle", "cashapp"];
    assert.equal(acceptsCard(board(accepted), NO_STRIPE), false);
    assert.deepEqual(acceptedRails(board(accepted)), ["zelle", "cashapp"]);
  });
});
