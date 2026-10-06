/**
 * ⚠️ THE ONE INTEGRATION POINT.
 *
 * 0A does not invent auth. Wire this to the session helper the app already uses
 * for host OTP (Supabase), and nothing else in 0A needs to know how auth works.
 *
 * Return the stable organizer user id, or null when signed out.
 */
export async function currentOrganizerUserId(): Promise<string | null> {
  // TODO(0A): replace with the existing Supabase session lookup, e.g.
  //
  //   import { createServerClient } from '@/lib/supabase/server'
  //   const supabase = createServerClient()
  //   const { data } = await supabase.auth.getUser()
  //   return data.user?.id ?? null
  //
  throw new Error('currentOrganizerUserId() is not wired. See src/lib/currentOrganizer.ts')
}

import type { ActorContext } from '@/lib/commands/types'

export async function humanOrganizerActor(): Promise<ActorContext | null> {
  const userId = await currentOrganizerUserId()
  if (!userId) return null
  return { kind: 'HUMAN', userId }
}
