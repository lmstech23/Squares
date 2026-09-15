import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  declaredRailDiffers,
  methodLabel,
  offlineTenderOptions,
  parseTender,
  referencePlaceholder,
  RECORDED_BY_HOST_LABEL,
  TENDER_REFERENCE_MAX,
} from "./tender.ts";

// The tender rules that need no database — payment-method addendum §4, §5.
//
// THE LABEL RULE IS THE ONE THAT MATTERS HERE. A historical row with no tender
// must read "Recorded by host" and must NEVER read "Cash": most of those rows
// were cash and some were not, and the difference is exactly what nobody can
// reconstruct. Saying "Cash" would assert a fact no one recorded.

describe("methodLabel (ledger display)", () => {
  test("a witnessed row reads Card", () => {
    assert.equal(methodLabel("STRIPE", "CARD"), "Card");
  });

  test("an offline row reads its tender", () => {
    assert.equal(methodLabel("OFFLINE", "ZELLE"), "Zelle");
    assert.equal(methodLabel("OFFLINE", "CASHAPP"), "Cash App");
    assert.equal(methodLabel("OFFLINE", "CHECK"), "Check");
    assert.equal(methodLabel("OFFLINE", "CASH"), "Cash");
  });

  test("an offline row with no tender reads Recorded by host, never Cash", () => {
    assert.equal(methodLabel("OFFLINE", null), RECORDED_BY_HOST_LABEL);
    assert.notEqual(methodLabel("OFFLINE", null), "Cash");
  });

  test("an unrecognised tender falls back to Recorded by host rather than inventing one", () => {
    assert.equal(methodLabel("OFFLINE", "BITCOIN"), RECORDED_BY_HOST_LABEL);
  });
});

describe("declaredRailDiffers (detail reveal)", () => {
  test("a declaration that matches the tender is not repeated", () => {
    assert.equal(declaredRailDiffers("zelle", "ZELLE"), false);
    assert.equal(declaredRailDiffers("cashapp", "CASHAPP"), false);
  });

  test("a declaration that disagrees with the tender is shown - the disagreement is the information", () => {
    assert.equal(declaredRailDiffers("zelle", "CASH"), true);
    assert.equal(declaredRailDiffers("venmo", "CHECK"), true);
  });

  test("a declaration on a row with no tender is still worth showing", () => {
    assert.equal(declaredRailDiffers("zelle", null), true);
  });

  test("no declaration, nothing to show", () => {
    assert.equal(declaredRailDiffers(null, "CASH"), false);
    assert.equal(declaredRailDiffers(null, null), false);
  });
});

describe("offlineTenderOptions (the picker's list)", () => {
  test("Cash first, the board's rails, then Check and Other - and never CARD", () => {
    assert.deepEqual(offlineTenderOptions(["zelle", "venmo"]), [
      "CASH",
      "ZELLE",
      "VENMO",
      "CHECK",
      "OTHER",
    ]);
  });

  test("a board with nothing configured still has three honest answers", () => {
    assert.deepEqual(offlineTenderOptions([]), ["CASH", "CHECK", "OTHER"]);
  });

  test("CARD is not offerable from any configuration", () => {
    const every = offlineTenderOptions(["zelle", "cashapp", "venmo", "paypal"]);
    assert.ok(!every.includes("CARD" as never));
  });
});

describe("parseTender (what every route calls)", () => {
  test("a missing tender is refused", () => {
    assert.equal(parseTender(undefined, null).ok, false);
    assert.equal(parseTender(null, null).ok, false);
    assert.equal(parseTender("", null).ok, false);
  });

  test("CARD is refused by name", () => {
    const out = parseTender("CARD", null);
    assert.equal(out.ok, false);
    if (!out.ok) assert.match(out.error, /Card is not a host-recorded method/);
  });

  test("an unknown method is refused", () => {
    assert.equal(parseTender("BITCOIN", null).ok, false);
    assert.equal(parseTender(42, null).ok, false);
  });

  test("a reference is optional, trimmed, and empty becomes null", () => {
    const bare = parseTender("CASH", undefined);
    assert.deepEqual(bare, { ok: true, tender: "CASH", reference: null });
    const spaced = parseTender("CHECK", "  1042  ");
    assert.deepEqual(spaced, { ok: true, tender: "CHECK", reference: "1042" });
    assert.deepEqual(parseTender("CHECK", "   "), { ok: true, tender: "CHECK", reference: null });
  });

  // A DISPLAY RULE, NOT A DATA RULE. The picker hides the field for cash; an M4
  // correction can still produce a cash row carrying a note.
  test("a reference on a cash row is accepted", () => {
    assert.deepEqual(parseTender("CASH", "envelope from the bake sale"), {
      ok: true,
      tender: "CASH",
      reference: "envelope from the bake sale",
    });
  });

  test("a reference longer than the column allows is refused, not truncated", () => {
    const long = "x".repeat(TENDER_REFERENCE_MAX + 1);
    const out = parseTender("OTHER", long);
    assert.equal(out.ok, false);
    if (!out.ok) assert.match(out.error, /at most 64 characters/);
  });
});

describe("referencePlaceholder", () => {
  test("says what the note is for, and never that it is required", () => {
    assert.match(referencePlaceholder("CHECK"), /Check number/);
    assert.match(referencePlaceholder("OTHER"), /optional/);
    assert.match(referencePlaceholder("ZELLE"), /optional/);
    assert.match(referencePlaceholder(null), /Optional/);
  });
});
