// Sign-up sheets — the database side. fundraiser-signup-addendum.md §3, §5, §6.
//
// SOLE OWNER OF CLAIM, CANCEL, AND POSITION ALLOCATION (§14). Nothing else may
// insert a `HelperSignup` or a `HelperSignupPosition`.
//
// Pure policy lives in signup-rules.ts and is re-exported here, so callers keep
// importing one module. Only the four functions below touch Postgres.

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  mayClaim,
  isValidPositionCount,
  slotAvailability,
  hashSupporterToken,
  newSupporterToken,
  tokenExpiryFor,
} from "@/lib/signup-rules";

export * from "@/lib/signup-rules";

/** Claim, cancel and token issuance are the only database-touching parts. */
export type SignupsTransaction = Prisma.TransactionClient;

export interface SupporterSession {
  supporterId: string;
  eventId: string;
  /** Live status. RENDERING DOES NOT DEPEND ON IT — see below. */
  status: string;
  name: string;
}

export async function resolveSupporterSession(
  token: string | undefined | null,
  now: Date = new Date()
): Promise<SupporterSession | null> {
  if (!token || token.length < 16 || token.length > 128) return null;

  const row = await prisma.supporterAccessToken.findFirst({
    where: { tokenHash: hashSupporterToken(token), revokedAt: null, expiresAt: { gt: now } },
    select: {
      supporter: { select: { id: true, eventId: true, status: true, name: true } },
    },
  });
  if (!row) return null;

  return {
    supporterId: row.supporter.id,
    eventId: row.supporter.eventId,
    status: row.supporter.status,
    name: row.supporter.name,
  };
}

export type TokenFailure = "unknown" | "expired" | "revoked";

export async function classifyTokenFailure(
  token: string | undefined | null,
  now: Date = new Date()
): Promise<TokenFailure> {
  if (!token || token.length < 16 || token.length > 128) return "unknown";
  const row = await prisma.supporterAccessToken.findFirst({
    where: { tokenHash: hashSupporterToken(token) },
    select: { revokedAt: true, expiresAt: true },
  });
  if (!row) return "unknown";
  if (row.revokedAt) return "revoked";
  if (row.expiresAt <= now) return "expired";
  return "unknown";
}

export async function getOrCreateSupporterAccessToken(
  supporterId: string,
  now: Date = new Date()
): Promise<{ id: string; token: string | null; expiresAt: Date }> {
  const live = await prisma.supporterAccessToken.findFirst({
    where: { eventSupporterId: supporterId, revokedAt: null, expiresAt: { gt: now } },
    orderBy: { createdAt: "desc" },
    select: { id: true, expiresAt: true },
  });
  if (live) return { id: live.id, token: null, expiresAt: live.expiresAt };

  const supporter = await prisma.eventSupporter.findUniqueOrThrow({
    where: { id: supporterId },
    select: { event: { select: { startsAt: true, endsAt: true } } },
  });

  const raw = newSupporterToken();
  const created = await prisma.supporterAccessToken.create({
    data: {
      eventSupporterId: supporterId,
      tokenHash: hashSupporterToken(raw),
      expiresAt: tokenExpiryFor(supporter.event, now),
    },
    select: { id: true, expiresAt: true },
  });
  return { id: created.id, token: raw, expiresAt: created.expiresAt };
}

