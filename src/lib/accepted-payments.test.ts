import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  acceptsCard,
  acceptedRails,
  acceptedHandles,
  acceptsAnyDirect,
  cardCapable,
  hasOfferableMethod,
  normalizeAcceptedMethods,
  methodStatuses,
  HANDLE_FOR,
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

// ===========================================================================
// THE SAVE RULE — at least one method must be OFFERABLE after the write.
//
// SELECTED AND OFFERABLE ARE DIFFERENT, and that difference is the rule. A
// board with Venmo ticked and no Venmo handle has a selected method and can
// take no money. Checking the array's length would call that configured.
//
// The two cases the rule exists to separate, ruled 2026-09-08:
//
//   Zelle offerable, Venmo ticked with no handle   saves. Venmo is not live yet.
//   only Venmo ticked, no handle                   refused. Nothing can be paid.
//
// That preserves ticking a rail now and pasting the handle later, while making
// a board that looks configured and cannot collect unreachable.
// ===========================================================================

describe("hasOfferableMethod — the save rule", () => {
  // THE PERMITTED CASE, named as the host would describe it.
  test("Zelle live, Venmo ticked with no handle: saves", () => {
    const b = board(["zelle", "venmo"], { hostVenmo: null });
    assert.equal(hasOfferableMethod(b, NO_STRIPE), true);
    assert.deepEqual(acceptedRails(b), ["zelle"], "Venmo is selected but not offered");
  });

  // THE REFUSED CASE. Every method the host picked is unusable.
  test("only Venmo ticked with no handle: refused", () => {
    const b = board(["venmo"], { hostVenmo: null });
    assert.equal(hasOfferableMethod(b, NO_STRIPE), false);
    assert.deepEqual(acceptedRails(b), []);
  });

  // The same board becomes savable the moment the handle arrives — which is
  // what makes tick-now-paste-later a real flow rather than a trap.
  test("that board saves as soon as the Venmo handle is filled in", () => {
    assert.equal(hasOfferableMethod(board(["venmo"]), NO_STRIPE), true);
  });

  test("nothing selected at all: refused", () => {
    assert.equal(hasOfferableMethod(board([]), LIVE_STRIPE), false);
  });

  // CARD COUNTS AS OFFERABLE, but only on a live account. A board accepting
  // card alone is a legitimate configuration; a board accepting card alone
  // without Stripe is the same trap as Venmo without a handle.
  test("card alone on a live account: saves", () => {
    assert.equal(hasOfferableMethod(board(["card"]), LIVE_STRIPE), true);
  });

  test("card alone with no live account: refused", () => {
    assert.equal(hasOfferableMethod(board(["card"]), NO_STRIPE), false);
  });

  // A handle that exists but is not ticked is not a fallback. Unticking the
  // last offered method must fail even with four handles stored, or the toggle
  // would not mean anything.
  test("handles stored but nothing ticked: refused", () => {
    assert.equal(hasOfferableMethod(board([]), NO_STRIPE), false);
  });

  test("a live Stripe account does not rescue a board that unticked card", () => {
    assert.equal(hasOfferableMethod(board(["venmo"], { hostVenmo: null }), LIVE_STRIPE), false);
  });
});

describe("normalizeAcceptedMethods", () => {
  test("known methods survive, in a stable order regardless of input order", () => {
    assert.deepEqual(normalizeAcceptedMethods(["paypal", "card", "zelle"]),
      ["card", "zelle", "paypal"]);
  });

  test("duplicates collapse", () => {
    assert.deepEqual(normalizeAcceptedMethods(["zelle", "zelle", "zelle"]), ["zelle"]);
  });

  test("an empty array is valid input — the offerable rule rejects it, with a better sentence", () => {
    assert.deepEqual(normalizeAcceptedMethods([]), []);
  });

  test("anything unknown or non-string is refused outright", () => {
    assert.equal(normalizeAcceptedMethods(["bitcoin"]), null);
    assert.equal(normalizeAcceptedMethods(["zelle", 7]), null);
    assert.equal(normalizeAcceptedMethods("zelle"), null);
    assert.equal(normalizeAcceptedMethods(null), null);
    assert.equal(normalizeAcceptedMethods(undefined), null);
  });

  test("two saves of the same selection produce the same column", () => {
    assert.deepEqual(
      normalizeAcceptedMethods(["venmo", "card"]),
      normalizeAcceptedMethods(["card", "venmo"])
    );
  });
});

describe("cardCapable — eligibility, never intent", () => {
  test("a live account is capable", () => {
    assert.equal(cardCapable(LIVE_STRIPE), true);
  });

  // THE WHOLE POINT OF THE RULING. Capable and accepting are different
  // questions, and deriving the second from the first is what put a live
  // Stripe checkout on a direct-payment fundraiser.
  test("capable does NOT mean accepting", () => {
    assert.equal(cardCapable(LIVE_STRIPE), true);
    assert.equal(acceptsCard(board(["zelle"]), LIVE_STRIPE), false);
  });

  test("half a connection is not a connection", () => {
    assert.equal(cardCapable({ stripeAccountId: "acct_x", stripeChargesEnabled: false }), false);
    assert.equal(cardCapable({ stripeAccountId: null, stripeChargesEnabled: true }), false);
  });
});

