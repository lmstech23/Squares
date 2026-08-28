/**
 * Wall-clock to UTC conversion for host-entered dates.
 *
 * A `datetime-local` input yields a wall-clock string with no timezone —
 * "2026-10-24T19:00". Passing that to `new Date()` interprets it in the
 * *server's* zone, which is UTC on Vercel, so a 7pm campaign close in New
 * York would be stored as 2pm and the board would close five hours early with
 * no error anywhere.
 *
 * The host picks an IANA timezone alongside the date, so the wall clock is
 * resolved against that zone explicitly. `campaignEndsAt` gates money and
 * caps `cashHoldDays` (money doc invariant 6), so this has to be right across
 * DST boundaries, not merely right in summer.
 *
 * No dependency — `Intl` already carries the tz database.
 */

/** Offset of `timeZone` from UTC, in milliseconds, at the given instant. */
export function tzOffsetMs(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);

  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);

  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    // Some locales render midnight as hour 24; normalize it to 0.
    get("hour") % 24,
    get("minute"),
    get("second")
  );

  return asUtc - date.getTime();
}

/**
 * Which instant to pick when a wall clock occurs twice — the fall-back hour.
 *
 * There is no safe default, so callers state it. A generic converter cannot
 * know whether it is resolving a deadline or a start time, and either
 * convention is wrong half the time. v2 §5:
 *
 *   campaignEndsAt   "later"    a deadline — nobody is harmed by an extra
 *                               hour; someone loses an hour they thought
 *                               they had
 *   earlyBirdEndsAt  "later"    same, a deadline
 *   Event.startsAt   "earlier"  a start time — doors open at the first
 *                               1:30am, not the second
 *
 * This does NOT apply to the spring-forward gap, which is not a choice
 * between two real instants. See `parseZoned`.
 */
export type Ambiguity = "earlier" | "later";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Converts "YYYY-MM-DDTHH:mm" from a `datetime-local` input into a UTC instant,
 * interpreting the wall clock in `timeZone`.
 *
 * Two wall clocks a year are not a single instant, and both are resolved
 * deliberately:
 *
 * - **Gap** (spring forward). 2:30am does not exist on the changeover day.
 *   Always shifts **forward**, to 3:30am, regardless of `whenAmbiguous`. This
 *   is absolute: resolving it backward to 1:30am would close a board an hour
 *   before its stated deadline, silently and with nothing in the logs.
 * - **Ambiguous** (fall back). 1:30am happens twice. `whenAmbiguous` decides.
 *
 * Returns null for missing, malformed, or out-of-range input, and for an
 * invalid IANA zone, so callers can write their own error copy.
 */
export function parseZoned(
  value: string | null | undefined,
  timeZone: string,
  whenAmbiguous: Ambiguity
): Date | null {
  if (!value) return null;

  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
  if (!m) return null;

  const [year, month, day, hour, minute] = m.slice(1).map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) {
    return null;
  }

  // Treat the wall clock as if it were UTC; the real instant is that minus the
  // zone's offset. Which offset, though, is the whole question near a
  // transition, so both candidates are built and tested rather than guessed at
  // and corrected once.
  const guess = Date.UTC(year, month - 1, day, hour, minute);

  let offsetBefore: number;
  let offsetAfter: number;
  try {
    // A day either side straddles any transition without landing on it.
    offsetBefore = tzOffsetMs(new Date(guess - DAY_MS), timeZone);
    offsetAfter = tzOffsetMs(new Date(guess + DAY_MS), timeZone);
  } catch {
    return null; // invalid IANA zone
  }

  const candidates = Array.from(
    new Set([guess - offsetBefore, guess - offsetAfter])
  ).map((t) => new Date(t));

  // A candidate is real only if reading it back in the zone gives the wall
  // clock the host actually typed.
  const real = candidates.filter(
    (c) => c.getTime() + tzOffsetMs(c, timeZone) === guess
  );

  let result: Date;
  if (real.length === 0) {
    // The gap. Neither candidate round-trips because the local time never
    // existed. Take the later one, which is the first real instant past the
    // gap — 2:30am becomes 3:30am. Never the earlier one.
    result = new Date(Math.max(...candidates.map((c) => c.getTime())));
  } else if (real.length === 1) {
    result = real[0];
  } else {
    // Genuinely ambiguous — the caller's policy decides.
    const times = real.map((c) => c.getTime());
    result = new Date(
      whenAmbiguous === "later" ? Math.max(...times) : Math.min(...times)
    );
  }

  return Number.isNaN(result.getTime()) ? null : result;
}
