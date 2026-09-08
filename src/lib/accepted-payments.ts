// What a fundraiser board actually offers a contributor.
//
// TWO THINGS HAVE TO BE TRUE, ALWAYS, AND IN THIS ORDER:
//
//   1. the account can perform it   Stripe charges enabled; a handle populated
//   2. the board accepts it         `acceptedPaymentMethods` lists it
//
// The board list NARROWS capability and can never widen it. Listing `card` on a
// board whose host has no live Stripe account grants nothing; listing `venmo`
// with no Venmo handle grants nothing. That property is what made the column
// safe to add to boards already taking money — the worst a wrong value can do
// is offer less than before.
//
// Every caller goes through here rather than testing `includes()` inline,
// because the two-condition rule is the whole point and one call site checking
// only membership would quietly hand a contributor a method that cannot
// complete.
//
// GAME DAY IS NOT MODELLED HERE. Its direct-payment path is a PIN-gated square
// reservation, not a rail chosen at checkout, and its array is empty by design.
// Callers gate on `boardType === "fundraiser"` before consulting any of this.

export type BoardPaymentMethod = "card" | "zelle" | "cashapp" | "venmo" | "paypal";

export const DIRECT_RAILS = ["zelle", "cashapp", "venmo", "paypal"] as const;
export type DirectRail = (typeof DIRECT_RAILS)[number];

/** Which board column holds the destination for each rail. */
export const HANDLE_FOR: Record<DirectRail, "hostZelle" | "hostCashapp" | "hostVenmo" | "hostPaypal"> =
  {
    zelle: "hostZelle",
    cashapp: "hostCashapp",
    venmo: "hostVenmo",
    paypal: "hostPaypal",
  };

export const RAIL_LABEL: Record<DirectRail, string> = {
  zelle: "Zelle",
  cashapp: "Cash App",
  venmo: "Venmo",
  paypal: "PayPal",
};

export interface PaymentCapableBoard {
  acceptedPaymentMethods: string[];
  hostZelle: string | null;
  hostCashapp: string | null;
  hostVenmo: string | null;
  hostPaypal: string | null;
}

/** The host's Stripe state, as every card route already reads it. */
export interface StripeCapableHost {
  stripeAccountId: string | null;
  stripeChargesEnabled: boolean | null;
}

/**
 * Can this board take a card right now?
 *
 * BOTH CONDITIONS. A live Stripe account is what makes it possible; the board
 * list is what makes it intended. Before this column existed only the first was
 * checked, so connecting Stripe for any reason turned card on for every
 * fundraiser the host owned, with no board-level decision able to prevent it.
 */
export function acceptsCard(board: PaymentCapableBoard, host: StripeCapableHost): boolean {
  return cardCapable(host) && board.acceptedPaymentMethods.includes("card");
}

/**
 * CAPABILITY ONLY — can this host take a card at all, on any board?
 *
 * Exported so the edit panel can disable the card control without restating
 * `Boolean(stripeAccountId && stripeChargesEnabled)`, which is the line that
 * would drift. It is deliberately NOT enough on its own: a host being capable
 * is what makes card possible, and the board listing it is what makes it
 * intended. Deriving one from the other is how a direct-payment fundraiser came
 * to serve a live Stripe checkout.
 */
export function cardCapable(host: StripeCapableHost): boolean {
  return Boolean(host.stripeAccountId && host.stripeChargesEnabled);
}

/**
 * The direct-payment rails a contributor may actually choose.
 *
 * A rail needs BOTH its handle and its listing. A handle with no listing is a
 * destination the host has stored but paused — which was impossible to express
 * before, because populating a handle WAS the offer.
 */
export function acceptedRails(board: PaymentCapableBoard): DirectRail[] {
  return DIRECT_RAILS.filter(
    (rail) => board.acceptedPaymentMethods.includes(rail) && board[HANDLE_FOR[rail]]
  );
}

/** The handles to show, already narrowed. Absent rails are absent, not blank. */
export function acceptedHandles(board: PaymentCapableBoard): {
  zelle: string | null;
  cashapp: string | null;
  venmo: string | null;
  paypal: string | null;
} {
  const live = new Set(acceptedRails(board));
  return {
    zelle: live.has("zelle") ? board.hostZelle : null,
    cashapp: live.has("cashapp") ? board.hostCashapp : null,
    venmo: live.has("venmo") ? board.hostVenmo : null,
    paypal: live.has("paypal") ? board.hostPaypal : null,
  };
}

/** Is any direct-payment rail usable at all? */
export function acceptsAnyDirect(board: PaymentCapableBoard): boolean {
  return acceptedRails(board).length > 0;
}

