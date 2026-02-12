import { randomBytes } from "crypto";

/**
 * Generate a short, URL-safe slug for board URLs.
 * 6 bytes → 8 base64url chars → ~281 trillion combinations.
 * Collision check happens at the API layer.
 */
export function generateSlug(): string {
  return randomBytes(6)
    .toString("base64url")
    .replace(/[_-]/g, "")
    .slice(0, 8)
    .toLowerCase();
}
