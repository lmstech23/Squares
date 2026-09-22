import type { Prisma } from "@prisma/client";

// Entry ticket availability — fundraiser-board-v2.md §19.13, invariant 126.
//
// ONE PLACE COMPUTES IT. The card path, the direct-payment path, the host card,
// the dashboard header and the tile all read the same three numbers from here.
// A second copy of "remaining" is how a board sells its last ticket twice.
//
// NULL LIMIT MEANS UNLIMITED, and `remaining` is null rather than Infinity or a
// large number: there is nothing to be remaining out of, and every caller has to
// say what it renders in that case rather than inheriting a lie.

/**
 * The window a pending card checkout holds its tickets for.
 *
 * THE SAME TEN MINUTES A SQUARE CHECKOUT USES — `CHECKOUT_TTL_MS` in
 * `api/checkout/route.ts`. Deliberately duplicated rather than imported: that
 * constant lives inside the Game Day checkout route, which this change does not
 * touch. If one moves, move the other; they are one decision.
 *
 * WITHOUT THIS WINDOW the only thing releasing an abandoned entry checkout is
 * Stripe's `checkout.session.expired`, which can be twenty-four hours behind and
 * may never arrive at all. On a nearly-full board that is a closed tab holding
 * the last tickets for a day.
 */
export const ENTRY_HOLD_TTL_MS = 10 * 60 * 1000;

export interface EntryAvailability {
  /** NULL means unlimited. */
  limit: number | null;
  /** Confirmed, unvoided. What was bought and will not change. */
  sold: number;
  /** Pending card checkouts and pending reservations. Not yet paid. */
  held: number;
  /** `limit - sold - held`, floored at zero. NULL when there is no limit. */
  remaining: number | null;
}

/**
 * Take the board row for the duration of the caller's transaction.
 *
 * THE RACE THIS CLOSES. Squares are safe because each is a row: a conditional
 * `updateMany ... where paymentStatus: "open"` returns a count and a losing
 * racer sees `SQUARE_TAKEN`. A ticket limit has no row to contend on, so two
 * buyers can each read "2 remaining" and each buy 2.
 *
 * Same shape as `mintPasses`, which locks the supporter row before drawing
 * sequence numbers. Entry sales on one board serialise; at this volume that
 * costs nothing and is the whole correctness argument.
 *
 * MUST be called inside `prisma.$transaction`, before reading availability and
 * before writing. A lock taken after the read proves nothing.
 */
export async function lockBoardForEntry(
  tx: Prisma.TransactionClient,
  boardId: string
): Promise<void> {
  await tx.$queryRaw`SELECT board_id
                       FROM boards
                      WHERE board_id = ${boardId}::uuid
                        FOR UPDATE`;
}

/**
 * Sold, held and remaining for one board.
 *
 * SOLD IS THE PURCHASE SIDE — `entryTicketCount` on confirmed, unvoided rows.
 * Not passes: a pass is voided when a supporter says she cannot come, and a
 * ticket she bought and cannot use is still sold. Not reservation lines either:
 * those cover the direct path only and miss every card purchase.
 *
 * HELD IS WHAT HAS NOT BEEN PAID BUT WILL BECOME TICKETS if nothing intervenes:
 * a pending card checkout, written before the Stripe session exists, and a
 * pending reservation the host is waiting on. Releasing a reservation returns
 * its hold on the next read; nothing has to remember to give it back.
 */
export async function entryAvailability(
  tx: Prisma.TransactionClient,
  boardId: string,
  limit: number | null
): Promise<EntryAvailability> {
  const [soldAgg, heldCardAgg, heldLineAgg] = await Promise.all([
    tx.contribution.aggregate({
      where: {
        boardId,
        entryAmountCents: { gt: 0 },
        status: "confirmed",
        voidedAt: null,
      },
      _sum: { entryTicketCount: true },
    }),
    tx.contribution.aggregate({
      where: {
        boardId,
        entryAmountCents: { gt: 0 },
        status: "pending",
        voidedAt: null,
      },
      _sum: { entryTicketCount: true },
    }),
    tx.entryReservationLine.aggregate({
      where: { reservation: { boardId, status: "pending" } },
      _sum: { quantity: true },
    }),
  ]);

  const sold = soldAgg._sum.entryTicketCount ?? 0;
  const held =
    (heldCardAgg._sum.entryTicketCount ?? 0) + (heldLineAgg._sum.quantity ?? 0);

  return {
    limit,
    sold,
    held,
    // FLOORED AT ZERO. A limit lowered to under what is already committed is
    // refused at the edit route, but a board that reached that state some other
    // way must not render a negative count at a host.
    remaining: limit == null ? null : Math.max(0, limit - sold - held),
  };
}

