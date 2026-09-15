import type { DirectRail } from "./accepted-payments.ts";

// Tender — what actually arrived, recorded by the host at confirmation.
// fundraiser-payment-method-addendum.md v1.2.6 §2, §4.
//
// PURE, AND IT HAS TO BE. The picker is a client component and the four confirm
// routes are server code; both read the option list and the validation from
// here, so a method the picker cannot offer cannot be accepted either, and a
// method a route accepts is one the picker could have shown.
//
// CARD IS NOT HERE. It belongs to Stripe alone (invariant "settlement and
// tender pair only as enumerated"), so it is not in the offline list, never in
// the picker, and refused by name in parseTender - a host who takes a card on
// her own reader records OTHER with a note. The CARD seam, §2.
//
// DISPLAY AND RECONCILIATION ONLY. Nothing here reaches a dollar figure, a
// state transition, a fee, an eligibility check or a prize computation.

export const OFFLINE_TENDERS = [
  "CASH",
  "VENMO",
  "ZELLE",
  "CASHAPP",
  "PAYPAL",
  "CHECK",
  "OTHER",
] as const;

export type OfflineTender = (typeof OFFLINE_TENDERS)[number];

export const TENDER_LABEL: Record<OfflineTender, string> = {
  CASH: "Cash",
  VENMO: "Venmo",
  ZELLE: "Zelle",
  CASHAPP: "Cash App",
  PAYPAL: "PayPal",
  CHECK: "Check",
  OTHER: "Other",
};

/** The tender a contributor's declared rail would correspond to. USED FOR
 *  LABELS AND NOTHING ELSE: the picker never preselects from it, and no code
 *  derives one from the other — payment-method addendum §2. */
export const RAIL_TENDER: Record<DirectRail, OfflineTender> = {
  zelle: "ZELLE",
  cashapp: "CASHAPP",
  venmo: "VENMO",
  paypal: "PAYPAL",
};

/**
 * What the picker offers, in order: Cash, the board's configured rails, Check,
 * Other.
 *
 * THE ORDER IS DELIBERATE, NOT ALPHABETICAL. Most common first - cash is what
 * a host has in her hand at a folding table - then the rails she actually
 * configured, then the two escape hatches. Check and Other sit last because
 * reaching for them should be a decision rather than the default landing spot.
 *
 * CASH, CHECK AND OTHER ARE ALWAYS THERE. They need no handle — the host took
 * notes, a cheque, or something the enum does not name — so a board that has
 * configured nothing still has three honest answers. Only the rails in the
 * middle depend on configuration, and §4's rule is why: never offer a method
 * the host cannot receive.
 */
export function offlineTenderOptions(rails: readonly DirectRail[]): OfflineTender[] {
  const seen = new Set<OfflineTender>();
  const middle: OfflineTender[] = [];
  for (const rail of rails) {
    const tender = RAIL_TENDER[rail];
    if (tender && !seen.has(tender)) {
      seen.add(tender);
      middle.push(tender);
    }
  }
  return ["CASH", ...middle, "CHECK", "OTHER"];
}

/** Free text, at most 64 characters — contributions_tender_reference_length. */
export const TENDER_REFERENCE_MAX = 64;

/** OPTIONAL EVERYWHERE, INCLUDING FOR `OTHER`. The placeholder says what it is
 *  for; nothing makes it required. A host who cannot remember the cheque number
 *  must still be able to record the cheque. */
export function referencePlaceholder(tender: OfflineTender | null): string {
  switch (tender) {
    case "CHECK":
      return "Check number (optional)";
    case "OTHER":
      return "What it was — card on my own reader, money order (optional)";
    case null:
    case "CASH":
      return "Optional";
    default:
      return "Memo or confirmation number (optional)";
  }
}

/** What a row says when nobody recorded a tender. NEVER "Cash": most of
 *  those rows were cash and some were not, and saying Cash would assert a
 *  fact nobody recorded - §5, §9. */
export const RECORDED_BY_HOST_LABEL = "Recorded by host";

/**
 * The ledger's Method label - §5.
 *
 * A witnessed row is Card. An offline row is its tender. An offline row with
 * no tender - every row that predates this change, 14 of them on the live
 * board - reads "Recorded by host", which is what is actually known about it.
 *
 * An unrecognised value falls back the same way rather than rendering a raw
 * enum at a host who is trying to reconcile a bank statement.
 */
export function methodLabel(settlement: string, tender: string | null): string {
  if (settlement === "STRIPE") return "Card";
  if (!tender) return RECORDED_BY_HOST_LABEL;
  const known = OFFLINE_TENDERS.find((t) => t === tender);
  return known ? TENDER_LABEL[known] : RECORDED_BY_HOST_LABEL;
}

/**
 * WHAT THE LEDGER CELL SAYS ON A ROW WITH NO TENDER - §5.
 *
 * NOT `methodLabel`'S ANSWER, AND THE REASON IS NOT TASTE. "Recorded by
 * host" on a null-tender row is FALSE. Nobody recorded a method on that row;
 * that is precisely what null means. The M0 backfill refused to write CASH
 * onto those rows because it would assert a fact nobody had recorded - and
 * then the display layer asserted a different one in its place. A label is a
 * claim about the data exactly as much as a column value is.
 *
 * These two claim only what is true: there is no payment type on this row,
 * and here is whether you can supply one. They respect the same boundary the
 * route enforces - `cash.record` is what makes the cell actionable, so only a
 * viewer who holds it is invited to act. Offering the action to someone the
 * route would refuse is a worse failure than saying nothing: it spends her
 * time and then denies her.
 *
 * "PAYMENT TYPE", NOT "METHOD". `method`, `tender` and `settlement` are
 * schema words. What a host says out loud is how someone paid, and the cell
 * is read by someone reconciling a bank deposit, not by someone reading this
 * file. The column heading stays `Method` because it heads a column of values
 * like Cash and Zelle; these two are sentences addressed to a person.
 */
