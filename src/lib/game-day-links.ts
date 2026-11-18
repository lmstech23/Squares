// Game Day access links — Daali Slice 1, S1.7 (Auth spec, "Game Day access",
// amended Oct 11).
//
// One person, one use. A link is a random token; only its SHA-256 is stored.
// It works once and expires 14 days after creation if unused.
//
// ATOMICITY — every state change is ONE conditional UPDATE:
//   redeem  UPDATE … SET used_at, used_by_user_id
//           WHERE token_hash = $1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now
//   revoke  UPDATE … SET revoked_at
//           WHERE id = $1 AND used_at IS NULL AND revoked_at IS NULL
// Postgres locks the row for the first UPDATE that matches it; a concurrent
// UPDATE on the same row waits, then RE-EVALUATES its WHERE against the
// committed row, finds used_at or revoked_at set, and matches nothing. So of
// twenty redemptions exactly one matches, and between a redemption and a
// revocation whichever lands first wins. The table's CHECK
// (used_at IS NULL OR revoked_at IS NULL) makes "both" impossible to store.
//
// Redeeming also sets organizer_profiles.legacy_boards_enabled, in the SAME
// transaction, and only if the link UPDATE matched.
//
// Every function takes the Prisma client explicitly so the concurrency tests
// can drive the real statements against a real database. Callers check who is
// asking (src/lib/admin.ts) BEFORE calling any of these.

import { createHash, randomBytes } from "crypto";
import type { PrismaClient } from "@prisma/client";

export const LINK_TTL_DAYS = 14;

export function generateGameDayToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashGameDayToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export type LinkStatus = "unused" | "used" | "expired" | "revoked";

export function linkStatus(link: { usedAt: Date | null; revokedAt: Date | null; expiresAt: Date }, now: Date): LinkStatus {
  if (link.revokedAt) return "revoked";
  if (link.usedAt) return "used";
  if (link.expiresAt.getTime() <= now.getTime()) return "expired";
  return "unused";
}

/** Create a link. Returns the raw token ONCE; only its hash is stored. */
export async function createGameDayLink(db: PrismaClient, adminUserId: string, now = new Date()) {
  const token = generateGameDayToken();
  const row = await db.daaliGameDayLink.create({
    data: {
      tokenHash: hashGameDayToken(token),
      createdByUserId: adminUserId,
      expiresAt: new Date(now.getTime() + LINK_TTL_DAYS * 24 * 60 * 60 * 1000),
    },
    select: { id: true, expiresAt: true },
  });
  return { token, id: row.id, expiresAt: row.expiresAt };
}

export type AdminLinkRow = {
  id: string;
  status: LinkStatus;
  createdAt: Date;
  expiresAt: Date;
  usedAt: Date | null;
  revokedAt: Date | null;
  usedBy: string | null;
};

/** Every link, newest first, with its status and who used it. Never the token. */
export async function listGameDayLinks(db: PrismaClient, now = new Date()): Promise<AdminLinkRow[]> {
  const rows = await db.$queryRaw<
    { id: string; created_at: Date; expires_at: Date; used_at: Date | null; revoked_at: Date | null; used_by: string | null }[]
  >`
    SELECT l.id::text AS id, l.created_at, l.expires_at, l.used_at, l.revoked_at,
           COALESCE(p.display_name, u.email, u.phone, l.used_by_user_id) AS used_by
      FROM public.daali_game_day_links l
      LEFT JOIN auth.users u ON u.id::text = l.used_by_user_id
      LEFT JOIN public.organizer_profiles p ON p.user_id = l.used_by_user_id
     ORDER BY l.created_at DESC`;
  return rows.map((r) => ({
    id: r.id,
    status: linkStatus({ usedAt: r.used_at, revokedAt: r.revoked_at, expiresAt: r.expires_at }, now),
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    usedAt: r.used_at,
    revokedAt: r.revoked_at,
    usedBy: r.used_by,
  }));
}

export type RevokeOutcome = "revoked" | "already-used" | "already-revoked" | "not-found";

/** Revoke an unused link: one conditional UPDATE. A used link cannot be revoked as unused. */
export async function revokeGameDayLink(db: PrismaClient, id: string, now = new Date()): Promise<RevokeOutcome> {
  const { count } = await db.daaliGameDayLink.updateMany({
    where: { id, usedAt: null, revokedAt: null },
    data: { revokedAt: now },
  });
  if (count === 1) return "revoked";
  const link = await db.daaliGameDayLink.findUnique({ where: { id }, select: { usedAt: true, revokedAt: true } });
  if (!link) return "not-found";
  return link.usedAt ? "already-used" : "already-revoked";
}

export type RedeemOutcome = "redeemed" | "already-entitled" | "unusable" | "no-profile";

/**
 * Redeem a link for this account, in one transaction:
 *   - already entitled: nothing changes; the link stays unused;
 *   - otherwise mark the link used ONLY if it is unused, unrevoked and
 *     unexpired (one conditional UPDATE), and set the flag ONLY if that UPDATE
 *     matched.
 * An account with no organizer_profiles row cannot hold the flag; the link is
 * left unused.
 */
export async function redeemGameDayLink(db: PrismaClient, rawToken: string, userId: string, now = new Date()): Promise<RedeemOutcome> {
  return db.$transaction(async (tx) => {
    const profile = await tx.organizerProfile.findUnique({ where: { userId }, select: { legacyBoardsEnabled: true } });
    if (profile?.legacyBoardsEnabled) return "already-entitled";
    if (!profile) return "no-profile";

    const claimed = await tx.daaliGameDayLink.updateMany({
      where: { tokenHash: hashGameDayToken(rawToken), usedAt: null, revokedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now, usedByUserId: userId },
    });
    if (claimed.count !== 1) return "unusable";

    await tx.organizerProfile.update({ where: { userId }, data: { legacyBoardsEnabled: true } });
    return "redeemed";
  });
}

/** What /gameday/[token] shows on load. Reads only. */
export async function gameDayLinkStatusByToken(db: PrismaClient, rawToken: string, now = new Date()): Promise<LinkStatus | "not-found"> {
  const link = await db.daaliGameDayLink.findUnique({
    where: { tokenHash: hashGameDayToken(rawToken) },
    select: { usedAt: true, revokedAt: true, expiresAt: true },
  });
  return link ? linkStatus(link, now) : "not-found";
}

export type EntitledAccount = { userId: string; label: string };

/** Accounts that hold Game Day access, for the administrator's view. */
export async function listGameDayAccounts(db: PrismaClient): Promise<EntitledAccount[]> {
  const rows = await db.$queryRaw<{ user_id: string; label: string }[]>`
    SELECT p.user_id, COALESCE(p.display_name, u.email, u.phone, p.user_id) AS label
      FROM public.organizer_profiles p
      LEFT JOIN auth.users u ON u.id::text = p.user_id
     WHERE p.legacy_boards_enabled
     ORDER BY 2`;
  return rows.map((r) => ({ userId: r.user_id, label: r.label }));
}

/**
 * Remove Game Day access: the flag only. That account's existing boards, their
 * pages, management and payments are untouched.
 */
export async function removeGameDayAccess(db: PrismaClient, userId: string): Promise<boolean> {
  const { count } = await db.organizerProfile.updateMany({
    where: { userId, legacyBoardsEnabled: true },
    data: { legacyBoardsEnabled: false },
  });
  return count === 1;
}
