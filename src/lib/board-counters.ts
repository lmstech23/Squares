// The four numbers at the top of the host fundraiser panel.
//
// THE BUG THIS FIXES. All four counted squares, so a donation — which takes no
// square — moved nothing. A host could see a donor sitting at AWAITING in the
// contributor list while the AWAITING box above it read 0, and read her own
// board as broken.
//
// QUANTITY-BASED, ONE UNIT PER COUNTABLE THING. Three tickets count three; one
// donation counts one, because a donation has no quantity to have.
//
// WHY NOT ONE-PER-PURCHASE, which is the other obvious reading of "count
// contribution records": OPEN can only ever be inventory. If the other three
// counted purchases while OPEN counted tickets, a 100-ticket board with a
// single three-ticket buyer would read "Confirmed 1 / Open 97" — and 97 is not
// 100 minus 1 in any sense a host can act on. The row would be internally
// inconsistent in a way no label could rescue.
//
// NOTHING IS COUNTED TWICE. A mixed purchase — tickets with a donation added
// on top — carries `squareAmountCents > 0` and is excluded from every donation
// clause here; its squares already count it. The caller's query is what
// enforces that, so the filter is documented on `DonationRow` rather than
// re-derived below.
//
// NO DOLLARS. Every clause counts records or squares.

export interface CounterSquare {
  paymentStatus: string;
}

/**
 * A DONATION-ONLY contribution: `squareAmountCents = 0 AND
 * donationAmountCents > 0`. The caller must apply that filter — passing a
 * mixed purchase here would count it twice, once through its squares and again
 * as a donation.
 */
export interface CounterDonation {
  status: string;
  paymentMethod: string;
  voidedAt: Date | null;
}

export interface BoardCounters {
  confirmed: number;
  awaiting: number;
  inCheckout: number;
  open: number;
}

export function boardCounters(
  squares: CounterSquare[],
  donations: CounterDonation[]
): BoardCounters {
  const sq = (status: string) =>
    squares.filter((s) => s.paymentStatus === status).length;

  // A void never changes `status`, so both halves are required. Counting on
  // status alone would keep a reversed donation in CONFIRMED.
  const confirmedDonations = donations.filter(
    (d) => d.status === "confirmed" && d.voidedAt === null
  ).length;

  // A declared direct payment: the contributor said they would send it and the
  // host has not marked it received. The same thing a reserved_cash square is.
  const awaitingDonations = donations.filter(
    (d) => d.status === "pending" && d.paymentMethod === "cash"
  ).length;

  // Mid-Stripe-checkout. This is a REAL, DURABLE STATE: the ledger row is
  // written before the Checkout Session ("row first, session second"), so it
  // exists from the moment the contributor submits.
  //
  // KNOWN LIMIT, logged rather than papered over: a donation holds no
  // inventory, so `holdExpiresAt` is null (invariant 64) and no sweep touches
  // it. The only thing that releases it is checkout.session.expired. If that
  // webhook never arrives the row stays `pending` forever and stays in this
  // box forever. It never reaches `raised` — that reads confirmed only — so
  // this is a display defect, not a money one.
  const inCheckoutDonations = donations.filter(
    (d) => d.status === "pending" && d.paymentMethod === "stripe"
  ).length;

  return {
    confirmed: sq("paid") + confirmedDonations,
    awaiting: sq("reserved_cash") + awaitingDonations,
    inCheckout: sq("pending") + inCheckoutDonations,
    // INVENTORY, and only ever inventory. A donation cannot make a ticket
    // available or unavailable.
    open: sq("open"),
  };
}
