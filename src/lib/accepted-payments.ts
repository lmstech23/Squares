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
  const capable = Boolean(host.stripeAccountId && host.stripeChargesEnabled);
  return capable && board.acceptedPaymentMethods.includes("card");
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
