import { randomBytes, createHash, timingSafeEqual } from "crypto";
import { prisma } from "@/lib/prisma";

// Check-in staff credentials — fundraiser-board-v2.md §6B, sign-up addendum §2.
//
// Authority to scan at the gate is a permission, not a contribution — the
// person bringing water is a volunteer, the person authorized to scan is staff.
//
// A staff link is a bearer credential that will sit in a text thread on
// five phones for a week. It is HASHED AT REST, so a database read never
// yields a working gate credential — the raw value is shown once at creation
// and never stored.
//
// Scoped to one event, revocable individually, and grants roster read and
// check-in only. Never money, never the grid, never a host setting.

/** The raw link value. Shown once, never persisted. */
export function newCheckinStaffToken(): string {
  return randomBytes(24).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Constant-time comparison of hashes.
 *
 * The lookup below is by exact hash, so this guards the one place a caller
 * might otherwise compare with `===`. Overkill for a 192-bit random token, and
 * cheap enough that arguing about it costs more than doing it.
 */
export function tokensMatch(a: string, b: string): boolean {
  const ba = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export interface GateSession {
  checkinStaffId: string;
  eventId: string;
  label: string;
}

/**
 * Resolve a raw link token to a live gate session.
 *
 * Returns null for unknown, malformed, and revoked tokens alike — someone
 * whose link was revoked learns that it does not work, not that it once did.
 */
export async function resolveGateSession(
  token: string | undefined | null
): Promise<GateSession | null> {
  if (!token || token.length < 16 || token.length > 128) return null;

  const access = await prisma.checkinStaffAccess.findFirst({
    where: { tokenHash: hashToken(token), revokedAt: null },
    select: { id: true, eventId: true, label: true },
  });

  if (!access) return null;

  return {
    checkinStaffId: access.id,
    eventId: access.eventId,
    label: access.label,
  };
}
