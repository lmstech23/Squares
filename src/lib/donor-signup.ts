// Can this donor be handed a volunteer sign-up link, and if so which one.
//
// ONE DECISION, TWO CHANNELS. A card donor is offered the link on the
// confirmation screen; a direct-payment donor gets it in the confirmation email
// after the host marks the payment received. Those are different moments and
// different code paths, and they must not disagree about who is eligible —
// which is the whole reason this lives in one function instead of twice.
//
// WHY A DONOR NEEDS THIS AT ALL. Interest used to live only on AdmissionGrant,
// and a donation creates none, so neither channel had anything to key on. The
// eligibility gate was never the problem: mayClaim() reads supporter status
// alone, and a confirmed donation already activates the supporter. What was
// missing was the link.
//
// ENTITLEMENT IS UNTOUCHED. Nothing here creates an AdmissionGrant, an
// AdmissionPass, or any admission of any kind. It reads a supporter that
// activation already created and mints a sign-up token against it.

import { prisma } from "./prisma.ts";
import { normalizeEmail } from "./roster-identity.ts";
import { issueSupporterAccessLink, mayClaim } from "./signups.ts";

export type DonorSignup =
  /** A usable link. `path` is app-relative. */
  | { kind: "link"; path: string }
  /** Eligible, but the host has closed the sheet. Say so; do not link. */
  | { kind: "closed" }
  /** Not offered: no event, no sheet, not interested, or not yet active. */
  | { kind: "none" };

/**
 * `eventId` null means the board has no event, which is most of the reasons
 * this returns `none`.
 *
 * ORDER MATTERS. Interest is checked before anything is looked up, so a donor
 * who never ticked the box costs one boolean rather than three queries — and,
 * more importantly, a token is never minted for someone who did not ask.
 */
export async function donorSignup(
  eventId: string | null | undefined,
  email: string | null | undefined,
  wantsToHelp: boolean
): Promise<DonorSignup> {
  if (!wantsToHelp || !eventId || !email) return { kind: "none" };

  const sheet = await prisma.signupSheet.findFirst({
    where: { eventId },
    select: { isOpen: true },
  });
  // No sheet is not "closed" — there is nothing to close. Nothing is promised.
  if (!sheet) return { kind: "none" };

  const supporter = await prisma.eventSupporter.findUnique({
    where: {
      eventId_emailKey: { eventId, emailKey: normalizeEmail(email) ?? "" },
    },
    select: { id: true, status: true },
  });
  // PENDING IS THE NORMAL CASE ON THE DECLARATION SCREEN, not an error: a
  // direct payment does not activate anyone until the host confirms it. The
  // caller is expected to explain the timing rather than show a dead control.
  if (!supporter || !mayClaim(supporter.status)) return { kind: "none" };

  if (sheet.isOpen === false) return { kind: "closed" };

  const issued = await issueSupporterAccessLink(supporter.id);
  return { kind: "link", path: `/signup/${issued.token}` };
}
