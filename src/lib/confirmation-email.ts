import { prisma } from "@/lib/prisma";
import { sendEmail } from "@/lib/email";

// One email per confirmation event — fundraiser-admission-addendum.md §5.
//
// NOT one per square. Buy 4 squares, get 1 email listing 4. Four emails each
// holding one QR is unusable at a gate, and it breaks sharing: someone buying
// four tickets for a family needs them in one place to forward individually,
// not scattered across four messages to dig through.
//
// The batch is the unit, and `confirmationEmailedAt` is what makes that
// expressible. Each send covers every paid square in the batch that has not
// been mailed yet, then stamps them. That handles the partial-cash case for
// free: 3 reserved and 2 confirmed sends for the 2; the third confirming later
// is a separate event with its own email rather than a duplicate.
//
// Cash batches resolve per square (money doc §4), so a host confirming three
// squares one at a time produces three confirmation events. Sending inline
// would mean three emails. The cash path therefore does NOT send inline — the
// five-minute cron sweeps instead, which coalesces rapid clicks into one email
// per batch. Card confirms atomically, so it sends immediately and a
// contributor gets their receipt while still looking at the page.

interface SquareRow {
  squareId: string;
  position: number;
  playerEmail: string | null;
  batchId: string | null;
}

/** Groups by recipient so one person gets one email even across batches. */
function byRecipient(squares: SquareRow[]): Map<string, SquareRow[]> {
  const map = new Map<string, SquareRow[]>();
  for (const sq of squares) {
    if (!sq.playerEmail) continue;
    const key = sq.playerEmail.toLowerCase();
    map.set(key, [...(map.get(key) ?? []), sq]);
  }
  return map;
}

function subjectAndBody(
  positions: number[],
  boardName: string,
  isFundraiser: boolean
): { subject: string; html: string } {
  const list = positions.map((p) => `#${p}`).join(" · ");
  const n = positions.length;

  if (isFundraiser) {
    return {
      subject:
        n === 1
          ? `Your contribution is confirmed — ${boardName}`
          : `Your ${n} contributions are confirmed — ${boardName}`,
      html:
        `<p>Thank you — your contribution to <strong>${boardName}</strong> is confirmed.</p>` +
        `<p>${n === 1 ? "Square" : "Squares"}: <strong>${list}</strong></p>`,
    };
  }

  return {
    subject:
      n === 1
        ? `Your square is confirmed — ${boardName}`
        : `Your ${n} squares are confirmed — ${boardName}`,
    html:
      `<p>You're in! ${n === 1 ? "Square" : "Squares"} <strong>${list}</strong> ` +
      `on <strong>${boardName}</strong> locked in. Good luck!</p>`,
  };
}

/**
 * Send one email per recipient covering everything newly confirmed and unmailed.
 *
 * `where` narrows the sweep — a single batch after a card confirmation, or a
 * whole board from the cron. Stamping happens only for squares actually
 * included in a sent email, so a send failure leaves them unstamped and the
 * next sweep retries rather than dropping the receipt silently.
 *
 * Never throws. Payment state is already committed by the time this runs and
 * must not be affected by an email provider having a bad minute.
 */
export async function sendPendingConfirmations(where: {
  batchId?: string;
  boardId?: string;
}): Promise<{ emailsSent: number; squaresCovered: number }> {
  const result = { emailsSent: 0, squaresCovered: 0 };

  try {
    const squares = await prisma.square.findMany({
      where: {
        paymentStatus: "paid",
        confirmationEmailedAt: null,
        playerEmail: { not: null },
        ...(where.batchId ? { batchId: where.batchId } : {}),
        ...(where.boardId ? { boardId: where.boardId } : {}),
      },
      select: {
        squareId: true,
        position: true,
        playerEmail: true,
        batchId: true,
        board: { select: { gameName: true, boardType: true } },
      },
      orderBy: { position: "asc" },
    });

    if (squares.length === 0) return result;

    const boardName = squares[0].board.gameName;
    const isFundraiser = squares[0].board.boardType === "fundraiser";

    for (const [email, rows] of byRecipient(squares)) {
      const positions = rows.map((r) => r.position + 1);
      const { subject, html } = subjectAndBody(positions, boardName, isFundraiser);

      try {
        await sendEmail(email, subject, html);
      } catch (err) {
        // Leave them unstamped. The next sweep tries again; a dropped receipt
        // is worse than a late one.
        console.warn(`Confirmation email failed for ${email}:`, err);
        continue;
      }

      await prisma.square.updateMany({
        where: { squareId: { in: rows.map((r) => r.squareId) } },
        data: { confirmationEmailedAt: new Date() },
      });

      result.emailsSent++;
      result.squaresCovered += rows.length;
    }
  } catch (err) {
    console.warn("Confirmation email sweep failed (non-fatal):", err);
  }

  return result;
}