export const SELECT_METHOD_LABEL = "Select payment type";
export const METHOD_NOT_RECORDED_LABEL = "No payment type recorded";

export function nullTenderLabel(canCorrect: boolean): string {
  return canCorrect ? SELECT_METHOD_LABEL : METHOD_NOT_RECORDED_LABEL;
}

/**
 * The compact select's empty option - §5.
 *
 * DELIBERATELY NOT `SELECT_METHOD_LABEL`. The two sit one above the other on
 * an open row: the disclosure label is the control the host tapped, and the
 * select is what it opened. Sharing a string made the row read
 * "Select payment type / Select payment type", which looks like a rendering
 * fault rather than a control and its contents. The label keeps the sentence
 * because it is the thing she taps; the option takes a neutral verb that adds
 * no second claim.
 *
 * NOT EMPTY, EITHER. An option with no text renders as a blank row in a native
 * wheel, which reads as a nameless choice rather than as an absence.
 */
export const TENDER_PLACEHOLDER_LABEL = "Choose…";

/**
 * Whether the declared rail still adds something beside the tender - §5.
 *
 * Declared Zelle confirmed as Zelle repeats itself and is not shown. Declared
 * Zelle confirmed as Cash is the disagreement worth keeping, and a declaration
 * on a row with no tender is the only thing known about how it was meant to
 * arrive.
 */
export function declaredRailDiffers(
  rail: DirectRail | null,
  tender: string | null
): boolean {
  if (!rail) return false;
  if (!tender) return true;
  return RAIL_TENDER[rail] !== tender;
}

/** Confirmed money whose method nobody recorded - §7. NEVER "Cash": the
 *  breakdown is what a host reconciles a deposit against, and a bucket that
 *  claims to be cash when it is merely unknown is the one line that would
 *  send her looking for money that is not there. */
export const UNSPECIFIED_LABEL = "Unspecified";

/** The breakdown's row label - §7. Card for the witnessed rail, the tender
 *  label for a recorded one, Unspecified for a row with none. */
export function breakdownLabel(tender: string | null): string {
  if (!tender) return UNSPECIFIED_LABEL;
  if (tender === "CARD") return "Card";
  const known = OFFLINE_TENDERS.find((t) => t === tender);
  return known ? TENDER_LABEL[known] : UNSPECIFIED_LABEL;
}

export const TENDER_REQUIRED_ERROR = "Choose how the money arrived.";
export const TENDER_CARD_ERROR =
  "Card is not a host-recorded method. A card payment is confirmed by Stripe; record Other with a note.";
export const TENDER_UNKNOWN_ERROR = "That payment method is not recognized.";
export const TENDER_REFERENCE_TOO_LONG_ERROR = `A reference may be at most ${TENDER_REFERENCE_MAX} characters.`;

export type ParsedTender =
  | { ok: true; tender: OfflineTender; reference: string | null }
  | { ok: false; error: string };

export type ParsedReference =
  | { ok: true; reference: string | null }
  | { ok: false; error: string };

/**
 * The reference rule on its own - §6.
 *
 * A correction can change the reference WITHOUT touching the tender, so the
 * rule cannot live inside a validator that also demands one. Empty, blank and
 * absent all mean null: clearing a note is a legitimate correction.
 */
export function parseTenderReference(reference: unknown): ParsedReference {
  if (reference === undefined || reference === null || reference === "") {
    return { ok: true, reference: null };
  }
  if (typeof reference !== "string") {
    return { ok: false, error: TENDER_REFERENCE_TOO_LONG_ERROR };
  }
  const trimmed = reference.trim();
  if (!trimmed) return { ok: true, reference: null };
  if ([...trimmed].length > TENDER_REFERENCE_MAX) {
    return { ok: false, error: TENDER_REFERENCE_TOO_LONG_ERROR };
  }
  return { ok: true, reference: trimmed };
}

/**
 * The one validator every confirm route calls, on its own, before it writes.
 *
 * EACH ROUTE VALIDATES INDEPENDENTLY. The picker cannot offer CARD and cannot
 * submit nothing, but a route that trusted the picker would be one fetch away
 * from a row the ledger cannot explain.
 */
export function parseTender(tender: unknown, reference: unknown): ParsedTender {
  if (tender === undefined || tender === null || tender === "") {
    return { ok: false, error: TENDER_REQUIRED_ERROR };
  }
  if (typeof tender !== "string") return { ok: false, error: TENDER_UNKNOWN_ERROR };
  if (tender.toUpperCase() === "CARD") return { ok: false, error: TENDER_CARD_ERROR };
  const found = OFFLINE_TENDERS.find((t) => t === tender.toUpperCase());
  if (!found) return { ok: false, error: TENDER_UNKNOWN_ERROR };

  // The same rule the correction path uses, so a reference accepted at
  // confirmation is accepted at correction and vice versa.
  const ref = parseTenderReference(reference);
  if (!ref.ok) return { ok: false, error: ref.error };
  return { ok: true, tender: found, reference: ref.reference };
}
