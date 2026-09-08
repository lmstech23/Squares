// Manager invitations — collaborators v2.2 §5 and §7. Invariants 96–100, 119.
//
// THE LINK IS AN INVITATION AND NEVER AN AUTHORIZATION — invariant 96.
// Possession offers access; only a `BoardCollaborator` row grants it. Everything
// here is about turning an offer into a grant exactly once, and about what
// happens to the offer afterwards: nothing. It is spent.
//
// THE RACE DEFENCE IS THE DATABASE, TWICE OVER, and neither half is a read
// followed by a write:
//
//   1. the conditional claim   UPDATE ... WHERE accepted_at IS NULL
//   2. the collaborator index  (board_id, host_id) WHERE status <> 'revoked'
//
// Two concurrent acceptances: one claims the invite, the other matches zero
// rows. Even if both somehow claimed, the second insert violates the index. The
// claim comes FIRST so the loser never reaches the insert — reversed, two
// racers on different invites could both fail at the insert and burn both.

import { createHash, randomBytes } from "crypto";
import type { Prisma } from "@prisma/client";

/** Seven days, per §5. Not capped at campaign close: a manager may be needed
 *  after it for roster and payout work. */
export const INVITE_TTL_DAYS = 7;

/**
 * A raw invite token. Shown to the owner ONCE and never stored.
 *
 * 32 bytes, base64url. The same shape and entropy as the supporter and
 * check-in-staff tokens, for the same reason: it is the only thing standing
 * between a stranger and an offer of manager access, and it is guessed offline
 * or not at all.
 */
export function generateInviteToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * What the database stores.
 *
 * SHA-256, unsalted, matching `hashSupporterToken`. A salt would be pointless
 * here: the input is 256 bits of randomness, so there is no dictionary to
 * defend against, and a per-row salt would make lookup by token impossible.
 */
export function hashInviteToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export type AcceptFailure =
  /** No invite with that token hash. Also the answer for a bad token. */
  | "not-found"
  /** Accepted, revoked, or expired — invariant 99, collapsed on purpose. */
  | "unusable"
  /**
   * Bound to an email this session cannot prove. Invariant 98. Kept DISTINCT
   * from "unusable" so the UI can say which email to use rather than stranding
   * someone behind a generic refusal.
   */
  | "wrong-identity"
  /** This host already holds a live grant on this board. */
  | "already-collaborator";

export type AcceptResult =
  | { ok: true; boardId: string }
  | { ok: false; reason: AcceptFailure; boundEmail?: string | null; boardId?: string };

/**
 * Consume an invitation and create the grant. ONE TRANSACTION.
 *
 * `verifiedEmail` is the email of the AUTHENTICATED SUPABASE IDENTITY, or null
 * when they signed in by phone. It is NOT `Host.email` — invariant 98 as ruled
 * 2026-09-08. That column is not unique and may hold a phone number or a UUID,
 * so comparing against it could pass the binding for the wrong person.
 *
 * Callers pass `tx`; the whole thing must commit or roll back together, or an
 * invite can be spent without producing a grant.
 */