describe("methodStatuses — what the edit panel renders", () => {
  const find = (rows: ReturnType<typeof methodStatuses>, m: string) =>
    rows.find((r) => r.method === m)!;

  test("all five methods are always listed, in a stable order", () => {
    const rows = methodStatuses(board([]), false);
    assert.deepEqual(rows.map((r) => r.method), ["card", "zelle", "cashapp", "venmo", "paypal"]);
  });

  // CARD IS THE ONLY BLOCKED ROW, because Stripe is the only blocker the host
  // cannot clear from this form. Every rail's blocker is a text field beside it.
  test("card is blocked without Stripe, and never blocked with it", () => {
    assert.equal(find(methodStatuses(board([]), false), "card").blocked, true);
    assert.equal(find(methodStatuses(board([]), true), "card").blocked, false);
  });

  test("no direct rail is ever blocked, even with no handle", () => {
    const rows = methodStatuses(board([], { hostVenmo: null, hostZelle: null, hostCashapp: null, hostPaypal: null }), false);
    for (const r of rows.filter((x) => x.method !== "card")) {
      assert.equal(r.blocked, false, `${r.method} must stay tickable`);
    }
  });

  test("a ticked rail with no handle is selected but not offerable, and says why", () => {
    const row = find(methodStatuses(board(["venmo"], { hostVenmo: null }), false), "venmo");
    assert.equal(row.selected, true);
    assert.equal(row.offerable, false);
    assert.match(row.requirement!, /Venmo/);
  });

  test("a ticked rail with a handle is offerable and asks for nothing", () => {
    const row = find(methodStatuses(board(["venmo"]), false), "venmo");
    assert.equal(row.offerable, true);
    assert.equal(row.requirement, null);
  });

  // An unticked rail is not offered even when its handle is stored — the
  // narrowing rule, seen from the host's side.
  test("an unticked rail with a handle is not offerable", () => {
    const row = find(methodStatuses(board(["zelle"]), false), "venmo");
    assert.equal(row.selected, false);
    assert.equal(row.offerable, false);
  });

  test("card ticked on a live account is offerable", () => {
    assert.equal(find(methodStatuses(board(["card"]), true), "card").offerable, true);
  });

  test("card ticked without Stripe is not offerable and names Stripe", () => {
    const row = find(methodStatuses(board(["card"]), false), "card");
    assert.equal(row.offerable, false);
    assert.match(row.requirement!, /Stripe/);
  });
});

describe("xv8yuwhd — the live board's intended state", () => {
  // Zelle and Cash App now, no card, Venmo and PayPal once the details exist.
  const XV = board(["zelle", "cashapp"], { hostVenmo: null, hostPaypal: null });

  test("it offers exactly Zelle and Cash App", () => {
    assert.deepEqual(acceptedRails(XV), ["zelle", "cashapp"]);
  });

  // THE REGRESSION THIS WHOLE CHANGE EXISTS TO PREVENT. The host has a live
  // Stripe account; the board must still not take cards.
  test("a live Stripe account on the host does NOT put card on this board", () => {
    assert.equal(acceptsCard(XV, LIVE_STRIPE), false);
    assert.equal(cardCapable(LIVE_STRIPE), true, "eligible, and still not accepting");
  });

  test("it saves, and ticking Venmo before the handle exists still saves", () => {
    assert.equal(hasOfferableMethod(XV, LIVE_STRIPE), true);
    const withVenmo = board(["zelle", "cashapp", "venmo"], { hostVenmo: null, hostPaypal: null });
    assert.equal(hasOfferableMethod(withVenmo, LIVE_STRIPE), true);
    assert.deepEqual(acceptedRails(withVenmo), ["zelle", "cashapp"], "Venmo not live yet");
  });
});

describe("creation no longer derives card", () => {
  // api/boards/route.ts builds the array from handles only. A host with a live
  // Stripe account creating a fundraiser gets NO card until they tick it.
  const atCreation = (handles: Record<string, string | null>) =>
    (["zelle", "cashapp", "venmo", "paypal"] as const).filter(
      (r) => handles[HANDLE_FOR[r]]
    );

  test("a Stripe-connected host's new board does not accept card", () => {
    const derived = atCreation({ ...HANDLES });
    assert.equal(derived.includes("card" as never), false);
    assert.equal(acceptsCard(board(derived), LIVE_STRIPE), false);
  });

  test("the derived board is still savable — the rails carry it", () => {
    assert.equal(hasOfferableMethod(board(atCreation({ ...HANDLES })), LIVE_STRIPE), true);
  });
});
