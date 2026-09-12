// The Donate Only amount picker's presets and its first-open rule.
//
// PURE, AND THAT IS THE POINT. It imports nothing — no Prisma, no Board module —
// so the donate sheet, a client component, can import it directly
// (docs/public-theme-spec.md §5, §6 amendment of September 12, 2026). It used
// to live in contributions.ts, which imports the Prisma client; that module now
// re-exports these so every existing importer is unchanged.

/** Presets offered by the amount picker — donations §6. `Other` is a peer. */
export const DONATION_PRESETS_CENTS = [1000, 2500, 5000, 10000];

/** What the Donate Only picker selects on first open — public-theme spec §5.
 *
 *  The board's configured default when it is one of the presets, otherwise
 *  $25 — today's behaviour, and what every board gets while
 *  `donation_default_cents` is null. It never preselects Other: a configured
 *  value that is not a preset falls back rather than opening a free-text box. */
export function initialDonationCents(configured: number | null | undefined): number {
  return configured != null && DONATION_PRESETS_CENTS.includes(configured) ? configured : 2500;
}