/**
 * The same three numbers for many boards at once, in three queries rather than
 * three per board.
 *
 * SAME DEFINITIONS, ONE SOURCE. The host board list renders a card per board and
 * must not grow its own idea of sold or held; it groups what `entryAvailability`
 * aggregates. A board with no limit still gets a row, with `remaining` null.
 *
 * No lock: this is display. Nothing decides a sale from it.
 */
export async function entryAvailabilityForBoards(
  db: Prisma.TransactionClient,
  boards: { boardId: string; entryTicketLimit: number | null }[]
): Promise<Map<string, EntryAvailability>> {
  const out = new Map<string, EntryAvailability>();
  if (boards.length === 0) return out;
  const ids = boards.map((b) => b.boardId);

  const [soldRows, heldCardRows, heldLineRows] = await Promise.all([
    db.contribution.groupBy({
      by: ["boardId"],
      where: {
        boardId: { in: ids },
        entryAmountCents: { gt: 0 },
        status: "confirmed",
        voidedAt: null,
      },
      _sum: { entryTicketCount: true },
    }),
    db.contribution.groupBy({
      by: ["boardId"],
      where: {
        boardId: { in: ids },
        entryAmountCents: { gt: 0 },
        status: "pending",
        voidedAt: null,
      },
      _sum: { entryTicketCount: true },
    }),
    db.entryReservation.findMany({
      where: { boardId: { in: ids }, status: "pending" },
      select: { boardId: true, lines: { select: { quantity: true } } },
    }),
  ]);

  const soldBy = new Map(soldRows.map((r) => [r.boardId, r._sum.entryTicketCount ?? 0]));
  const heldCardBy = new Map(
    heldCardRows.map((r) => [r.boardId, r._sum.entryTicketCount ?? 0])
  );
  const heldLineBy = new Map<string, number>();
  for (const r of heldLineRows) {
    const n = r.lines.reduce((m, l) => m + l.quantity, 0);
    heldLineBy.set(r.boardId, (heldLineBy.get(r.boardId) ?? 0) + n);
  }

  for (const b of boards) {
    const sold = soldBy.get(b.boardId) ?? 0;
    const held = (heldCardBy.get(b.boardId) ?? 0) + (heldLineBy.get(b.boardId) ?? 0);
    out.set(b.boardId, {
      limit: b.entryTicketLimit,
      sold,
      held,
      remaining:
        b.entryTicketLimit == null
          ? null
          : Math.max(0, b.entryTicketLimit - sold - held),
    });
  }
  return out;
}

/**
 * What the host card and the board header both say — v2 §9.
 *
 * ONE SENTENCE, ONE PLACE. The two surfaces sit a click apart and a host will
 * read them in the same minute; two builders of the same phrase is how they
 * end up disagreeing about singular, spacing, or whether remaining is shown.
 *
 * With no limit the sold figure stands alone. There is nothing to be remaining
 * out of, and `0 remaining` on an uncapped board would read as sold out.
 */
export function ticketsSoldLabel(a: EntryAvailability): string {
  const sold = `${a.sold} ${a.sold === 1 ? "ticket" : "tickets"} sold`;
  return a.remaining == null ? sold : `${sold} · ${a.remaining} remaining`;
}

/**
 * The message a refused sale carries — §19.13.
 *
 * THE REAL NUMBER, NOT "SOLD OUT". A buyer who asked for four when two are left
 * can act on "two"; "sold out" tells her to give up on a board that would still
 * take her money. The second sentence is there because a held ticket is not a
 * sold one and may come back.
 */
export function entryLimitError(remaining: number): string {
  if (remaining <= 0) {
    return "These tickets are sold out. A reservation may still be released — check back.";
  }
  return remaining === 1
    ? "Only 1 ticket is left. Reduce your order or check back — a reservation may be released."
    : `Only ${remaining} tickets are left. Reduce your order or check back — a reservation may be released.`;
}
