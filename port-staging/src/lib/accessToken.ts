import { createHash, createHmac, timingSafeEqual } from 'crypto'
import type { Prisma } from '@prisma/client'

/**
 * Account-free access for participants.
 *
 * DEVIATION FROM THE SPEC, and the reason for it. The addendum's
 * `getOrCreateSupporterAccessToken()` had to "return the existing live token when
 * there is one" — but if only `tokenHash` is stored, the plaintext is gone and
 * that is impossible. The old design implied storing the token itself, which puts
 * every live magic link in the database in readable form.
 *
 * Deriving the token instead gives idempotent issuance AND no secret at rest:
 *
 *     token = HMAC(ACCESS_TOKEN_SECRET, `${eventPersonId}:${version}`)
 *
 * Reissue is pure derivation, so two callers milliseconds apart cannot produce
 * competing links — the property the addendum actually wanted. Revocation bumps
 * `version`, which invalidates the old link without deleting history.
 */

function secret(): string {
  const s = process.env.ACCESS_TOKEN_SECRET
  if (!s || s.length < 32) {
    throw new Error('ACCESS_TOKEN_SECRET must be set to at least 32 characters.')
  }
  return s
}

export function deriveToken(eventPersonId: string, version: number): string {
  return createHmac('sha256', secret())
    .update(`${eventPersonId}:${version}`)
    .digest('base64url')
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function tokensMatch(a: string, b: string): boolean {
  const ba = Buffer.from(a), bb = Buffer.from(b)
  return ba.length === bb.length && timingSafeEqual(ba, bb)
}

/** The single idempotent issuer. Runs inside the caller's transaction. */
export async function getOrCreateAccessToken(
  tx: Prisma.TransactionClient,
  eventPersonId: string,
): Promise<string> {
  const existing = await tx.eventPersonAccessToken.findUnique({ where: { eventPersonId } })

  if (existing && !existing.revokedAt) return deriveToken(eventPersonId, existing.version)

  const version = existing ? existing.version + 1 : 1
  const token = deriveToken(eventPersonId, version)

  await tx.eventPersonAccessToken.upsert({
    where: { eventPersonId },
    create: { eventPersonId, version, tokenHash: hashToken(token) },
    update: { version, tokenHash: hashToken(token), revokedAt: null },
  })

  return token
}

export async function revokeAccessToken(
  tx: Prisma.TransactionClient,
  eventPersonId: string,
): Promise<void> {
  await tx.eventPersonAccessToken.update({
    where: { eventPersonId },
    data: { revokedAt: new Date() },
  })
}
