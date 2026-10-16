// Input validation shared by host setup and supporter checkout.

import { createHash } from "node:crypto";
import { MerchError } from "./errors.ts";

/** Lower-cased, trimmed email, or throws. Deliberately simple: one @, a dot in the domain. */
export function normalizeEmail(raw: unknown): string {
  const e = String(raw ?? "").trim().toLowerCase();
  if (e.length < 5 || e.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) {
    throw new MerchError("INVALID_INPUT", "Enter a valid email address.");
  }
  return e;
}

export function requireText(raw: unknown, field: string, max: number, optional = false): string | null {
  const s = String(raw ?? "").trim();
  if (!s) {
    if (optional) return null;
    throw new MerchError("INVALID_INPUT", `${field} is required.`);
  }
  if (s.length > max) throw new MerchError("INVALID_INPUT", `${field} must be ${max} characters or fewer.`);
  return s;
}

/** Salted SHA-256 of an IP. The raw IP is never stored. */
export function hashIp(ip: string | null | undefined, salt: string): string | null {
  if (!ip) return null;
  return createHash("sha256").update(salt + "|" + ip.trim()).digest("hex");
}

/**
 * After-order link (spec §5.6): https only, no credentials, no custom port,
 * no IP-literal host. Returns the normalized URL string.
 */
export function validateAfterOrderUrl(raw: unknown): string {
  const s = String(raw ?? "").trim();
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new MerchError("INVALID_INPUT", "The after-order link isn't a valid web address.");
  }
  if (u.protocol !== "https:") throw new MerchError("INVALID_INPUT", "The after-order link must start with https://.");
  if (u.username || u.password) throw new MerchError("INVALID_INPUT", "The after-order link can't contain a username or password.");
  if (u.port) throw new MerchError("INVALID_INPUT", "The after-order link can't use a custom port.");
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(u.hostname) || u.hostname.startsWith("[")) {
    throw new MerchError("INVALID_INPUT", "The after-order link must use a domain name, not an IP address.");
  }
  if (!u.hostname.includes(".")) throw new MerchError("INVALID_INPUT", "The after-order link needs a full domain name.");
  if (u.toString().length > 2000) throw new MerchError("INVALID_INPUT", "The after-order link is too long.");
  return u.toString();
}

export function slugify(raw: unknown): string {
  const s = String(raw ?? "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  if (!/^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])$/.test(s)) {
    throw new MerchError("INVALID_INPUT", "The link name needs 3–48 letters, numbers or dashes.");
  }
  // Route names under /merch and /api/merch that a slug must never shadow.
  if (["return", "order", "orders", "new", "api", "admin"].includes(s)) {
    throw new MerchError("INVALID_INPUT", "That link name is reserved. Choose another.");
  }
  return s;
}
