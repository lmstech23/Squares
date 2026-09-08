import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  notificationValue,
  parseNotification,
  isNotified,
} from "./winner-notification.ts";

// The winner notification record — invariant 117.
//
// THE DEFECT. The map was `period -> squareId`. The lock pinned the SQUARE and
// not the PHONE, so `resend-winner-sms` re-read `playerPhone` at send time:
// edit the phone between the first notification and a resend, and the message
// went to the new number. A "resend" was a new send to an arbitrary recipient,
// which is why `winner.resend` could not be a MANAGER capability.
//
// These cover the shape and its parser. The route-level cases — what notify
// actually stores, what resend actually sends to, and the guards — are in
// winner-sms.integration.test.ts against a real database.

const SQUARE = "11111111-2222-3333-4444-555555555555";

describe("notificationValue — what notify-winner stores", () => {
  // 1. initial notify stores both squareId and phone.
  test("carries the square and the phone together", () => {
    const v = notificationValue({ squareId: SQUARE, phone: "+16785551234" });
    assert.equal(v.squareId, SQUARE);
    assert.equal(v.phone, "+16785551234");
    assert.ok(v.notifiedAt);
  });

  // A winner with no phone is a real, notifiable state: notify-winner sends an
  // EMAIL and requires only an email address.
  test("a winner with no phone stores null, not an empty string", () => {
    assert.equal(notificationValue({ squareId: SQUARE, phone: null }).phone, null);
    assert.equal(notificationValue({ squareId: SQUARE, phone: "" }).phone, null);
    assert.equal(notificationValue({ squareId: SQUARE, phone: "   " }).phone, null);
  });

  test("the phone is trimmed, so whitespace never becomes a destination", () => {
    assert.equal(
      notificationValue({ squareId: SQUARE, phone: "  +16785551234  " }).phone,
      "+16785551234"
    );
  });
});

describe("parseNotification", () => {
  const map = (v: unknown) => ({ H1: v });

  // 2. resend uses the stored phone — the parser is what hands it over.
  test("a well-formed record parses, and carries a non-null phone", () => {
    const r = parseNotification(
      map({ squareId: SQUARE, phone: "+16785551234", notifiedAt: "2026-10-24T19:00:00.000Z" }),
      "H1"
    );
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.phone, "+16785551234");
    assert.equal(r.ok && r.notification.squareId, SQUARE);
  });

  // 4. resend cannot run for a period with no initial notification.
  test("a period with no entry is `missing`, not malformed", () => {
    assert.deepEqual(parseNotification(map({ squareId: SQUARE, phone: "+1" }), "Final"), {
      ok: false,
      reason: "missing",
    });
    assert.deepEqual(parseNotification({}, "H1"), { ok: false, reason: "missing" });
  });

  // 5. malformed stored notification fails closed.
  //
  // A BARE STRING IS MALFORMED, NOT A LEGACY VALUE. Production holds none, and
  // honouring one would silently restore the unpinned behaviour for any row
  // carrying the old shape.
  test("the former string-only shape is refused, not honoured", () => {
    const r = parseNotification(map(SQUARE), "H1");
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.reason, "malformed");
  });

  test("every other malformed shape fails closed too", () => {
    for (const junk of [
      42,
      true,
      [],
      [SQUARE],
      {},
      { phone: "+1" },
      { squareId: "" },
      { squareId: 7, phone: "+1" },
      { squareId: SQUARE, phone: 12345 },
      { squareId: SQUARE, phone: [] },
    ]) {
      const r = parseNotification(map(junk), "H1");
      assert.equal(r.ok, false, `${JSON.stringify(junk)} should not parse`);
      assert.equal(!r.ok && r.reason, "malformed", JSON.stringify(junk));
    }
  });

  test("a map that is not an object is malformed, not missing", () => {
    for (const junk of [null, "x", 5, []]) {
      const r = parseNotification(junk, "H1");
      assert.equal(!r.ok && r.reason, "malformed");
    }
  });

  // A REAL RECORD WITH NO PHONE is distinct from a broken one: the winner was
  // notified properly, there is simply nothing to resend to. It must not be
  // reported as corruption, and it must not fall back to the square.
  test("a valid record with no phone is `no-phone`, and still yields the record", () => {
    const r = parseNotification(map({ squareId: SQUARE, phone: null }), "H1");
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.reason, "no-phone");
    assert.equal(!r.ok && r.reason === "no-phone" && r.notification.squareId, SQUARE);
  });

  // The shape is implementation-defined: extra fields are ignored, so adding a
  // provider message id later needs no product amendment.
  test("unknown extra fields are ignored, not rejected", () => {
    const r = parseNotification(
      map({ squareId: SQUARE, phone: "+1678", providerMessageId: "SM123", foo: 1 }),
      "H1"
    );
    assert.equal(r.ok, true);
  });

  test("a missing notifiedAt does not invalidate the record", () => {
    const r = parseNotification(map({ squareId: SQUARE, phone: "+1678" }), "H1");
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.notification.notifiedAt, "");
  });
});

describe("isNotified — display only", () => {
  // 6. the lock: a period with a record is notified, and stays so.
  test("a period with any record reads as notified", () => {
    assert.equal(isNotified({ H1: { squareId: SQUARE, phone: "+1" } }, "H1"), true);
    assert.equal(isNotified({ H1: { squareId: SQUARE, phone: null } }, "H1"), true);
  });

  // A MALFORMED RECORD STILL COUNTS AS NOTIFIED. Reporting "not notified" would
  // invite a host to notify again and replace a winner, which is the one thing
  // the lock exists to prevent.
  test("a malformed record still reads as notified", () => {
    assert.equal(isNotified({ H1: SQUARE }, "H1"), true);
    assert.equal(isNotified({ H1: 42 }, "H1"), true);
  });

  test("an absent period reads as not notified", () => {
    assert.equal(isNotified({ H1: { squareId: SQUARE, phone: "+1" } }, "Final"), false);
    assert.equal(isNotified({}, "H1"), false);
  });
});
