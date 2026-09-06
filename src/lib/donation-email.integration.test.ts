import { test, describe, before, after, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";

// Donation confirmation emails, against a REAL database.
//
// A donation had no square, and the sender claims rows over `squares`, so a
// donation matched nothing: no receipt on either payment method. A card donor
// at least got a Stripe receipt; a direct-payment donor got NOTHING - no
// screen once the tab closed, no email, no record to point at.
//
// WHAT THESE TESTS ACTUALLY GUARD is the claim. sendEmail is stubbed to record
// recipients, so what is asserted is WHICH ROWS WERE CLAIMED and how many
// sends happened - the duplicate-delivery question - not the HTML.
//
//   npm run test:db:up && npm run test:integration:donation-email

const url = process.env.TEST_DATABASE_URL;
const prisma = url ? new PrismaClient({ datasources: { db: { url } } }) : null;

/** Every send this run, in order. `fail` makes the next send throw. */
const sends: { to: string; subject: string }[] = [];
let failNext = false;

if (url) {
  mock.module("@/lib/email", {
    namedExports: {
      sendEmail: async (to: string, subject: string) => {
        if (failNext) {
          failNext = false;
          throw new Error("simulated Resend failure");
        }
        sends.push({ to, subject });
      },
    },
  });
}

const { sendPendingConfirmations } = url
  ? await import("./confirmation-email.ts")
  : { sendPendingConfirmations: null as never };

describe(
  "donation confirmation email (integration)",
  { skip: !url && "TEST_DATABASE_URL not set" },
  () => {
    const db = prisma!;
    let hostId: string;
    let boardId = "";
    const PRICE = 5000;

    async function donation(
      email: string | null,
      cents: number,
      opts: { status?: string; voided?: boolean; squareCents?: number; emailed?: boolean } = {}
    ) {
      const sqc = opts.squareCents ?? 0;
      return db.contribution.create({
        data: {
          boardId,
          status: (opts.status ?? "confirmed") as never,
          paymentMethod: "cash",
          squareAmountCents: sqc,
          donationAmountCents: cents,
          totalPaidCents: cents + sqc,
          contributorName: "Donor",
          contributorEmail: email,
          confirmedAt: new Date(),
          voidedAt: opts.voided ? new Date() : null,
          confirmationEmailedAt: opts.emailed ? new Date() : null,
        },
      });
    }

    before(async () => {
      const h = await db.host.create({
        data: { email: "de-" + randomUUID() + "@example.com" },
      });
      hostId = h.id;
    });

    beforeEach(async () => {
      sends.length = 0;
      failNext = false;
      if (boardId) {
        await db.square.deleteMany({ where: { boardId } });
        await db.contribution.deleteMany({ where: { boardId } });
        await db.board.deleteMany({ where: { boardId } });
      }
      const b = await db.board.create({
        data: {
          hostId,
          gameName: "Email Board",
          slug: "de-" + randomUUID().slice(0, 8),
          boardType: "fundraiser",
          squarePrice: PRICE,
          totalSquares: 4,
          timezone: "America/New_York",
          campaignEndsAt: new Date(Date.now() + 7 * 864e5),
        },
      });
      boardId = b.boardId;
      await db.square.createMany({
        data: Array.from({ length: 4 }, (_, i) => ({
          boardId,
          position: i,
          paymentStatus: "open" as const,
        })),
      });
    });

    after(async () => {
      if (boardId) {
        await db.square.deleteMany({ where: { boardId } });
        await db.contribution.deleteMany({ where: { boardId } });
        await db.board.deleteMany({ where: { boardId } });
      }
      if (hostId) await db.host.deleteMany({ where: { id: hostId } });
      await db.$disconnect();
    });

    const stampOf = (id: string) =>
      db.contribution
        .findUniqueOrThrow({ where: { id }, select: { confirmationEmailedAt: true } })
        .then((r) => r.confirmationEmailedAt);

    test("a confirmed donation is emailed once and stamped", async () => {
      const c = await donation("donor@example.com", 2500);
      await sendPendingConfirmations({ boardId });

      assert.equal(sends.length, 1);
      assert.equal(sends[0].to, "donor@example.com");
      assert.match(sends[0].subject, /donation is confirmed/);
      assert.notEqual(await stampOf(c.id), null, "claimed");
    });

    // THE DUPLICATE-DELIVERY QUESTION. The cron sweeps globally while the
    // webhook fires on confirmation; whichever runs second must match nothing.
    test("a second sweep sends nothing", async () => {
      await donation("donor@example.com", 2500);
      await sendPendingConfirmations({ boardId });
      await sendPendingConfirmations({ boardId });
      assert.equal(sends.length, 1, "the claim, not a check-then-send");
    });

    test("two overlapping sweeps in flight together send exactly one", async () => {
      await donation("donor@example.com", 2500);
      await Promise.all([
        sendPendingConfirmations({ boardId }),
        sendPendingConfirmations({ boardId }),
      ]);
      assert.equal(sends.length, 1);
    });

    // ONE EMAIL PER PURCHASE. Two donations from one person at different times
    // are two purchases; a matching address is not a reason to merge them.
    test("two donations from the same address are two emails", async () => {
      await donation("same@example.com", 2500);
      await donation("same@example.com", 5000);
      await sendPendingConfirmations({ boardId });
      assert.equal(sends.length, 2);
      assert.deepEqual(
        sends.map((x) => x.to),
        ["same@example.com", "same@example.com"]
      );
    });

    // ---- rows that must never be claimed -----------------------------------

    test("a pending donation is not emailed", async () => {
      const c = await donation("p@example.com", 2500, { status: "pending" });
      await sendPendingConfirmations({ boardId });
      assert.equal(sends.length, 0);
      assert.equal(await stampOf(c.id), null);
    });

    // A void leaves `status` reading confirmed. Without the second half of the
    // filter, reversing a donation would still send a receipt for it.
    test("a voided donation is not emailed, despite status = confirmed", async () => {
      const c = await donation("v@example.com", 2500, { voided: true });
      await sendPendingConfirmations({ boardId });
      assert.equal(sends.length, 0);
      assert.equal(await stampOf(c.id), null);
    });

    // THE BACKFILL, as a behaviour: a row already stamped is historical and
    // must never be swept. This is what stops the first run after deploy from
    // emailing every donor who ever gave.
    test("an already-stamped donation is never re-sent", async () => {
      await donation("old@example.com", 2500, { emailed: true });
      await sendPendingConfirmations({ boardId });
      assert.equal(sends.length, 0);
    });

    test("a donation with no email address is skipped", async () => {
      const c = await donation(null, 2500);
      await sendPendingConfirmations({ boardId });
      assert.equal(sends.length, 0);
      assert.equal(await stampOf(c.id), null, "not claimed either");
    });

    // A mixed purchase is one purchase: the square path mails it, and this
    // sweep must not add a second email for the same money.
    test("a mixed contribution is not swept here", async () => {
      const c = await donation("mix@example.com", 2500, { squareCents: PRICE });
      await sendPendingConfirmations({ boardId });
      assert.equal(sends.length, 0, "no donation-only email");
      assert.equal(await stampOf(c.id), null);
    });

    // ---- failure releases the claim ----------------------------------------

    test("a send failure releases the claim so the next sweep retries", async () => {
      const c = await donation("retry@example.com", 2500);
      failNext = true;
      await sendPendingConfirmations({ boardId });
      assert.equal(sends.length, 0, "the send threw");
      assert.equal(await stampOf(c.id), null, "claim released");

      await sendPendingConfirmations({ boardId });
      assert.equal(sends.length, 1, "retried on the next sweep");
      assert.notEqual(await stampOf(c.id), null);
    });

    // A batchId call is about one square purchase; donations carry no batch.
    test("a batch-scoped call sweeps no donations", async () => {
      await donation("b@example.com", 2500);
      await sendPendingConfirmations({ batchId: randomUUID() });
      assert.equal(sends.length, 0);
    });
  }
);