/**
 * Issue a link the recipient can actually follow — ALWAYS.
 *
 * WHY THIS EXISTS ALONGSIDE getOrCreateSupporterAccessToken. That function
 * returns `token: null` when a live row already exists, because only the HASH
 * is stored and the raw value cannot be re-derived. Every caller after the
 * first therefore had nothing to render. In production that produced an email
 * reading "open your sign-up link from the board page — we already sent you
 * one" when no such link had ever been sent: a message pointing at something
 * that does not exist, and a dead end by construction rather than by accident.
 *
 * THE DECISION: mint a fresh token and LEAVE THE EXISTING ONES VALID.
 *
 * Considered and rejected:
 *   - Store the raw token. Defeats the point of hashing: a database read would
 *     hand over live links for every supporter.
 *   - Rotate — mint new, revoke old. Always yields a working link, but breaks
 *     a link already sitting in someone's inbox the moment they buy again.
 *     Password-reset semantics applied to a thing people are expected to keep.
 *   - Resolve /signup by supporter id. That is not a token, it is an
 *     enumerable identifier, and the sheet grants the ability to claim slots.
 *
 * What this costs: a supporter can hold more than one live token. That is
 * acceptable and bounded — each is supporter-scoped, expires with the event,
 * and is revocable. It does not weaken the addendum's idempotency intent:
 * §5b's dedupe key is about not NOTIFYING someone twice, which the
 * NotificationDelivery keys still govern. Reusing the row was an
 * optimisation, never a security boundary.
 *
 * Callers that only need to know a token exists should keep using
 * getOrCreateSupporterAccessToken. This one is for callers that must render a
 * URL.
 */
export async function issueSupporterAccessLink(
  supporterId: string,
  now: Date = new Date()
): Promise<{ id: string; token: string; expiresAt: Date }> {
  const supporter = await prisma.eventSupporter.findUniqueOrThrow({
    where: { id: supporterId },
    select: { event: { select: { startsAt: true, endsAt: true } } },
  });

  const raw = newSupporterToken();
  const created = await prisma.supporterAccessToken.create({
    data: {
      eventSupporterId: supporterId,
      tokenHash: hashSupporterToken(raw),
      expiresAt: tokenExpiryFor(supporter.event, now),
    },
    select: { id: true, expiresAt: true },
  });
  return { id: created.id, token: raw, expiresAt: created.expiresAt };
}

export type TargetOutcome =
  | { ok: true; changed: false; quantity: number }
  | { ok: true; changed: true; quantity: number; action: "CLAIMED" | "CANCELLED" }
  | { ok: false; reason: "closed"; }
  | { ok: false; reason: "not_active" }
  | { ok: false; reason: "invalid_target"; message: string }
  | { ok: false; reason: "capacity"; available: number; yourCurrent: number; maxTarget: number };

