import { test, describe, before, after, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";

// The volunteer sign-up link on a STANDALONE ENTRY TICKET receipt.
//
// THE DEFECT THIS GUARDS. The sign-up block lived inline in the square sweep,
// gated on `batchId`. A standalone entry purchase has no square batch, so no
// ticket buyer could ever be sent the link — on either entry path, card or
// direct payment. The help checkbox was restored on both panels at the same
// time as this, and without the block being shared it would have led nowhere:
// the grant would say `wantsToHelp: true` and the buyer would never be told
// where to go.
//
// WHAT IS ASSERTED IS THE HTML, not the claim. The duplicate-delivery question
// is already covered by the donation-email suite; what was unproven is whether
// the block renders at all for a purchase with no square.
//
//   npm run test:db:up && npm run test:integration:signup-link

const url = process.env.TEST_DATABASE_URL;
const prisma = url ? new PrismaClient({ datasources: { db: { url } } }) : null;

const sends: { to: string; subject: string; html: string }[] = [];

if (url) {
  mock.module("@/lib/email", {
    namedExports: {
      sendEmail: async (to: string, subject: string, html: string) => {
        sends.push({ to, subject, html });
      },
    },
  });
}

const { sendPendingConfirmations } = url
  ? await import("./confirmation-email.ts")
  : { sendPendingConfirmations: null as never };

describe(
  "entry receipt sign-up link (integration)",
  { skip: !url && "TEST_DATABASE_URL not set" },
  () => {
    const db = prisma!;
    let hostId = "";
    let boardId = "";
    let eventId = "";

    async function seed(opts: { sheet?: boolean; sheetOpen?: boolean } = {}) {
      const board = await db.board.create({
        data: {
          hostId,
          gameName: "Link Test",
          slug: "lnk-" + randomUUID().slice(0, 8),
          boardType: "fundraiser",
          squarePrice: 5000,
          totalSquares: 0,
          timezone: "America/New_York",
          acceptedPaymentMethods: ["zelle"],
          hostZelle: "host@example.com",
          entryChildPriceCents: 1500,
          entryAdultRegularPriceCents: 5000,
        },
      });
      boardId = board.boardId;
      const ev = await db.event.create({
        data: {
          boardId,
          startsAt: new Date(Date.now() + 30 * 864e5),
          timezone: "America/New_York",
        },
      });
      eventId = ev.id;
      if (opts.sheet !== false) {
        await db.signupSheet.create({
          data: { eventId, title: "Volunteer Sign-Up", isOpen: opts.sheetOpen ?? true },
        });
      }
    }

    /**
     * A confirmed standalone entry purchase, exactly as the reservation confirm
     * path leaves it: one contribution, one supporter, one STANDALONE grant,
     * one pass, and NO square batch — which is the whole point.
     */
    async function entryPurchase(wantsToHelp: boolean, email = "buyer@example.com") {
      const c = await db.contribution.create({
        data: {
          boardId,
          status: "confirmed",
          paymentMethod: "cash",
          squareAmountCents: 0,
          donationAmountCents: 0,
          entryAmountCents: 4000,
          totalPaidCents: 4000,
          contributorName: "Casey Buyer",
          contributorEmail: email,
          contributorPhone: "+16785550199",
          wantsToHelp,
          confirmedAt: new Date(),
        },
      });
      const sup = await db.eventSupporter.create({
        data: {
          eventId,
          emailKey: email,
          phoneKey: "+16785550199",
          name: "Casey Buyer",
          email,
          phone: "+16785550199",
          status: "active",
          activatedAt: new Date(),
          passSequenceCursor: 1,
        },
      });
      await db.admissionGrant.create({
        data: {
          eventId,
          eventSupporterId: sup.id,
          contributionId: c.id,
          source: "STANDALONE",
          donateAdmissions: false,
          wantsToHelp,
        },
      });
      await db.admissionPass.create({
        data: {
          eventSupporterId: sup.id,
          sequenceNumber: 1,
          tier: "ADULT",
          priceBasis: "REGULAR",
          pricePaidCents: 4000,
          token: randomUUID().replace(/-/g, ""),
          status: "active",
        },
      });
      return { contributionId: c.id, supporterId: sup.id };
    }

    const receipt = () => {
      assert.equal(sends.length, 1, `expected exactly one send, got ${sends.length}`);
      return sends[0];
    };

    before(async () => {
      const h = await db.host.create({
        data: { email: "lnk-" + randomUUID() + "@example.com" },
      });
      hostId = h.id;
    });

    async function wipe() {
      sends.length = 0;
      if (!boardId) return;
      await db.supporterAccessToken.deleteMany({ where: { supporter: { eventId } } });
      await db.admissionPass.deleteMany({ where: { supporter: { eventId } } });
      await db.admissionGrant.deleteMany({ where: { eventId } });
      await db.eventSupporter.deleteMany({ where: { eventId } });
      await db.signupSheet.deleteMany({ where: { eventId } });
      await db.contribution.deleteMany({ where: { boardId } });
      await db.event.deleteMany({ where: { boardId } });
      await db.board.deleteMany({ where: { boardId } });
      boardId = "";
    }
    beforeEach(wipe);
    after(async () => {
      await wipe();
      if (hostId) await db.host.deleteMany({ where: { id: hostId } });
      await db.$disconnect();
    });

    // THE REGRESSION. This assertion failed before the block was shared: an
    // entry buyer who opted in got a receipt with passes and no link.
    test("an opted-in ticket buyer is sent the sign-up link", async () => {
      await seed();
      await entryPurchase(true);
      await sendPendingConfirmations({ boardId });

      const mail = receipt();
      assert.match(mail.html, /Volunteer sign-up/, "the block rendered");
      assert.match(mail.html, /\/signup\//, "and carries a token link");
    });

    test("the link is a real issued token, not a placeholder", async () => {
      await seed();
      const { supporterId } = await entryPurchase(true);
      await sendPendingConfirmations({ boardId });

      const links = await db.supporterAccessToken.findMany({
        where: { eventSupporterId: supporterId },
      });
      assert.equal(links.length, 1, "one access link was issued");
      assert.match(receipt().html, /forward it/);
    });

    // Not opting in is the common case and must stay silent. Offering the link
    // to everyone would make the checkbox meaningless.
    test("a buyer who did not opt in gets no sign-up block", async () => {
      await seed();
      await entryPurchase(false);
      await sendPendingConfirmations({ boardId });

      const mail = receipt();
      assert.doesNotMatch(mail.html, /Volunteer sign-up/);
      assert.doesNotMatch(mail.html, /\/signup\//);
    });

    // The gate the panel already applies client-side, applied again at the
    // email. A sheet can be deleted between purchase and receipt.
    test("no sheet on the event means no block, even when opted in", async () => {
      await seed({ sheet: false });
      await entryPurchase(true);
      await sendPendingConfirmations({ boardId });

      assert.doesNotMatch(receipt().html, /Volunteer sign-up/);
    });

    // A closed sheet is told, not silently dropped: someone who ticked the box
    // is owed an answer about why there is no link.
    test("a closed sheet says so and issues no token", async () => {
      await seed({ sheetOpen: false });
      const { supporterId } = await entryPurchase(true);
      await sendPendingConfirmations({ boardId });

      const mail = receipt();
      assert.match(mail.html, /Volunteer sign-up/);
      assert.match(mail.html, /closed for now/);
      assert.doesNotMatch(mail.html, /\/signup\//, "no token when the sheet is closed");
      assert.equal(
        await db.supporterAccessToken.count({ where: { eventSupporterId: supporterId } }),
        0
      );
    });

    // THE RECEIPT STILL LEADS WITH THE PASSES. The sign-up block is an
    // addition to the entry receipt, not a replacement for it.
    test("the passes are still on the receipt alongside the block", async () => {
      await seed();
      await entryPurchase(true);
      await sendPendingConfirmations({ boardId });

      const mail = receipt();
      assert.match(mail.subject, /pass is ready|passes are ready/);
      assert.match(mail.html, /View your passes/);
      assert.match(mail.html, /\/api\/tickets\//, "the QR block");
      assert.match(mail.html, /Volunteer sign-up/);
    });

    // POSITION, NOT PRESENCE. The block was appended last, which put it under
    // four QR codes. Nobody scrolls past their own tickets, and this is the one
    // thing in the email with a deadline on it: the passes will still be there
    // on event day, the slots will not. Asserted by INDEX so a future edit that
    // moves it back below the codes fails here rather than in someone inbox.
    test("the sign-up block sits ABOVE the QR codes", async () => {
      await seed();
      await entryPurchase(true);
      await sendPendingConfirmations({ boardId });

      const html = receipt().html;
      const signup = html.indexOf("Volunteer sign-up");
      const firstQr = html.indexOf("/api/tickets/");
      assert.ok(signup > -1 && firstQr > -1, "both present");
      assert.ok(signup < firstQr, "the volunteer block comes first");
    });

    // But not above the receipt itself. The reader is told what they bought
    // before being asked for anything, which is why the summary line and
    // "View your passes" stay above the block on both receipts.
    test("the amount and the passes link still come before it", async () => {
      await seed();
      await entryPurchase(true);
      await sendPendingConfirmations({ boardId });

      const html = receipt().html;
      const signup = html.indexOf("Volunteer sign-up");
      assert.ok(html.indexOf("You are on the list for") < signup);
      assert.ok(html.indexOf("View your passes") < signup);
    });

    // INTEREST IS A ONE-WAY OR ACROSS GRANTS — sign-up addendum §4. A second
    // purchase that opts in makes the person interested; this is the rule the
    // shared helper exists to keep identical on both paths.
    test("a later opt-in makes an earlier unopted grant eligible", async () => {
      await seed();
      const { supporterId } = await entryPurchase(false);
      // A second purchase by the same supporter, this time ticking the box.
      const c2 = await db.contribution.create({
        data: {
          boardId,
          status: "confirmed",
          paymentMethod: "cash",
          squareAmountCents: 0,
          donationAmountCents: 0,
          entryAmountCents: 1500,
          totalPaidCents: 1500,
          contributorName: "Casey Buyer",
          contributorEmail: "buyer@example.com",
          contributorPhone: "+16785550199",
          wantsToHelp: true,
          confirmedAt: new Date(),
        },
      });
      await db.admissionGrant.create({
        data: {
          eventId,
          eventSupporterId: supporterId,
          contributionId: c2.id,
          source: "STANDALONE",
          donateAdmissions: false,
          wantsToHelp: true,
        },
      });

      await sendPendingConfirmations({ boardId });
      assert.equal(sends.length, 2, "two purchases, two receipts");
      for (const mail of sends) {
        assert.match(mail.html, /Volunteer sign-up/, "both receipts carry the link");
      }
    });
  }
);
