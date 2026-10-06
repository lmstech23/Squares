/**
 * The single normalizer. Every path that creates an EventPerson calls this, so
 * RSVP and volunteer-claim can never disagree about whether
 * "Sarah@Example.com " and "sarah@example.com" are the same parent.
 */
export function resolveIdentityKey(email: string): string {
  return email.trim().toLowerCase()
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function isPlausibleEmail(email: string): boolean {
  const v = email.trim()
  return v.length > 0 && v.length <= 254 && EMAIL.test(v)
}
