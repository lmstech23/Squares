// Resolving a direct-payment Entry Ticket reservation — v2 §20.2, invariant 114.
//
// The host says the money arrived, or that it did not. Everything downstream of
// a reservation happens here and nowhere else.
//
// CONFIRM IS WHERE THE MONEY BECOMES REAL. Until it runs there is no
// Contribution, no supporter, no grant and no pass — a reservation is a
// statement of intent about a rail Daali cannot see. `raised` cannot see it
// either, which is correct and is why the close guard reads the reservation
// table rather than pending contributions.

import type { Prisma } from "@prisma/client";
import type { EntryPrice, EntryTier, EntryPriceBasis } from "./entry-pricing.ts";
import { confirmEntryPurchase } from "./entry-purchase.ts";

export interface ReservationLine {
  tier: EntryTier;
  priceBasis: EntryPriceBasis;
  unitPriceCents: number;
  quantity: number;
}

/**
 * THE EXPANSION SEAM. Grouped tier lines back into one entry PER PASS.
 *
 * A reservation stores `2 × ADULT @ 4000` because a host confirms "two adults
 * arrived". `confirmEntryPurchase` needs `[ADULT@4000, ADULT@4000]` because
 * every AdmissionPass carries its own price, and it ASSERTS that those prices
 * sum to the contribution amount.
 *
 * So this function is the join between two representations of the same money,
 * and both failure modes are silent:
 *
 *   wrong COUNT  mints too few or too many passes, and the sum assertion
 *                fires on a purchase that was perfectly correct
 *   wrong PRICE  re-quoting at today's rate instead of the price stored at
 *                reservation, which passes the assertion only if the
 *                contribution amount was computed the same wrong way — so the
 *                two agree with each other and disagree with what was reserved
 *
 * It reads `unitPriceCents` and NOTHING ELSE. There is no board, no clock and
 * no pricing function in scope here, deliberately: the price was fixed at
 * reservation and this cannot reach anything that would let it be re-derived.
 */
export function expandReservationLines(lines: ReservationLine[]): EntryPrice[] {
  const passes: EntryPrice[] = [];
  for (const line of lines) {
    for (let i = 0; i < line.quantity; i++) {
      passes.push({
        tier: line.tier,
        priceBasis: line.priceBasis,
        pricePaidCents: line.unitPriceCents,
      });
    }
  }
  return passes;
}

/** What the reservation is worth, from the STORED prices. Never re-quoted. */
export function reservationTotalCents(lines: ReservationLine[]): number {
  return lines.reduce((sum, l) => sum + l.unitPriceCents * l.quantity, 0);
}

export class ReservationNotPending extends Error {
  constructor() {
    super("This reservation has already been resolved.");
    this.name = "ReservationNotPending";
  }
}

/**
 * The host received the money. Create the ledger row, mint the passes, close
 * the reservation.
 *
 * ONE TRANSACTION, and the caller's. Money and passes commit together or not at
 * all — the same rule the card path follows, for the same reason.
 *
 * WHOLE RESERVATION, not per line. The schema can express a partly-paid
 * reservation and its CHECK enforces the bounds, but the host surface does not
 * offer it: confirm means every line. The capability is kept because partial
 * payment is a real thing that will need a surface, and retrofitting the column
 * later would mean migrating rows that had already lost the distinction.
 *
 * `postCloseAt` is stamped when the board has already sealed its final total —
 * Ruling 5. The money is recorded and the passes are minted regardless: never
 * reject money a host has already been handed. What must not happen is
 * `finalRaisedCents` moving under contributors who have already read it, so the
 * amount is marked as sitting outside the published figure instead.
 */
