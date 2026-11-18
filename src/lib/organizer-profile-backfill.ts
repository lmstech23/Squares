// Which organizer_profiles rows the one-off backfill would create — Daali
// Slice 1, S1.1, with Game Day access from S1.7.
//
// PURE. No database, no environment, no clock. The script in
// scripts/backfill-organizer-profiles.mts reads auth.users, hosts, Game Day
// owners and existing profiles, hands them here, and decides separately
// whether to print or write the result. Every rule about WHO gets a profile and
// WHAT it says lives in this file, so the unit tests can pin each one down
// without a database.
//
// The rules (Auth spec, "Backfill for existing users", amended Oct 11):
//   - one BACKFILL row per auth user who is NOT anonymous and has no row yet;
//   - display_name copied from that user's hosts.name, when the host exists
//     and the name is not blank (trimmed); otherwise null;
//   - legacy_boards_enabled true for every account whose Host owns at least
//     one Game Day board, false for everyone else;
//   - INSERT-ONLY. A user who already has a row is never planned, so a rerun
//     can neither restore Game Day access an administrator removed nor clear
//     access an access link granted. A Game Day owner who already has a row
//     WITHOUT the flag is only counted, for the administrator to resolve with
//     an access link.

export type AuthUserRow = {
  id: string;
  email: string | null;
  isAnonymous: boolean;
};

export type HostNameRow = {
  supabaseUserId: string | null;
  name: string | null;
};

export type ExistingProfileRow = {
  userId: string;
  legacyBoardsEnabled: boolean;
};

export type PlannedProfile = {
  userId: string;
  displayName: string | null;
  legacyBoardsEnabled: boolean;
  createdVia: "BACKFILL";
};

export type PlanInput = {
  users: AuthUserRow[];
  hosts: HostNameRow[];
  /** Supabase user ids whose Host owns at least one Game Day board. */
  gameDayOwnerUserIds: Iterable<string>;
  /** Every organizer_profiles row that already exists. */
  existingProfiles?: Iterable<ExistingProfileRow>;
};

export type BackfillPlan = {
  /** Rows to insert. Never a row for a user who already has one. */
  create: PlannedProfile[];
  /** Game Day owners who already have a row without the flag. Reported, never changed. */
  ownersWithRowWithoutFlag: string[];
};

export function planOrganizerProfiles(input: PlanInput): BackfillPlan {
  const nameByUser = new Map<string, string>();
  for (const h of input.hosts) {
    const name = h.name?.trim();
    if (h.supabaseUserId && name) nameByUser.set(h.supabaseUserId, name);
  }
  const owners = new Set(input.gameDayOwnerUserIds);
  const existing = new Map<string, ExistingProfileRow>();
  for (const p of input.existingProfiles ?? []) existing.set(p.userId, p);

  const create: PlannedProfile[] = [];
  const ownersWithRowWithoutFlag: string[] = [];
  for (const u of input.users) {
    if (u.isAnonymous) continue;
    const row = existing.get(u.id);
    if (row) {
      if (owners.has(u.id) && !row.legacyBoardsEnabled) ownersWithRowWithoutFlag.push(u.id);
      continue;
    }
    create.push({
      userId: u.id,
      displayName: nameByUser.get(u.id) ?? null,
      legacyBoardsEnabled: owners.has(u.id),
      createdVia: "BACKFILL",
    });
  }
  return { create, ownersWithRowWithoutFlag };
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
