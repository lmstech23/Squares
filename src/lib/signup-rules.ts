// Sign-up rules — PURE POLICY, NO DATABASE.
//
// Split out of signups.ts so it can be imported directly by the test runner.
// `node --experimental-strip-types` does not resolve tsconfig path aliases, so
// the moment signups.ts gained `import { prisma } from "@/lib/prisma"` the whole
// module became unimportable from a test — every assertion in it silently
// stopped running behind a load error.
//
// The split is worth having on its own terms: the rules below are the ones a
// reader needs to check against the addendum, and none of them should need a
// database to be true. signups.ts keeps the four functions that actually read
// or write, and re-exports everything here so no call site changes.

import { randomBytes, createHash } from "crypto";

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
 * Interest is a one-way OR across purchases, never a revoke (§4).
 *
 * A supporter who checks the help box on her first purchase and leaves it
 * unchecked on the second is still interested. This mirrors the supporter
 * status latch. Read as EXISTS, NEVER STORED ON THE SUPPORTER - a column there
 * would be a latch a later write could clear.
 *
 * TWO SOURCES, ONE OR. Grants carry it for ticket purchases; Contribution
 * carries it for donations, which mint no grant. The signature is unchanged
 * because both rows are just `{ wantsToHelp: boolean }` - callers pass a
 * combined array rather than this function learning about either table.
 */