/** Everything a fundraiser board can list. Order is the order hosts see. */
export const BOARD_PAYMENT_METHODS = ["card", ...DIRECT_RAILS] as const;

export const METHOD_LABEL: Record<BoardPaymentMethod, string> = {
  card: "Card",
  ...RAIL_LABEL,
};

/**
 * Clean an incoming selection into a stored value, or null if it is not a list
 * of known methods.
 *
 * Deduped and put in `BOARD_PAYMENT_METHODS` order rather than the order the
 * client happened to send, so two saves of the same selection produce the same
 * column and a diff of this board against another is readable.
 *
 * An EMPTY array is valid input here and is rejected later, by the offerable
 * rule, which gives a better sentence than "not a known method".
 */
export function normalizeAcceptedMethods(input: unknown): BoardPaymentMethod[] | null {
  if (!Array.isArray(input)) return null;
  const seen = new Set<string>();
  for (const v of input) {
    if (typeof v !== "string") return null;
    if (!(BOARD_PAYMENT_METHODS as readonly string[]).includes(v)) return null;
    seen.add(v);
  }
  return BOARD_PAYMENT_METHODS.filter((m) => seen.has(m));
}

/**
 * THE SAVE RULE: at least one method must be OFFERABLE after the write.
 *
 * SELECTED AND OFFERABLE ARE DIFFERENT, and the difference is the whole reason
 * this function exists rather than a length check on the array. A board with
 * Venmo ticked and no Venmo handle has a selected method and can take no money.
 *
 *   Zelle offerable, Venmo ticked with no handle   saves. Venmo is not live yet.
 *   only Venmo ticked, no handle                   refused. Nothing can be paid.
 *
 * That preserves ticking a rail now and pasting the handle later, while making
 * a board that looks configured and cannot collect unreachable. Only a board
 * with NO offerable method at all is refused.
 *
 * Built from `acceptedRails` and `acceptsCard`, so it cannot drift from what
 * the contributor is actually shown: the same two predicates decide both.
 */
export function hasOfferableMethod(
  board: PaymentCapableBoard,
  host: StripeCapableHost
): boolean {
  return acceptedRails(board).length > 0 || acceptsCard(board, host);
}

/**
 * Per-row status for the edit panel: is this method selected, can it be
 * offered, and if not, what is missing?
 *
 * The panel renders from this rather than deciding for itself, for the reason
 * every other narrowing decision is centralised — a screen that computes its
 * own idea of "available" is how a contributor gets offered a method that
 * cannot complete.
 */
export interface MethodStatus {
  method: BoardPaymentMethod;
  label: string;
  selected: boolean;
  /** Selected AND able to complete. This is what a contributor would see. */
  offerable: boolean;
  /** True when the host cannot fix the blocker from this form. Card only. */
  blocked: boolean;
  /** What is still required, or null when nothing is. */
  requirement: string | null;
}

/**
 * `cardEligible`, NOT the host row. This runs in the edit panel as the host
 * types, so it has to be callable from a client component - and a Stripe
 * account id has no business being serialised to one. The server computes the
 * single boolean with `acceptsCard`'s own capability test and passes that.
 */
export function methodStatuses(
  board: PaymentCapableBoard,
  cardEligible: boolean
): MethodStatus[] {
  const selected = new Set(board.acceptedPaymentMethods);
  const stripeLive = cardEligible;
  const live = new Set<string>(acceptedRails(board));

  return BOARD_PAYMENT_METHODS.map((method) => {
    if (method === "card") {
      return {
        method,
        label: METHOD_LABEL.card,
        selected: selected.has("card"),
        offerable: stripeLive && selected.has("card"),
        // THE ONE BLOCKER A HOST CANNOT CLEAR HERE. Stripe is connected on the
        // host, not on this form, so card is disabled with its reason rather
        // than tickable-and-inert. A checkbox that saves and does nothing is a
        // promise nobody can keep.
        blocked: !stripeLive,
        requirement: stripeLive ? null : "Connect Stripe to accept cards.",
      };
    }
    const rail = method as DirectRail;
    const hasHandle = Boolean(board[HANDLE_FOR[rail]]);
    return {
      method,
      label: METHOD_LABEL[rail],
      selected: selected.has(rail),
      offerable: live.has(rail),
      // Never blocked: the handle is a field on this same form, so the host can
      // tick it now and fill it in before saving, or after.
      blocked: false,
      requirement: hasHandle ? null : `Add your ${METHOD_LABEL[rail]} details to start accepting it.`,
    };
  });
}
