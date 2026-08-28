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
 * Converts "YYYY-MM-DDTHH:mm" from a `datetime-local` input into a UTC instant,
 * interpreting the wall clock in `timeZone`.
 *
 * Returns null for missing, malformed, or unparseable input, and for an
 * invalid IANA zone, so callers can write their own error copy.
 *
 * Ambiguous and skipped local times (the DST fall-back hour and the spring
 * gap) resolve to a single defensible instant rather than throwing — see the
 * tests for exactly which.
 */
export function parseZoned(
  value: string | null | undefined,
  timeZone: string
): Date | null {
  if (!value) return null;

  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
  if (!m) return null;

  const [year, month, day, hour, minute] = m.slice(1).map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) {
    return null;
  }

  // Treat the wall clock as if it were UTC, then subtract the zone's offset.
  const guess = Date.UTC(year, month - 1, day, hour, minute);

  let offset: number;
  try {
    offset = tzOffsetMs(new Date(guess), timeZone);
  } catch {
    return null; // invalid IANA zone
  }

  const first = new Date(guess - offset);

  // One correction pass. Near a DST boundary the offset at the guessed instant
  // can differ from the offset at the real one — without this, a date entered
  // in November using the summer offset lands an hour off.
  const corrected = tzOffsetMs(first, timeZone);
  const second = corrected === offset ? first : new Date(guess - corrected);

  // Verify the correction actually round-trips to the wall clock the host
  // typed. It won't for a time inside the spring-forward gap, which never
  // existed locally: there the correction overshoots backwards and 2:30am
  // would resolve to 1:30am — an hour EARLIER than they asked for. Falling
  // back to the uncorrected instant shifts forward out of the gap instead
  // (2:30am becomes 3:30am), which is the conventional reading and never
  // resolves a deadline earlier than the host intended.
  const roundTrip = second.getTime() + tzOffsetMs(second, timeZone);
  const result = roundTrip === guess ? second : first;

  return Number.isNaN(result.getTime()) ? null : result;
}
