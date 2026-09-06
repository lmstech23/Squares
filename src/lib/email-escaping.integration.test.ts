import { test, describe, before, after, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";

// HTML escaping in confirmation emails, over a REAL host-controlled value.
//
// `Board.gameName` is typed by the host, editable at any time through /details,
// and was interpolated raw into three places in confirmation-email.ts. A host
// naming a board `<img src=x onerror=...>` would have had that markup rendered
// inside every contributor confirmation - stored HTML injection into other
// people's inboxes, through the one field a host is invited to type freely.
//
// The board name is written to a real row and read back through the sender, so
// what is asserted is the HTML that would actually have been handed to Resend.
//
//   npm run test:db:up && npm run test:integration:escaping

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

// Every character the escaper handles, in one name, plus a payload that would
// actually execute if any of them survived.
const HOSTILE = `<img src=x onerror="alert('xss')"> Tom & "Jerry" 'Co' <b>`;

describe(
  "email HTML escaping (integration)",
  { skip: !url && "TEST_DATABASE_URL not set" },
  () => {
    const db = prisma!;
    let hostId: string;
    let boardId = "";
    const PRICE = 5000;

    async function seedBoard(boardType: "fundraiser" | "game") {
      const b = await db.board.create({
        data: {
          hostId,
          gameName: HOSTILE,
          slug: "esc-" + randomUUID().slice(0, 8),
          boardType,
          squarePrice: PRICE,
          totalSquares: 2,
          timezone: "America/New_York",
          ...(boardType === "fundraiser"
            ? { campaignEndsAt: new Date(Date.now() + 7 * 864e5) }
            : { teamCol: "A", teamRow: "B" }),
        },
      });
      boardId = b.boardId;
      await db.square.createMany({
        data: Array.from({ length: 2 }, (_, i) => ({
          boardId,
          position: i,
          paymentStatus: "open" as const,
        })),
      });
    }

    /** A paid square awaiting its confirmation email. */
    async function paidSquare(email: string) {
      const sq = await db.square.findFirstOrThrow({
        where: { boardId, paymentStatus: "open" },
        orderBy: { position: "asc" },
      });
      await db.square.update({
        where: { squareId: sq.squareId },
        data: {
          paymentStatus: "paid",
          paymentMethod: "cash",
          playerName: "Buyer",
          playerEmail: email,
          pricePaidCents: PRICE,
          batchId: randomUUID(),
          claimedAt: new Date(),
          confirmationEmailedAt: null,
        },
      });
    }

    async function confirmedDonation(email: string) {
      await db.contribution.create({
        data: {
          boardId,
          status: "confirmed",
          paymentMethod: "cash",
          squareAmountCents: 0,
          donationAmountCents: 2500,
          totalPaidCents: 2500,
          contributorName: "Donor",
          contributorEmail: email,
          confirmedAt: new Date(),
        },
      });
    }

    /**
     * Nothing from the name can open a tag or close an attribute.
     *
     * NOT a check for the substring `onerror=`. Escaping does not delete text,
     * it neutralises delimiters: once `<` and `"` are entities, `onerror=`
     * survives as inert prose and asserting on it fails a correct escaper.
     * What matters is that no `<` and no `"` from the name reaches the output.
     */
    function assertNoRawMarkup(html: string) {
      assert.ok(!html.includes(HOSTILE), "the raw payload appears verbatim");
      assert.ok(!html.includes("<img"), "the name opened a tag");
      assert.ok(!html.includes("<b>"), "the name opened a tag");
      // Present, escaped, not stripped - the host still sees their board name.
      assert.ok(html.includes("&lt;img src=x"), "the name is present, escaped");
    }

    /** Each of the five characters, individually. */
    function assertAllFiveEscaped(html: string) {
      assert.ok(html.includes("&lt;"), "< not escaped");
      assert.ok(html.includes("&gt;"), "> not escaped");
      assert.ok(html.includes("&amp;"), "& not escaped");
      assert.ok(html.includes("&quot;"), '" not escaped');
      assert.ok(html.includes("&#39;"), "' not escaped");
      // & must be escaped FIRST or the others double-escape into &amp;lt;
      assert.ok(!html.includes("&amp;lt;"), "double-escaped: & ran after <");
      assert.ok(!html.includes('&amp;quot;'), 'double-escaped: & ran after a quote');
    }

    before(async () => {
      const h = await db.host.create({
        data: { email: "esc-" + randomUUID() + "@example.com" },
      });
      hostId = h.id;
    });

    beforeEach(async () => {
      sends.length = 0;
      if (boardId) {
        await db.square.deleteMany({ where: { boardId } });
        await db.contribution.deleteMany({ where: { boardId } });
        await db.board.deleteMany({ where: { boardId } });
        boardId = "";
      }
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

    test("fundraiser ticket confirmation escapes the board name", async () => {
      await seedBoard("fundraiser");
      await paidSquare("buyer@example.com");
      await sendPendingConfirmations({ boardId });

      assert.equal(sends.length, 1);
      assertNoRawMarkup(sends[0].html);
      assertAllFiveEscaped(sends[0].html);
    });

    test("Game Day confirmation escapes the board name", async () => {
      await seedBoard("game");
      await paidSquare("player@example.com");
      await sendPendingConfirmations({ boardId });

      assert.equal(sends.length, 1);
      assertNoRawMarkup(sends[0].html);
      assertAllFiveEscaped(sends[0].html);
    });

    test("donation confirmation escapes the board name", async () => {
      await seedBoard("fundraiser");
      await confirmedDonation("donor@example.com");
      await sendPendingConfirmations({ boardId });

      assert.equal(sends.length, 1);
      assertNoRawMarkup(sends[0].html);
      assertAllFiveEscaped(sends[0].html);
    });

    // THE SUBJECT IS NOT ESCAPED, ON PURPOSE. It reaches Resend as a JSON
    // field, where markup is inert - there is no HTML parser on that side and
    // no header to inject into. Escaping it would put a literal `&amp;` in
    // front of the reader, which is a content change, not a fix.
    test("the subject keeps the name verbatim", async () => {
      await seedBoard("fundraiser");
      await confirmedDonation("donor@example.com");
      await sendPendingConfirmations({ boardId });

      assert.ok(sends[0].subject.includes(HOSTILE), "subject is unescaped");
      assert.ok(!sends[0].subject.includes("&amp;"), "and not entity-encoded");
    });

    // A name with none of the five must come through byte-identical - the
    // escaper must not alter ordinary text.
    test("an ordinary board name is unchanged", async () => {
      const b = await db.board.create({
        data: {
          hostId,
          gameName: "Homecoming 2026",
          slug: "esc-" + randomUUID().slice(0, 8),
          boardType: "fundraiser",
          squarePrice: PRICE,
          totalSquares: 1,
          timezone: "America/New_York",
          campaignEndsAt: new Date(Date.now() + 7 * 864e5),
        },
      });
      boardId = b.boardId;
      await confirmedDonation("plain@example.com");
      await sendPendingConfirmations({ boardId });

      assert.ok(sends[0].html.includes("<strong>Homecoming 2026</strong>"));
    });
  }
);
