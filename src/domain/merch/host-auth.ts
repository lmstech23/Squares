// Host identity for merch routes: the signed-in Supabase user id (decision D2).
// Uses the same Supabase session as every host page; reads nothing from Boards.

import { createClient } from "@/lib/supabase/server";

export async function merchOwnerId(): Promise<string | null> {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  return data.user?.id ?? null;
}