export function wantsToHelp(sources: { wantsToHelp: boolean }[]): boolean {
  return sources.some((s) => s.wantsToHelp);
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
 *
 * COUNTS SPOTS, NOT PEOPLE. The guard counts `HelperSignupPosition` rows, and
 * on an ITEM one person can hold many: the earlier wording told a host with one
 * supporter holding six cases of water that "6 people have already signed up",
 * which is a false statement about her own event. The two only coincide on a
 * SHIFT, where a person holds exactly one position.
 *
 * It also no longer says "or remove someone first". Host removal does not exist
 * — HOST_REMOVED is an enum value with no endpoint behind it — and copy must not
 * point a host at a control she cannot find. See PHASE-2-BACKLOG.md.
 */
export function capacityTooLowMessage(filled: number): string {
  return `${filled} ${filled === 1 ? "spot is" : "spots are"} already filled. Set it to ${filled} or higher.`;
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

// ---------------------------------------------------------------------------
// S3 — supporter access, and the target-total transaction.
// ---------------------------------------------------------------------------

/** Days a supporter link stays usable past the event, and past issuance. */
export const TOKEN_GRACE_DAYS = 7;
const DAY_MS = 86_400_000;

/** The raw link value. Shown once in an email, never persisted. */
export function newSupporterToken(): string {
  return randomBytes(24).toString("base64url");
}

export function hashSupporterToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * When a token issued now should stop working.
 *
 * The LATER of two floors:
 *   COALESCE(event.endsAt, event.startsAt) + 7 days
 *   issuedAt                               + 7 days
 *
 * Grace runs from the event's END, not its start: a helper who worked cleanup
 * may open the link that evening to see what she signed up for, and a host
 * reconciling who actually showed does it in the days after. A link that dies
 * at midnight on event day dies exactly when someone reaches for it.
 *
 * The issuance floor exists for the late contributor. Someone who gives the
 * morning of the event would otherwise receive a link with hours left on it —
 * or, if the event has already ended, one that is born expired.
 *
 * `endsAt` is nullable on Event, so an open-ended event anchors to its start.
 *
 * COMPUTED ONCE, AT ISSUANCE. A later edit to the event's dates does not move
 * an existing token's expiry. The alternative — recomputing on read — would let
 * a host shorten an event and silently kill links already in people's inboxes.
 */
export function tokenExpiryFor(
  event: { startsAt: Date; endsAt: Date | null },
  issuedAt: Date = new Date()
): Date {
  const anchor = event.endsAt ?? event.startsAt;
  const fromEvent = anchor.getTime() + TOKEN_GRACE_DAYS * DAY_MS;
  const fromIssue = issuedAt.getTime() + TOKEN_GRACE_DAYS * DAY_MS;
  return new Date(Math.max(fromEvent, fromIssue));
}

/**
 * Resolve a raw link token to a supporter session.
 *
 * A VALID, UNEXPIRED, UNREVOKED TOKEN OPENS THE SHEET REGARDLESS OF SUPPORTER
 * STATUS. Rendering and claiming are separate gates: this function answers
 * "whose link is this and is the link still good", and `mayClaim()` separately
 * answers "may she change anything". A supporter whose contribution was
 * disputed keeps her commitments (addendum §10, invariant 44) and must be able
 * to see and withdraw them; refusing to render would hide the very rows the
 * host is meant to review.
 *
 * Returns null for malformed, unknown, expired and revoked alike at the lookup
 * level — the caller distinguishes expired from unknown for copy, and does so
 * without leaking whether a hash exists.
 */
/** Why a token did not resolve. For copy only — never for a status code that leaks. */
/**
 * Distinguish expired and revoked from unknown, for the message only.
 *
 * Called ONLY after `resolveSupporterSession` returns null. A malformed or
 * unknown token and a real-but-dead one get different copy, because someone
 * holding a link that used to work deserves to be told to ask for a new one
 * rather than that her link was never valid. It does not change the response
 * status, and it reveals nothing about hashes that do not exist.
 */
/**
 * The ONE issuer. Returns the existing live token when there is one.
 *
 * §5: the return-page poll and the confirmation email both need a link and can
 * fire milliseconds apart. Two callers must never mint two competing links —
 * the parent who clicks the older one out of her inbox at 6am has to land
 * somewhere that works.
 *
 * The raw value is returned only when a token is newly created, because it is
 * not recoverable afterwards. A caller that finds `token: null` has a live link
 * it cannot re-send; that is the correct outcome, not a bug, and it is why the
 * link is emailed at issuance rather than looked up later.
 */
/** What a supporter may set on one slot, given what everyone holds. */
export interface SlotAvailability {
  capacity: number;
  /** Positions taken on the slot, by everyone including this supporter. */
  filled: number;
  /** capacity - filled, clamped at zero. */
  available: number;
  /** This supporter's own held quantity. */
  yourCurrent: number;
  /** The stepper ceiling: yourCurrent + available. */
  maxTarget: number;
}

/**
 * `available` is what is left on the SLOT; `maxTarget` is what this SUPPORTER
 * may set.
 *
 * They differ by her own holding, and conflating them is the easy bug: a
 * supporter holding 2 of 6 with 1 left can set a target of 3, not 1. Her own
 * positions are not an obstacle to her own target.
 */
export function slotAvailability(
  capacity: number,
  filled: number,
  yourCurrent: number,
  slotType: "SHIFT" | "ITEM"
): SlotAvailability {
  const available = Math.max(0, capacity - filled);
  // The ceiling is what she already holds plus what is free — then capped by
  // the slot type. A SHIFT caps at 1, but that cap is a MAXIMUM, not a floor:
  // someone holding none of a full shift has a ceiling of ZERO, not one.
  // Returning 1 there let a second person target a shift another supporter
  // already had.
  const typeCap = slotType === "SHIFT" ? 1 : capacity;
  return {
    capacity,
    filled,
    available,
    yourCurrent,
    maxTarget: Math.min(yourCurrent + available, typeCap),
  };
}

/**
 * Set a supporter's held quantity on one slot to `target`. THE ONLY WRITER of
 * HelperSignup and HelperSignupPosition.
 *
 * ABSOLUTE, NOT A DELTA. `target` is what she wants to hold afterwards. That is
 * what makes replay harmless: a double-tap, a refresh mid-submit, or a retry
 * after a timeout all compute a delta of zero the second time and change
 * nothing. It is why no claim idempotency key exists — the operation is
 * idempotent by shape rather than by bookkeeping.
 *
 * HOLDS `SELECT ... FOR UPDATE` ON THE SLOT ROW for the whole transaction.
 * That is not an optimization. Capacity is not a database constraint on
 * claiming — `unique (slotId, position)` stops two people taking the same seat,
 * but the ceiling itself is applied here in code. S2's capacity edit takes a row
 * lock on the same slot through its conditional UPDATE, so with this lock a
 * capacity reduction and a claim serialize. Without it a claim can slip past a
 * ceiling lowered a moment earlier.
 *
 * Never silently gives fewer than asked. A supporter who wants 3 and can have 2
 * is told so and re-confirms; a host reading "3 cases" who receives 2 has a real
 * problem at 8am.
 */
