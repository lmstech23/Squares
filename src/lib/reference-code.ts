// The reservation reference code — v2 §20.2, invariant 114's reconciliation half.
//
// A contributor is told to put five characters in a Zelle or Venmo memo. The
// host reads that memo off a bank statement and finds the reservation.
//
// RECONCILIATION METADATA. It authorises NOTHING. No route resolves a
// reservation by code for any state change, the gate never accepts it, and it
// is safe to print on a screen, in an email and in a bank memo precisely
// because holding it grants nothing. Search is the only thing it does.
//
// CROCKFORD BASE32, AND BOTH HALVES OF IT. The alphabet is the half most
// people implement: 32 symbols with I, L, O and U removed, so a generated code
// contains no glyph anyone will misread. The other half is DECODING - Crockford
// maps I and L onto 1 and O onto 0 - and it exists because the person reading
// the code is squinting at a bank statement and will type what they think they
// see. Generating an unambiguous alphabet and then matching the stored string
// literally takes the constraint and skips the payoff.
//
// The mapping is safe in exactly one direction, which is why it is safe at all:
// `generate` NEVER emits I, L, O or U, so any of those in a typed query is
// unambiguously a misread of 1, 1 or 0. Nothing is lost and nothing is guessed.
// U is excluded from the alphabet (it makes an unfortunate word more likely)
// but has no digit it could be confused with, so it maps to nothing.

import { randomInt } from "crypto";

/** 32 symbols. No I, L, O or U. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Five characters: 32^5 = 33,554,432 values, and short enough to type. */
export const CODE_LENGTH = 5;

/**
 * A new reference code.
 *
 * `randomInt` rather than `Math.random`: the code is not a credential, but a
 * predictable one would let a stranger guess at another contributor's
 * reservation in a host's search box, and there is no reason to accept that
 * when the unbiased primitive is free.
 *
 * UNIQUENESS IS THE CALLER'S, not this function's. Codes are unique per BOARD -
 * that is the scope a host searches in, and it keeps five characters
 * sufficient. `entry_reservations_board_code_key` is the enforcement; callers
 * retry on collision the same way board slugs do.
 */
export function generateReferenceCode(): string {
  let out = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += ALPHABET[randomInt(ALPHABET.length)];
  }
  return out;
}

/**
 * What a host typed, turned into what to match against.
 *
 * SEARCH ONLY. This never resolves a reservation for a state change; it makes
 * a search box forgiving about the four characters a human eye confuses.
 *
 *   whitespace, hyphens   removed - people group codes as "H8-2K4"
 *   lower case            uppercased
 *   I, L                  -> 1
 *   O                     -> 0
 *
 * Returns "" for input with nothing usable in it, so a caller can treat empty
 * as "no code filter" rather than as a query matching everything.
 */
export function normalizeReferenceCode(input: string | null | undefined): string {
  if (!input) return "";
  return input
    .replace(/[\s-]/g, "")
    .toUpperCase()
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0");
}

/**
 * Could this be a reference code at all?
 *
 * DECIDES WHETHER TO RUN AN EXTRA LOOKUP. NEVER WHICH LOOKUP TO RUN.
 *
 * It is tempting to read this as "is the host searching for a code or for a
 * person", and that reading is wrong in a way that hides real reservations. The
 * normaliser folds letters onto digits, so any five-character name built from
 * the allowed glyphs comes out code-shaped: `Holly` normalises to `H011Y` and
 * `Molly` to `M011Y`. Branching on this would send a host looking for Holly
 * into a code lookup that finds nothing and never search the names at all.
 *
 * Checked AFTER normalising, because "h8-2k4" is a perfectly good code typed by
 * a person. See `reservationSearchTerms`, which is the shape callers should
 * use.
 */
export function looksLikeReferenceCode(input: string | null | undefined): boolean {
  const n = normalizeReferenceCode(input);
  return n.length === CODE_LENGTH && !/[^0-9A-HJKMNP-TVWXYZ]/.test(n);
}

/**
 * What one search box turns into: always a text match, sometimes also a code.
 *
 * THE UNION IS THE POINT. `text` is the RAW input and is always searched
 * against name and email. `code` is set only when the normalised value could be
 * a reference code, and adds a second lookup whose results are merged in. A
 * host typing `Holly` gets the contributor named Holly; a host typing `H011Y`
 * gets the reservation with that code AND anyone whose name matches that
 * string. Neither suppresses the other.
 *
 * Callers must OR these and de-duplicate by reservation id. Nothing here
 * chooses between them, because there is no correct way to choose.
 */
export function reservationSearchTerms(input: string | null | undefined): {
  text: string;
  code: string | null;
} {
  const text = (input ?? "").trim();
  return {
    text,
    // Raw input drives the text match; only the code lookup sees the
    // normalised form, so folding letters onto digits can never reach a name.
    code: looksLikeReferenceCode(text) ? normalizeReferenceCode(text) : null,
  };
}
