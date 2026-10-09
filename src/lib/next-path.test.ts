import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { allowedNext } from "./next-path.ts";
import { safeReturnPath, DEFAULT_AFTER_LOGIN } from "./login-return.ts";

// The shared `next` allowlist, Daali Slice 1 S1.2. The legacy safeReturnPath
// cases in board-invites.integration.test.ts still run unchanged; these cover
// what the shared validator adds and what it must still refuse.

const BOARD = "0b6f3c1e-8d2a-4f5b-9c7e-1a2b3c4d5e6f";
const TOKEN = "a".repeat(43);

describe("allowedNext: accepts", () => {
  test("a board's management page and paths beneath it", () => {
    for (const p of [
      `/host/boards/${BOARD}`,
      `/host/boards/${BOARD}/donations`,
      `/host/boards/${BOARD}/volunteers`,
      `/host/boards/${BOARD.toUpperCase()}`,
    ]) {
      assert.equal(allowedNext(p), p);
    }
  });

  test("an invite path", () => {
    const p = `/invite/${TOKEN}`;
    assert.equal(allowedNext(p), p);
  });

  test("one level of encoding, returned decoded", () => {
    const p = `/host/boards/${BOARD}/donations`;
    assert.equal(allowedNext(encodeURIComponent(p)), p);
  });
});

describe("allowedNext: rejects", () => {
  test("absent or empty", () => {
    assert.equal(allowedNext(null), null);
    assert.equal(allowedNext(undefined), null);
    assert.equal(allowedNext(""), null);
  });

  test("external URLs and protocol-relative paths", () => {
    for (const attack of [
      "https://evil.com",
      "http://evil.com",
      "javascript:alert(1)",
      "//evil.com",
      "//host",
      `//host/boards/${BOARD}`,
      "///evil.com",
      " //evil.com",
      `https://evil.com/host/boards/${BOARD}`,
      `/host/boards/${BOARD}@evil.com`,
    ]) {
      assert.equal(allowedNext(attack), null, `${attack} must be refused`);
    }
  });

  test("backslashes", () => {
    for (const attack of [
      "/\\evil.com",
      "\\\\evil.com",
      `\\host\\boards\\${BOARD}`,
      `/host/boards/${BOARD}\\..\\..\\evil`,
    ]) {
      assert.equal(allowedNext(attack), null, `${attack} must be refused`);
    }
  });

  test("encoded tricks", () => {
    for (const attack of [
      "%2f%2fevil.com",
      "%2F%2Fevil.com",
      "%5c%5cevil.com",
      "/%5cevil.com",
      "%68%74%74%70%73%3a%2f%2fevil.com",
      "%252f%252fevil.com",
      `%252Fhost%252Fboards%252F${BOARD}`,
      `/host/boards/${BOARD}%2f..%2f..%2fevil`,
      `/host/boards/${BOARD}%40evil.com`,
      "%E0%A4%A",
      "%",
    ]) {
      assert.equal(allowedNext(attack), null, `${attack} must be refused`);
    }
  });

  test("traversal, query strings and fragments", () => {
    for (const attack of [
      `/host/boards/${BOARD}/../../evil`,
      `/host/boards/${BOARD}/./donations`,
      `/host/boards/${BOARD}?x=1`,
      `/host/boards/${BOARD}#x`,
      `/host/boards/${BOARD}/`,
      `/invite/${TOKEN}?next=//evil.com`,
      "/invite/abc/../../host",
    ]) {
      assert.equal(allowedNext(attack), null, `${attack} must be refused`);
    }
  });

  test("internal paths outside the allowlist", () => {
    for (const p of [
      "/",
      "/host",
      "/host/",
      "/host/boards",
      "/host/boards/new",
      "/host/boards/x/donations",
      "/host/payment-setup",
      "/host/stripe",
      "/host/stripe/return",
      "/hostX",
      `/hostboards/${BOARD}`,
      `/board/${BOARD}`,
      "/login",
      // Not yet: /home joins the allowlist in S1.6, when the page exists.
      "/home",
      "/invite/short",
      "/invite/" + "a".repeat(200),
    ]) {
      assert.equal(allowedNext(p), null, `${p} is not on the allowlist`);
    }
  });
});

describe("safeReturnPath uses the shared validator", () => {
  test("an allowed path passes through; everything else is today's default", () => {
    assert.equal(DEFAULT_AFTER_LOGIN, "/host/boards", "S1.2 keeps today's destination");
    assert.equal(safeReturnPath(`/host/boards/${BOARD}`), `/host/boards/${BOARD}`);
    assert.equal(safeReturnPath(`/invite/${TOKEN}`), `/invite/${TOKEN}`);
    assert.equal(safeReturnPath("//evil.com"), DEFAULT_AFTER_LOGIN);
    assert.equal(safeReturnPath("/host/stripe"), DEFAULT_AFTER_LOGIN);
    assert.equal(safeReturnPath(null), DEFAULT_AFTER_LOGIN);
  });
});