export async function confirmEntryReservation(
  tx: Prisma.TransactionClient,
  input: { reservationId: string; hostId: string }
): Promise<{
  contributionId: string;
  passesMinted: number;
  postClose: boolean;
  ticketCents: number;
  donationCents: number;
}> {
  // Conditional read plus a conditional update below: two hosts double-clicking
  // Confirm must produce one contribution, not two.
  const reservation = await tx.entryReservation.findUnique({
    where: { id: input.reservationId },
    select: {
      id: true,
      status: true,
      boardId: true,
      eventId: true,
      contributorName: true,
      contributorEmail: true,
      contributorPhone: true,
      donationAmountCents: true,
      wantsToHelp: true,
      lines: {
        select: { id: true, tier: true, priceBasis: true, unitPriceCents: true, quantity: true },
      },
      board: { select: { status: true, finalRaisedCents: true } },
    },
  });

  if (!reservation || reservation.status !== "pending") {
    throw new ReservationNotPending();
  }

  // BINARY CONFIRMATION IS THE INTERFACE, NOT THE MODEL.
  //
  // This release confirms or releases a WHOLE reservation, and the donation
  // travels atomically with it. That is a pilot UI decision, not a limit of the
  // schema: `quantityConfirmed` and its range CHECK exist precisely so a line
  // can be partly confirmed, and line-level confirmation can be built on top of
  // what is already here without a migration.
  //
  // DO NOT READ THE DONATION AS EVIDENCE OTHERWISE. It is a single amount, not
  // a tier line - no tier, no price basis, no quantity - so `quantityConfirmed`
  // has nothing to say about it and there is no line to partially confirm. A
  // parent reserving $95 of tickets plus a $25 donation sends $120 against one
  // reference code, and the host confirms one payment. Whoever builds
  // line-level confirmation later confirms LINES; the donation stays whole.
  const lines: ReservationLine[] = reservation.lines.map((l) => ({
    tier: l.tier as EntryTier,
    priceBasis: l.priceBasis as EntryPriceBasis,
    unitPriceCents: l.unitPriceCents,
    quantity: l.quantity,
  }));

  // TICKET MONEY AND DONATION MONEY STAY SEPARATE ALL THE WAY DOWN. They land
  // in different columns of one Contribution, which is what keeps donation
  // money out of the prize basis structurally rather than by a filter.
  const ticketCents = reservationTotalCents(lines);
  // THE COUNT THIS CONFIRMATION IS ABOUT TO WRITE, which is why it reads
  // `quantity` rather than `quantityConfirmed`: the loop below sets
  // `quantityConfirmed = line.quantity` for every line, and until it runs the
  // stored value is still 0. Reading the column here would record a purchase
  // of nothing.
  //
  // Confirm means EVERY line on this release, so the two are the same number.
  // When partial confirmation gets a surface this has to follow what was
  // actually confirmed - and it is one expression, in one place, to change.
  const ticketCount = reservation.lines.reduce((n, l) => n + l.quantity, 0);
  const donationCents = reservation.donationAmountCents;
  const passes = expandReservationLines(lines);

  // The board sealed before the host got round to confirming. Record it, mark
  // it, do not touch the sealed number.
  const postClose =
    reservation.board.status === "closed" && reservation.board.finalRaisedCents != null;

  const contribution = await tx.contribution.create({
    data: {
      boardId: reservation.boardId,
      status: "confirmed",
      paymentMethod: "cash",
      squareAmountCents: 0,
      donationAmountCents: donationCents,
      entryAmountCents: ticketCents,
      // The durable purchase quantity, carried across from the reservation
      // lines. Everything downstream of this row - the roster included - reads
      // it rather than counting passes, so voiding a pass later cannot reduce
      // a purchase that already happened.
      entryTicketCount: ticketCount > 0 ? ticketCount : null,
      // The three-term CHECK sums these. The donation reaches `raised` and
      // never the prize basis, because it is in a different column.
      totalPaidCents: ticketCents + donationCents,
      contributorName: reservation.contributorName,
      contributorEmail: reservation.contributorEmail,
      contributorPhone: reservation.contributorPhone,
      // The ledger's own copy of the answer, beside the grant's. Both columns
      // are written from the one place the contributor gave it.
      wantsToHelp: reservation.wantsToHelp,
      confirmedAt: new Date(),
      // Attributed to whoever confirmed. The contributor declared it; the host
      // is the one asserting the money arrived.
      recordedByHostId: input.hostId,
      confirmedByHostId: input.hostId,
      postCloseAt: postClose ? new Date() : null,
    },
    select: { id: true },
  });

  // Supporter, grant and passes — the same call the Stripe path makes, with the
  // same in-transaction sum assertion. One minting path, not two.
  const { passesMinted } = await confirmEntryPurchase(tx, {
    eventId: reservation.eventId,
    contributionId: contribution.id,
    // Ticket money only. The assertion inside is that the PASSES sum to this,
    // and a donation buys no pass - including it would make a correct purchase
    // fail.
    entryAmountCents: ticketCents,
    passes,
    contact: {
      name: reservation.contributorName,
      email: reservation.contributorEmail,
      phone: reservation.contributorPhone,
    },
    // Carried from the reservation, where it has been waiting since the
    // contributor ticked the box. This is the whole reason the column exists:
    // the grant is created HERE, days after the answer was given.
    wantsToHelp: reservation.wantsToHelp,
  });

  for (const line of reservation.lines) {
    await tx.entryReservationLine.update({
      where: { id: line.id },
      data: { quantityConfirmed: line.quantity, contributionId: contribution.id },
    });
  }

  // Conditional on still being pending. A concurrent confirm that got here
  // first leaves this one matching zero rows, and the throw rolls back
  // everything above it.
  const { count } = await tx.entryReservation.updateMany({
    where: { id: reservation.id, status: "pending" },
    data: { status: "resolved", resolvedAt: new Date() },
  });
  if (count === 0) throw new ReservationNotPending();

  return {
    contributionId: contribution.id,
    passesMinted,
    postClose,
    ticketCents,
    donationCents,
  };
}

/**
 * The money never arrived, or the contributor asked to cancel.
 *
 * NOTHING IS DELETED. The row keeps its reference code, its lines and its
 * prices, because the audit question "what did this person reserve and what
 * happened to it" has to stay answerable. Released is a terminal state, not an
 * erasure.
 *
 * No Contribution is created or touched: there was never any money here.
 */
export async function releaseEntryReservation(
  tx: Prisma.TransactionClient,
  input: { reservationId: string; reason: string }
): Promise<{ released: boolean }> {
  const { count } = await tx.entryReservation.updateMany({
    where: { id: input.reservationId, status: "pending" },
    data: {
      status: "released",
      releasedAt: new Date(),
      releaseReason: input.reason,
    },
  });
  return { released: count > 0 };
}