export async function setTargetQuantity(args: {
  slotId: string;
  supporterId: string;
  target: number;
  actorType: "SUPPORTER" | "HOST";
  now?: Date;
}): Promise<TargetOutcome> {
  const { slotId, supporterId, target, actorType } = args;

  if (!Number.isInteger(target) || target < 0) {
    return { ok: false, reason: "invalid_target", message: "Choose a whole number." };
  }

  return prisma.$transaction(async (tx) => {
    // 1. LOCK THE SLOT. Everything below reads state that this lock freezes.
    const locked = await tx.$queryRawUnsafe<
      { id: string; capacity: number; slot_type: string; is_open: boolean }[]
    >(
      `SELECT s.id, s.capacity, s.slot_type::text AS slot_type, sh.is_open
         FROM signup_slots s
         JOIN signup_sheets sh ON sh.id = s.sheet_id
        WHERE s.id = $1::uuid
          FOR UPDATE OF s`,
      slotId
    );
    if (locked.length === 0) {
      return { ok: false as const, reason: "invalid_target" as const, message: "Slot not found." };
    }
    const slot = locked[0];
    const slotType = slot.slot_type as "SHIFT" | "ITEM";

    // 2. Eligibility. Claiming is gated on ACTIVE status; rendering is not.
    const supporter = await tx.eventSupporter.findUnique({
      where: { id: supporterId },
      select: { status: true },
    });
    if (!supporter) {
      return { ok: false as const, reason: "not_active" as const };
    }

    // 3. Current holdings, under the lock.
    const commitment = await tx.helperSignup.findUnique({
      where: { slotId_eventSupporterId: { slotId, eventSupporterId: supporterId } },
      select: { id: true, positions: { select: { position: true }, orderBy: { position: "asc" } } },
    });
    const mine = commitment?.positions.map((p) => p.position) ?? [];
    const yourCurrent = mine.length;

    // A zero delta changes nothing and writes NO LOG ROW. The log records
    // committed state changes, not HTTP requests; a replayed request must not
    // leave a second entry describing one decision.
    if (target === yourCurrent) {
      return { ok: true as const, changed: false as const, quantity: yourCurrent };
    }

    const increasing = target > yourCurrent;

    // 4. A closed sheet blocks INCREASES only. Reductions and cancellation
    //    continue — S2 ruling 1, and the host copy already promises it.
    if (!slot.is_open && increasing) {
      return { ok: false as const, reason: "closed" as const };
    }

    // Only an active supporter may increase. She may always reduce: a helper
    // who knows she cannot attend must be able to free the slot whatever her
    // contribution's status.
    if (increasing && !mayClaim(supporter.status)) {
      return { ok: false as const, reason: "not_active" as const };
    }

    if (!isValidPositionCount(slotType, target, slot.capacity) && target !== 0) {
      return {
        ok: false as const,
        reason: "invalid_target" as const,
        message:
          slotType === "SHIFT"
            ? "A shift is one person."
            : `You can take at most ${slot.capacity}.`,
      };
    }

    const taken = await tx.helperSignupPosition.findMany({
      where: { slotId },
      select: { position: true },
    });
    const filled = taken.length;

    if (increasing) {
      const avail = slotAvailability(slot.capacity, filled, yourCurrent, slotType);
      if (target > avail.maxTarget) {
        return {
          ok: false as const,
          reason: "capacity" as const,
          available: avail.available,
          yourCurrent,
          maxTarget: avail.maxTarget,
        };
      }
      // Lowest free numbers, excluding everything already taken.
      const used = new Set(taken.map((t) => t.position));
      const need = target - yourCurrent;
      const toAdd: number[] = [];
      for (let n = 1; toAdd.length < need && n <= slot.capacity; n++) {
        if (!used.has(n)) toAdd.push(n);
      }
      // Belt and braces. The ceiling check above should already have caught
      // this, and it did not once: a SHIFT whose ceiling was hardcoded to 1
      // passed the check, found no free number, and created a HelperSignup
      // holding ZERO positions. A commitment with no positions is not a
      // commitment, so refuse rather than write one.
      if (toAdd.length < need) {
        return {
          ok: false as const,
          reason: "capacity" as const,
          available: Math.max(0, slot.capacity - filled),
          yourCurrent,
          maxTarget: Math.min(yourCurrent + Math.max(0, slot.capacity - filled), slotType === "SHIFT" ? 1 : slot.capacity),
        };
      }
      const signupId =
        commitment?.id ??
        (
          await tx.helperSignup.create({
            data: { slotId, eventSupporterId: supporterId },
            select: { id: true },
          })
        ).id;
      await tx.helperSignupPosition.createMany({
        data: toAdd.map((position) => ({ helperSignupId: signupId, slotId, position })),
      });
    } else {
      // HIGHEST-NUMBERED FIRST. Positions are fungible reusable capacity, so
      // which rows go is a free choice — and taking from the top keeps the
      // occupied range dense at 1..n, which pairs with allocating the lowest
      // free numbers above.
      const drop = mine.slice(-(yourCurrent - target));
      await tx.helperSignupPosition.deleteMany({
        where: { slotId, position: { in: drop } },
      });
      if (target === 0 && commitment) {
        // A commitment with no positions is not a commitment.
        await tx.helperSignup.delete({ where: { id: commitment.id } });
      }
    }

    // 5. The audit row, IN THIS TRANSACTION. Action is the DIRECTION of the
    //    change, not the row lifecycle: 2 -> 4 is CLAIMED though the commitment
    //    already existed, 4 -> 2 is CANCELLED though it survives.
    await tx.signupLog.create({
      data: {
        slotId,
        eventSupporterId: supporterId,
        action: increasing ? "CLAIMED" : actorType === "HOST" ? "HOST_REMOVED" : "CANCELLED",
        actorType,
        quantityAfter: target,
      },
    });

    return {
      ok: true as const,
      changed: true as const,
      quantity: target,
      action: (increasing ? "CLAIMED" : "CANCELLED") as "CLAIMED" | "CANCELLED",
    };
  });
}
