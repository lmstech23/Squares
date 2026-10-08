// Which organizer_profiles rows the one-off backfill would create — Daali
// Slice 1, S1.1.
//
// PURE. No database, no environment, no clock. The script in
// scripts/backfill-organizer-profiles.mts reads auth.users and hosts, hands the
// rows here, and decides separately whether to print or write the result. Every
// rule about WHO gets a profile and WHAT it says lives in this file, so the unit
// tests can pin each one down without a database.
//
// The rules:
//   - one BACKFILL row per auth user who is NOT anonymous;
//   - display_name copied from that user's hosts.name, when the host exists
//     and the name is not blank (trimmed); otherwise null;
//   - legacy_boards_visible true ONLY for the single email passed as the legacy
//     tester (compared trimmed and case-insensitively), false for everyone else;
//   - a user who already has a profile is skipped, so a second run plans nothing.

export type AuthUserRow = {
  id: string;
  email: string | null;
  isAnonymous: boolean;
};

export type HostNameRow = {
  supabaseUserId: string | null;
  name: string | null;
};

export type PlannedProfile = {
  userId: string;
  displayName: string | null;
  legacyBoardsVisible: boolean;
  createdVia: "BACKFILL";
};

export type PlanOptions = {
  /** The one email whose profile shows legacy Boards. Unset means nobody's. */
  legacyTesterEmail?: string | null;
  /** User ids that already have a profile. */
  existingUserIds?: Iterable<string>;
};

const normalizeEmail = (email: string | null | undefined): string | null => {
  const e = email?.trim().toLowerCase();
  return e ? e : null;
};

export function planOrganizerProfiles(
  users: AuthUserRow[],
  hosts: HostNameRow[],
  options: PlanOptions = {}
): PlannedProfile[] {
  const nameByUser = new Map<string, string>();
  for (const h of hosts) {
    const name = h.name?.trim();
    if (h.supabaseUserId && name) nameByUser.set(h.supabaseUserId, name);
  }
  const existing = new Set(options.existingUserIds ?? []);
  const tester = normalizeEmail(options.legacyTesterEmail);

  const planned: PlannedProfile[] = [];
  for (const u of users) {
    if (u.isAnonymous) continue;
    if (existing.has(u.id)) continue;
    const email = normalizeEmail(u.email);
    planned.push({
      userId: u.id,
      displayName: nameByUser.get(u.id) ?? null,
      legacyBoardsVisible: tester !== null && email === tester,
      createdVia: "BACKFILL",
    });
  }
  return planned;
}

/**
 * An email safe to print in a report: first character of the local part and of
 * the domain, the rest starred, the top-level domain kept.
 *   "sarah.jones@example.com" -> "s**********@e******.com"
 */
export function maskEmail(email: string | null | undefined): string {
  if (!email) return "(no email)";
  const at = email.lastIndexOf("@");
  if (at <= 0) return "*".repeat(Math.max(email.length, 1));
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const dot = domain.lastIndexOf(".");
  const host = dot > 0 ? domain.slice(0, dot) : domain;
  const tld = dot > 0 ? domain.slice(dot) : "";
  const star = (s: string) => (s.length ? s[0] + "*".repeat(s.length - 1) : "");
  return `${star(local)}@${star(host)}${tld}`;
}
