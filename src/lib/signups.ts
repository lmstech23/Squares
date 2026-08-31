// Sign-up sheets — fundraiser-signup-addendum.md v1.6 §3, §6.
//
// SOLE OWNER OF CLAIM, CANCEL, AND POSITION ALLOCATION (§14). Nothing else may
// insert a `HelperSignup` or a `HelperSignupPosition`. That is not a style
// preference: one rule in this feature cannot be expressed as a database
// constraint, and this file is the only place it can live.
//
// S1 IS SCHEMA ONLY. The claim and cancel paths land in S3. What is here now is
// the enforcement rule written down where it will be needed, and the shape of
// the module the addendum specifies — not a working claim path.
//
// ---------------------------------------------------------------------------
// The rule the database cannot hold
// ---------------------------------------------------------------------------
//
// A `SHIFT` commitment is valid only with EXACTLY ONE position. An `ITEM`
// commitment may hold up to `capacity`.
//
// This cannot be a CHECK constraint and cannot be a partial unique index: both
// would have to read `slot_type`, which lives on `SignupSlot`, and a Postgres
// CHECK or partial-index predicate may only reference columns on its own table.
// An earlier draft of the addendum tried exactly that and would not have
// migrated.
//
// Everything else IS in the database, deliberately:
//
//   capacity safety      unique (slotId, position) on HelperSignupPosition
//   one per person/slot  unique (slotId, eventSupporterId) on HelperSignup
//   position belongs to
//   its commitment's slot (helperSignupId, slotId) -> HelperSignup (id, slotId)
//
// No mutable counter exists anywhere. Quantity is never stored — it is
// count(positions) — so there is nothing to drift out of step with reality.
//
// ---------------------------------------------------------------------------
// What this file will own, in S3
// ---------------------------------------------------------------------------
//
//   claimSlot()        allocate N positions, all-or-nothing, retry on the
//                      unique violation that means someone else took the seat
//   cancelSignup()     delete the commitment; positions cascade; write a log
//   cancelPositions()  partial cancel on an ITEM — 4 cases down to 2 — leaves
//                      the commitment standing
//   getOrCreateSupporterAccessToken()
//
// Position numbers are FREED FOR REUSE on cancellation. This is where sign-ups
// deliberately diverge from admission passes: `AdmissionPass.sequenceNumber` is
// monotonic and never reused because a pass is an entitlement and reuse would
// be a security question. A slot position is a seat, not a credential.
//
// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------
//
// Derived, never stored (§1). Only a supporter with `status = "active"` may
// claim — invariant 35. A `pending` or `reserved_cash` contribution grants no
// sign-up access (invariant 37), and the help checkbox records intent only,
// never a hold (invariant 36).
//
// A helper signup grants no square, no drawing entry, no admission pass, and no
// check-in authority (invariant 34). Check-in authority originates only from a
// host-issued `CheckinStaffAccess` link (invariant 41). These two things sit
// next to each other in the host panel and must never be wired together.

import type { Prisma } from "@prisma/client";

/**
 * How many positions a commitment on this slot type may hold.
 *
 * The single expression of the rule the database cannot enforce. Every claim
 * path must consult it; nothing may insert positions without doing so.
 */
export function maxPositionsPerCommitment(slotType: "SHIFT" | "ITEM", capacity: number): number {
  return slotType === "SHIFT" ? 1 : capacity;
}

/**
 * Is this a legal number of positions for a commitment on this slot type?
 *
 * `SHIFT` is exactly one — not "at most one". A commitment with zero positions
 * is not a commitment; cancelling the last position drops the commitment
 * itself (§6).
 */
export function isValidPositionCount(
  slotType: "SHIFT" | "ITEM",
  count: number,
  capacity: number
): boolean {
  if (count < 1) return false;
  if (slotType === "SHIFT") return count === 1;
  return count <= capacity;
}

/**
 * Only an `active` supporter may claim. Invariants 35 and 37.
 *
 * Derived from status at the moment of the claim, never read from a stored
 * eligibility column — there is no such column and there must not be one.
 */
export function mayClaim(supporterStatus: string): boolean {
  return supporterStatus === "active";
}

/**
 * Interest is a one-way OR across grants, never a revoke (§4).
 *
 * A supporter who checks the help box on her first purchase and leaves it
 * unchecked on the second is still interested. This mirrors the supporter
 * status latch. Read as EXISTS, never stored on the supporter.
 */
export function wantsToHelp(grants: { wantsToHelp: boolean }[]): boolean {
  return grants.some((g) => g.wantsToHelp);
}

/** The dedupe keys from §5b. The key names the thing being communicated. */
export const dedupeKeys = {
  /** One per supporter, ever — the token is supporter-scoped and reusable. */
  signupLink: (eventSupporterId: string) => `supporter:${eventSupporterId}`,
  /**
   * One per contribution. NOT supporter-scoped: a parent who buys in September
   * and again in October deserves two receipts, and a supporter key would
   * silently suppress the second.
   */
  contributionConfirmed: (admissionGrantId: string) => `grant:${admissionGrantId}`,
} as const;

/**
 * Claim, cancel and token issuance land in S3 and S4.
 *
 * Left unimplemented rather than stubbed: a function that silently does nothing
 * is worse than one that does not exist, because a caller can be written
 * against it.
 */
export type SignupsTransaction = Prisma.TransactionClient;
