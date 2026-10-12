// Who is Daali's administrator? — Daali Slice 1, S1.7 (Auth spec, "Game Day
// access").
//
// Administrators are Supabase user ids listed in the server env var
// DAALI_ADMIN_USER_IDS, comma-separated. The check reads ONLY the verified
// session (supabase.auth.getUser, which asks Supabase rather than trusting the
// cookie) and that list. It never reads hosts, profiles or anything else.
//
// EVERY administrator action and endpoint calls this itself, first, inside its
// own handler. Protecting the /admin/game-day page is not enough, because a
// server endpoint can be called directly.

import { createClient } from "@/lib/supabase/server";

/** The configured administrator ids. PURE given the env value. */
export function parseAdminUserIds(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );
}

/** The signed-in administrator's user id, or null for anyone else (signed out, anonymous, or not listed). */
export async function getAdminUserId(): Promise<string | null> {
  const admins = parseAdminUserIds(process.env.DAALI_ADMIN_USER_IDS);
  if (admins.size === 0) return null;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || user.is_anonymous) return null;
  return admins.has(user.id) ? user.id : null;
}
