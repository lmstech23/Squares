// The winner notification record — collaborators v2.2 §9.1, invariant 117.
//
// THE AUTHORITATIVE SHAPE FOR `Board.winnerNotifiedByPeriod`, and the one place
// it is written or parsed. `notify-winner` writes through `notificationValue`;
// `resend-winner-sms` reads through `parseNotification`. Neither route may treat
// the stored value as the former string-only squareId form, and neither builds
// or picks apart the JSON itself.
//
// WHAT CHANGED AND WHY. The map was `period -> squareId`. The lock pinned the
// SQUARE; it did not pin the PHONE. `resend-winner-sms` re-read `playerPhone`
// from that square at send time, so editing the phone between the first
// notification and a resend sent to the new number — making resend not a repeat
// of a send but a NEW send to whatever number the square currently held. That is
// an authority to text an arbitrary recipient, and it is why `winner.resend`
// could not be a MANAGER capability until this landed.
//
// NO LEGACY BRANCH. Verified against production 2026-09-08: 22 boards, 22 empty
// `{}` maps, zero non-empty. `notify-winner` has never run there. There are no
// rows in the old form to migrate, so there is no dual read and no compatibility
// shim — a shim would be code nobody can exercise, guarding a case that does not
// exist.
//
// THE SHAPE IS DELIBERATELY NOT FROZEN in the addendum: the binding requirement
// is only that it carries the locked squareId and the phone used. Fields may be
// added here later without a product amendment. `parseNotification` therefore
// validates the two required keys and ignores anything else it finds.

export interface WinnerNotification {
  /** The winner, fixed at notification. Existing lock semantics, unchanged. */
  squareId: string;
  /**
   * The number on file WHEN THE WINNER WAS NOTIFIED, and the only destination a
   * resend may use — invariant 117.
   *
   * NULL IS A REAL ANSWER. A winner can be notified with no phone on file:
   * `notify-winner` sends an EMAIL and requires only an email address, so a
   * square with no phone still gets notified and still gets locked. Storing null
   * records that truthfully, and a resend then refuses rather than falling back
   * to reading the square — which is the behaviour being removed.
   */
  phone: string | null;
  /** When the lock was written. Not required by the model; useful in support. */
  notifiedAt: string;
}

/** What `notify-winner` stores. The only place this object is constructed. */
export function notificationValue(input: {
  squareId: string;
  phone: string | null;
  now?: Date;
}): WinnerNotification {
  return {
    squareId: input.squareId,
    // Trimmed, and empty means absent — the same normalisation every other
    // contact field in this codebase applies, so a whitespace-only column does
    // not become a Twilio destination.
    phone: input.phone?.trim() || null,
    notifiedAt: (input.now ?? new Date()).toISOString(),
  };
}

export type NotificationParse =
  /**
   * A usable record. `phone` is carried NON-NULL here as well as inside the
   * notification, so the send site cannot be written without the compiler
   * having proved a destination exists — the alternative is a `!` at the one
   * call that decides where a text goes.
   */
  | { ok: true; notification: WinnerNotification; phone: string }
  /** No entry for this period. The un-notified-period guard, unchanged. */
  | { ok: false; reason: "missing" }
  /** An entry exists but is not a notification record. Fails closed. */
  | { ok: false; reason: "malformed" }
  /** A valid record whose winner had no phone when they were notified. */
  | { ok: false; reason: "no-phone"; notification: WinnerNotification };

/**
 * Read one period's notification out of the stored map.
 *
 * FAILS CLOSED, AND NEVER FALLS BACK TO THE SQUARE. The defensive branch exists
 * even though production holds nothing malformed: a hand-edited row, a partial
 * write, or a future writer that forgets this module would otherwise reach the
 * send path. What it must NOT do on failure is read `playerPhone` — that
 * fallback is precisely the behaviour being removed, and reinstating it under an
 * error condition would bring it back exactly when something is already wrong.
 *
 * A BARE STRING IS MALFORMED, not a legacy value to be honoured. Production has
 * none, and accepting one would silently restore the unpinned behaviour for any
 * row that happened to carry the old shape.
 */
export function parseNotification(
  map: unknown,
  periodLabel: string
): NotificationParse {
  if (typeof map !== "object" || map === null || Array.isArray(map)) {
    return { ok: false, reason: "malformed" };
  }

  const raw = (map as Record<string, unknown>)[periodLabel];
  if (raw === undefined || raw === null) return { ok: false, reason: "missing" };

  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "malformed" };
  }

  const entry = raw as Record<string, unknown>;
  const squareId = entry.squareId;
  if (typeof squareId !== "string" || squareId.length === 0) {
    return { ok: false, reason: "malformed" };
  }

  const phoneRaw = entry.phone;
  if (phoneRaw !== null && phoneRaw !== undefined && typeof phoneRaw !== "string") {
    return { ok: false, reason: "malformed" };
  }
  const phone = typeof phoneRaw === "string" ? phoneRaw.trim() || null : null;

  const notification: WinnerNotification = {
    squareId,
    phone,
    notifiedAt:
      typeof entry.notifiedAt === "string" ? entry.notifiedAt : "",
  };

  if (!phone) return { ok: false, reason: "no-phone", notification };
  return { ok: true, notification, phone };
}

/**
 * Was this period notified at all? For display only.
 *
 * The host board page and the score entry form ask nothing but "is there an
 * entry", and they must not care about its shape — the whole point of routing
 * every structural question through this module.
 */
export function isNotified(map: unknown, periodLabel: string): boolean {
  const parsed = parseNotification(map, periodLabel);
  return parsed.ok || parsed.reason !== "missing";
}
