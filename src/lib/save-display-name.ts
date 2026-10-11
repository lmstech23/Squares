"use server";

// Saving "What should we call you?" — Daali Slice 1, S1.5 (Auth spec, Screen 3).
//
// Saved to organizer_profiles.display_name on submit, before the phone step,
// so it survives if the person stops there. Required, 1 to 60 characters,
// trimmed. It updates that one column of the signed-in user's own row and
// nothing else: no Host, no Board, no other table.

import { createClient } from "@/lib/supabase/server";
import { prisma } from "@/lib/prisma";
import { checkDisplayName } from "@/lib/setup-steps";

export type SaveNameResult = { ok: true } | { ok: false; reason: "invalid" | "signed-out" | "no-profile" };

export async function saveDisplayName(raw: string): Promise<SaveNameResult> {
  const checked = checkDisplayName(raw);
  if (!checked.ok) return { ok: false, reason: "invalid" };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || user.is_anonymous) return { ok: false, reason: "signed-out" };

  const { count } = await prisma.organizerProfile.updateMany({
    where: { userId: user.id },
    data: { displayName: checked.name },
  });
  return count === 1 ? { ok: true } : { ok: false, reason: "no-profile" };
}
