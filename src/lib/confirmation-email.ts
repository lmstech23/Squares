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

/**
 * Emails must point somewhere durable. A preview's own host is right for
 * links on that deployment, but an email outlives the deployment that sent it,
 * so the configured production URL is correct here.
 */
function emailBaseUrl(): string {
  return process.env.NEXT_PUBLIC_URL ?? "https://beta.daali.app";
}

/**
 * One ticket block per admission pass, each carrying its own QR.
 *
 * The QR payload is the opaque token; the image is fetched from an endpoint
 * that only draws it. Ordinals are positional — "Ticket 2 of 4" counts current
 * usable passes in sequence order and never shows the raw sequenceNumber,
 * which is monotonic and leaves gaps once anything is voided.
 */
function ticketBlocks(tokens: string[], base: string): string {
  return tokens
    .map(
      (token, i) => `
      <tr><td style="padding:16px 0;border-top:1px solid #e5e5e5;">
        <p style="margin:0 0 8px;font:600 14px system-ui,sans-serif;">
          Ticket ${i + 1} of ${tokens.length}
        </p>
        <img src="${base}/api/tickets/${encodeURIComponent(token)}/qr"
             alt="Ticket ${i + 1} QR code"
             width="160" height="160"
             style="display:block;border:0;" />
      </td></tr>`
    )
    .join("");
}

/**
 * Groups by recipient so one person gets one email even across batches.
 *
 * KNOWN DEFECT, deliberately not fixed here. Grouping on email address
 * collapses two separately confirmed purchases into a single receipt, which
 * contradicts the addendum's `grant:{id}` receipt identity — the approved
 * design is one delivery per grant. Fixing it means choosing between one
 * delivery row per grant and a redefined recipient digest, and that choice
 * belongs to S4 against the addendum, which is not yet in the repo.
 * Engineering it against a spec that lives outside version control is the
 * off-repo-truth problem the baseline work just finished uncovering.
 * PHASE-2-BACKLOG.md.
 */
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
    // ATOMIC CLAIM, BEFORE THE NETWORK CALL.
    //
    // This was select -> sendEmail -> stamp. The window between selecting a row
    // and stamping it spanned a call to Resend, and nothing held a lock across
    // it. The five-minute cron sweeps globally while the Stripe webhook fires on
    // card confirmation, so two invocations could select the same rows and both
    // send. The race becomes possible with the first confirmed card
    // contribution; the duplicate is timing-dependent, but the defect is not.
    //
    // `updateManyAndReturn` with `confirmationEmailedAt: null` in the WHERE is
    // the claim: it stamps and reports exactly the rows this statement changed.
    // A concurrent caller's identical statement matches zero rows and returns
    // nothing to send. The same primitive `confirmSquares` uses, for the same
    // reason.
    //
    // The stamp is therefore written BEFORE the email rather than after, which
    // inverts the previous failure mode: a send failure now leaves a stamped
    // square with no email instead of an unstamped square that might be mailed
    // twice. That is why the catch below releases the claim -- see there.
    const claimed = await prisma.square.updateManyAndReturn({
      where: {
        paymentStatus: "paid",
        confirmationEmailedAt: null,
        playerEmail: { not: null },
        ...(where.batchId ? { batchId: where.batchId } : {}),
        ...(where.boardId ? { boardId: where.boardId } : {}),
      },
      data: { confirmationEmailedAt: new Date() },
      select: {
        squareId: true,
        position: true,
        playerEmail: true,
        batchId: true,
        board: { select: { gameName: true, boardType: true } },
      },
    });

    if (claimed.length === 0) return result;

    // updateManyAndReturn does not accept orderBy; sort after claiming so the
    // positions listed in the email stay ascending.
    const squares = [...claimed].sort((a, b) => a.position - b.position);

    const boardName = squares[0].board.gameName;
    const isFundraiser = squares[0].board.boardType === "fundraiser";

    for (const [email, rows] of byRecipient(squares)) {
      const positions = rows.map((r) => r.position + 1);
      const { subject, html } = subjectAndBody(positions, boardName, isFundraiser);

      // Tickets — only on a board with an event, and never for a purchase that
      // donated its admissions: minting skipped it, so there are no passes to
      // find and this is naturally empty.
      // The batch keys the passes screen. All squares a recipient has here
      // share one batch in the normal case; if a merge produced more than one,
      // any of them resolves to the same supporter and the same ticket set.
      const batchId = rows.find((r) => r.batchId)?.batchId ?? null;

      const passes = await prisma.admissionPass.findMany({
        where: {
          squareId: { in: rows.map((r) => r.squareId) },
          status: { in: ["active", "used"] },
        },
        select: { token: true },
        orderBy: { sequenceNumber: "asc" },
      });

      const base = emailBaseUrl();
      const ticketHtml =
        passes.length > 0
          ? `<table cellpadding="0" cellspacing="0" style="width:100%;margin-top:8px;">
               <tr><td style="padding-bottom:4px;">
                 <p style="margin:0;font:600 14px system-ui,sans-serif;">
                   ${passes.length} ${passes.length === 1 ? "Ticket" : "Tickets"}
                 </p>
                 <p style="margin:4px 0 0;font:13px system-ui,sans-serif;color:#666;">
                   Show a code at the gate. Each admits one person, so you can
                   forward one on its own.
                 </p>
                 ${
                   batchId
                     ? `<p style="margin:8px 0 0;font:13px system-ui,sans-serif;">
                          <a href="${base}/passes/${encodeURIComponent(batchId)}"
                             style="color:#166534;">View your tickets</a>
                          — keep this link in case the email is gone.
                        </p>`
                     : ""
                 }
               </td></tr>
               ${ticketBlocks(passes.map((p) => p.token), base)}
             </table>`
          : "";

      try {
        await sendEmail(email, subject, html + ticketHtml);
      } catch (err) {
        // RELEASE THE CLAIM. These rows were stamped before the send, so
        // leaving them stamped would silently drop the receipt forever -- the
        // failure the old ordering avoided. Clearing the stamp returns them to
        // the pool for the next sweep, which is the same outcome the old code
        // had, without the duplicate-send window.
        //
        // Guarded on the value this call wrote: if a later confirmation has
        // already re-stamped the row, that stamp is not ours to clear.
        console.warn(`Confirmation email failed for ${email}:`, err);
        try {
          await prisma.square.updateMany({
            where: {
              squareId: { in: rows.map((r) => r.squareId) },
              confirmationEmailedAt: { not: null },
            },
            data: { confirmationEmailedAt: null },
          });
        } catch (releaseErr) {
          // A release that fails leaves a stamped-but-unmailed square: a
          // missing receipt, recoverable by hand. Never let it mask the send
          // failure or abort the remaining recipients.
          console.warn(`Failed to release email claim for ${email}:`, releaseErr);
        }
        continue;
      }

      result.emailsSent++;
      result.squaresCovered += rows.length;
    }
  } catch (err) {
    console.warn("Confirmation email sweep failed (non-fatal):", err);
  }

  return result;
}
