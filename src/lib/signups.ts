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

// ---------------------------------------------------------------------------
// S2 — host slot builder. Derivation and validation only; no writes live here.
// ---------------------------------------------------------------------------

export interface SlotFill {
  capacity: number;
  filled: number;
  open: number;
  isFull: boolean;
}

/**
 * Fill state for one slot, from a live count of its position rows.
 *
 * `filled` is ALWAYS a count of HelperSignupPosition and never a stored column.
 * There is no `filledCount` to drift, which is the same decision that keeps
 * quantity off HelperSignup.
 *
 * `open` clamps at zero: capacity can legitimately sit below the filled count
 * for a slot whose capacity was reduced before anyone claimed, and a negative
 * "open" is not something to render.
 */
export function slotFillState(capacity: number, positionCount: number): SlotFill {
  const open = Math.max(0, capacity - positionCount);
  return { capacity, filled: positionCount, open, isFull: open === 0 };
}

export interface SheetSummary {
  slotCount: number;
  totalCapacity: number;
  totalFilled: number;
  totalOpen: number;
}

/**
 * The one line at the top of the host panel.
 *
 * CURRENT OPERATIONAL STATE ONLY. No cancellation count: SignupLog is
 * append-only, so a raw CANCELLED tally counts cancel-and-reclaim cycles by the
 * same person and answers a question nobody asked. What a host needs standing in
 * a parking lot is how many openings are left.
 */
export function sheetSummary(slots: { capacity: number; filled: number }[]): SheetSummary {
  return slots.reduce<SheetSummary>(
    (acc, s) => ({
      slotCount: acc.slotCount + 1,
      totalCapacity: acc.totalCapacity + s.capacity,
      totalFilled: acc.totalFilled + s.filled,
      totalOpen: acc.totalOpen + Math.max(0, s.capacity - s.filled),
    }),
    { slotCount: 0, totalCapacity: 0, totalFilled: 0, totalOpen: 0 }
  );
}

export const MAX_SLOT_NAME = 80;
export const MAX_SLOT_NOTES = 200;
export const MAX_UNIT_LABEL = 40;
export const MAX_SHEET_TITLE = 80;
/** "Two lines at most" is UX guidance, applied here rather than in the schema. */
export const MAX_SHEET_INSTRUCTIONS = 280;
export const DEFAULT_SHEET_TITLE = "Volunteer Sign-Up";

export interface SlotInput {
  slotType: "SHIFT" | "ITEM";
  name: string;
  capacity: number;
  startsAt?: Date | null;
  endsAt?: Date | null;
  unitLabel?: string | null;
  notes?: string | null;
}

export type ValidationResult = { ok: true } | { ok: false; field: string; message: string };

/**
 * Application-level slot validation.
 *
 * MIRRORS THE S1 CHECK CONSTRAINTS DELIBERATELY. The database is the backstop,
 * not the only guard: a constraint violation surfacing to a host as a 500 with
 * a Postgres constraint name in it is a failure of this function, not of the
 * constraint.
 *
 * NOT validated: whether shift times fall inside the event window. Setup starts
 * before the event and cleanup runs after it, so that check would reject the two
 * most common shifts a host creates.
 */
export function validateSlotInput(input: SlotInput): ValidationResult {
  const name = input.name?.trim() ?? "";
  if (name.length === 0) return { ok: false, field: "name", message: "Give this a name." };
  if (name.length > MAX_SLOT_NAME)
    return { ok: false, field: "name", message: `Keep the name under ${MAX_SLOT_NAME} characters.` };

  if (!Number.isInteger(input.capacity) || input.capacity < 1)
    return { ok: false, field: "capacity", message: "Capacity must be at least 1." };

  if ((input.notes?.length ?? 0) > MAX_SLOT_NOTES)
    return { ok: false, field: "notes", message: `Keep notes under ${MAX_SLOT_NOTES} characters.` };

  if (input.slotType === "SHIFT") {
    if (!input.startsAt)
      return { ok: false, field: "startsAt", message: "A shift needs a start time." };
    if (input.endsAt && input.endsAt <= input.startsAt)
      return { ok: false, field: "endsAt", message: "The end time must be after the start." };
    if (input.unitLabel)
      return { ok: false, field: "unitLabel", message: "Only items have a unit label." };
  } else {
    if (input.startsAt || input.endsAt)
      return { ok: false, field: "startsAt", message: "Items don't have times." };
    if ((input.unitLabel?.length ?? 0) > MAX_UNIT_LABEL)
      return { ok: false, field: "unitLabel", message: `Keep the unit label under ${MAX_UNIT_LABEL} characters.` };
  }
  return { ok: true };
}

export type ReorderResult = { ok: true } | { ok: false; reason: string };

/**
 * A reorder must name exactly the slots this sheet has — no more, no fewer, no
 * duplicates, nothing from another sheet.
 *
 * Compared as SETS rather than by length. A submission that swaps one id for a
 * foreign one has the right length and would pass a count check while silently
 * dropping a slot from the order and touching a slot the host does not own.
 *
 * A slot added or removed between page load and submit fails here, and the host
 * is told to refresh. That is correct: applying a stale order would drop the new
 * slot to an arbitrary position.
 */
export function validateReorder(submitted: string[], actual: string[]): ReorderResult {
  if (new Set(submitted).size !== submitted.length)
    return { ok: false, reason: "The same slot appears twice in that order." };
  const a = new Set(actual);
  const b = new Set(submitted);
  if (a.size !== b.size || [...a].some((id) => !b.has(id)))
    return { ok: false, reason: "This sheet changed while you were reordering. Refresh and try again." };
  return { ok: true };
}

/**
 * Rewrite sortOrder as 0..n-1 from the submitted order.
 *
 * Normalizing after every reorder means gaps and duplicates cannot accumulate,
 * so no (sheetId, sortOrder) uniqueness constraint is needed. Ordering only ever
 * needs relative comparison; the absolute values are disposable.
 */
export function normalizeSortOrder(orderedIds: string[]): { id: string; sortOrder: number }[] {
  return orderedIds.map((id, i) => ({ id, sortOrder: i }));
}

/**
 * The message shown when a host tries to set capacity below what is already
 * claimed. Lives here so the API and any future UI cannot word it differently.
 */
export function capacityTooLowMessage(filled: number): string {
  return `${filled} ${filled === 1 ? "person has" : "people have"} already signed up for this. Set it to ${filled} or higher, or remove someone first.`;
}

/**
 * A saved slot's type is immutable.
 *
 * NOT ENFORCEABLE IN THE DATABASE. The S1 CHECK constraints police internal
 * consistency — an ITEM with times is rejected, a SHIFT with a unitLabel is
 * rejected — but a CHECK only ever sees the row's present state. A clean flip
 * that also clears the now-invalid fields produces a row Postgres accepts,
 * and that is exactly what a well-formed client would send. Immutability is a
 * claim about the row's history, so it has to live here.
 *
 * Why it matters beyond tidiness: slotType decides whether a commitment may
 * hold more than one position (`isValidPositionCount`). Flipping a SHIFT with
 * one signup into an ITEM silently changes what that existing commitment is
 * allowed to be, and flipping an ITEM holding four positions into a SHIFT makes
 * every one of them retroactively invalid. The host wanting the other kind
 * wants a different slot, not the same slot renamed.
 */
export function slotTypeChangeRejected(current: string, requested: unknown): boolean {
  return typeof requested === "string" && requested.length > 0 && requested !== current;
}

export const SLOT_TYPE_IMMUTABLE_MESSAGE =
  "A shift can't become an item, or the other way around. Add a new one instead.";
