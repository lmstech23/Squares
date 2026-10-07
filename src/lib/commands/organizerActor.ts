import { currentOrganizer } from '@/lib/currentOrganizer'
import type { ActorContext } from '@/lib/commands/types'

/**
 * The two functions the 0A route handlers were written against, built on the
 * Sep 10 currentOrganizer() (D2). The 0A stub defined them and threw until wired;
 * this is that wiring, and nothing more:
 *
 *   currentOrganizerUserId()  the session user id, or null when signed out
 *   humanOrganizerActor()     { kind: 'HUMAN', userId } for that user, or null
 *
 * Identity comes from the Supabase session only, through currentOrganizer()
 * (Rule E1). Kept out of currentOrganizer.ts so that file stays the Sep 10
 * version unchanged.
 */
export async function currentOrganizerUserId(): Promise<string | null> {
  const organizer = await currentOrganizer()
  return organizer ? organizer.userId : null
}

export async function humanOrganizerActor(): Promise<ActorContext | null> {
  const userId = await currentOrganizerUserId()
  if (!userId) return null
  return { kind: 'HUMAN', userId }
}