export async function acceptInvite(
  tx: Prisma.TransactionClient,
  input: { tokenHash: string; hostId: string; verifiedEmail: string | null; now?: Date }
): Promise<AcceptResult> {
  const now = input.now ?? new Date();

  // Read first, but ONLY to tell the failures apart. Nothing is decided here:
  // the claim below re-tests every condition in its WHERE, so a row that
  // changes between this read and that update loses.
  const invite = await tx.boardInvite.findUnique({
    where: { tokenHash: input.tokenHash },
    select: {
      id: true,
      boardId: true,
      boundEmail: true,
      acceptedAt: true,
      revokedAt: true,
      expiresAt: true,
    },
  });

  if (!invite) return { ok: false, reason: "not-found" };

  // INVARIANT 99, THREE CONDITIONS AS ONE ANSWER. Accepted, revoked and expired
  // are told apart in the log and not to the caller: each distinction is a fact
  // about a link they hold and should not be able to probe for.
  if (invite.acceptedAt || invite.revokedAt || invite.expiresAt <= now) {
    return { ok: false, reason: "unusable" };
  }

  // INVARIANT 98. A bound invite needs a VERIFIED email that matches. Phone OTP
  // yields no email at all, which is a refusal rather than a pass — a bound
  // field that is not enforced is worse than no binding, because the owner
  // believes the link is safe to forward.
  if (invite.boundEmail) {
    const bound = invite.boundEmail.trim().toLowerCase();
    const actual = input.verifiedEmail?.trim().toLowerCase() ?? null;
    if (!actual || actual !== bound) {
      return { ok: false, reason: "wrong-identity", boundEmail: invite.boundEmail };
    }
  }

  // THE CLAIM — invariant 97. Conditional on `acceptedAt` being null, so two
  // simultaneous taps produce one acceptance and one zero-row update. Every
  // other condition is re-tested here rather than trusted from the read above.
  const claimed = await tx.boardInvite.updateMany({
    where: {
      id: invite.id,
      acceptedAt: null,
      revokedAt: null,
      expiresAt: { gt: now },
    },
    data: { acceptedAt: now, acceptedByHostId: input.hostId },
  });
  if (claimed.count === 0) return { ok: false, reason: "unusable" };

  // THE GRANT. A unique violation here means this host already holds a live
  // grant, and throwing rolls the claim back — the invite stays usable rather
  // than being burned by someone who did not need it.
  try {
    await tx.boardCollaborator.create({
      data: {
        boardId: invite.boardId,
        hostId: input.hostId,
        role: "MANAGER",
        status: "active",
        acceptedAt: now,
      },
    });
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "P2002") {
      // Surfaced as its own reason, and the caller must roll back. Reported
      // rather than swallowed: "you already manage this board" is a different
      // sentence from "that link is no longer valid".
      // The board is carried so the caller can send them to it: they already
      // have what the link was offering, which is not a refusal to act on.
      return { ok: false, reason: "already-collaborator", boardId: invite.boardId };
    }
    throw e;
  }

  return { ok: true, boardId: invite.boardId };
}

/**
 * Revoke a collaborator, and with them any stale BOUND invitation — invariant
 * 119, ruled 2026-09-08.
 *
 * An owner removing a manager must not leave behind an older invitation that
 * immediately recreates the access they just took away. Invariant 99 does not
 * cover it: that voids an invite which is itself expired, revoked or accepted,
 * and says nothing about the collaborator having been removed.
 *
 * BOUND INVITATIONS ONLY, and the limit is structural rather than lazy. An
 * unbound invite has no recipient identity before acceptance, so there is no
 * way to know a bearer link belongs to this person — and NO ATTEMPT IS MADE TO
 * GUESS. Guessing would revoke links belonging to people who were never
 * invited, or miss the one that matters, and both failures would be silent.
 * An owner who needs recipient-specific revocation issues a bound invite.
 *
 * `revokedEmails` are the emails this host can be reached at — the collaborator
 * row carries no email, so the caller supplies what it knows.
 */
export async function revokeCollaborator(
  tx: Prisma.TransactionClient,
  input: {
    collaboratorId: string;
    boardId: string;
    revokedByHostId: string;
    revokedEmails: string[];
    now?: Date;
  }
): Promise<{ revoked: boolean; invitesRevoked: number }> {
  const now = input.now ?? new Date();

  // Conditional on still being active: two owners clicking Revoke produce one
  // revocation, and `revoked` stays terminal for that row.
  const { count } = await tx.boardCollaborator.updateMany({
    where: { id: input.collaboratorId, boardId: input.boardId, status: "active" },
    data: { status: "revoked", revokedAt: now, revokedByHostId: input.revokedByHostId },
  });
  if (count === 0) return { revoked: false, invitesRevoked: 0 };

  const emails = input.revokedEmails
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.length > 0);
  if (emails.length === 0) return { revoked: true, invitesRevoked: 0 };

  // INVARIANT 119. Same transaction as the revocation, so there is no window in
  // which the grant is gone and the invitation still works.
  const invites = await tx.boardInvite.updateMany({
    where: {
      boardId: input.boardId,
      acceptedAt: null,
      revokedAt: null,
      boundEmail: { in: emails, mode: "insensitive" },
    },
    data: { revokedAt: now, revokedByHostId: input.revokedByHostId },
  });

  return { revoked: true, invitesRevoked: invites.count };
}
