import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";
import { donationReturnState } from "./donation-return.ts";

// The donation-only card return, against REAL ledger rows.
//
// The point of these is the NEGATIVE cases. A confirmation screen is a claim
// that money was taken, and the only thing standing between a query string and
// that claim is the row this looks up. Mocked rows would prove the function
// matches the fixture; these prove it against rows written the way the donate
// route and the webhook actually write them.
//
//   npm run test:db:up && npm run test:integration:donation

const url = process.env.TEST_DATABASE_URL;
const prisma = url ? new PrismaClient({ datasources: { db: { url } } }) : null;

describe(
  "donation card return (integration)",
  { skip: !url && "TEST_DATABASE_URL not set" },
  () => {
    const db = prisma!;
    let hostId: string;
    let boardId = "";
    let otherBoardId = "";

    async function seedBoard(): Promise<string> {
      const board = await db.board.create({
        data: {
          hostId,
          gameName: "Donation Return",
          slug: "don-" + randomUUID().slice(0, 8),
          boardType: "fundraiser",
          squarePrice: 5000,
          totalSquares: 0,
          timezone: "America/New_York",
          campaignEndsAt: new Date(Date.now() + 7 * 864e5),
        },
      });
      return board.boardId;
    }

    /** A donation-only ledger row, as api/board/[slug]/donate writes it. */
    async function contribution(opts: {
      board?: string;
      status: string;
      squareAmountCents?: number;
      voided?: boolean;
    }) {
      const sessionId = "cs_test_" + randomUUID().replace(/-/g, "");
      const square = opts.squareAmountCents ?? 0;
      await db.contribution.create({
        data: {
          boardId: opts.board ?? boardId,
          status: opts.status as never,
          paymentMethod: "stripe",
          squareAmountCents: square,
          donationAmountCents: 2500,
          totalPaidCents: 2500 + square,
          contributorName: "Donor",
          contributorEmail: "donor@example.com",
          checkoutSessionId: sessionId,
          voidedAt: opts.voided ? new Date() : null,
        },
      });
      return sessionId;
    }

    /** Exactly the query the board page runs. */
    async function lookup(sessionId: string) {
      return db.contribution.findUnique({
        where: { checkoutSessionId: sessionId },
        select: {
          boardId: true,
          status: true,
          squareAmountCents: true,
          voidedAt: true,
        },
      });
    }

    before(async () => {
      const host = await db.host.create({
        data: { email: "don-" + randomUUID() + "@example.com" },
      });
      hostId = host.id;
      boardId = await seedBoard();
      otherBoardId = await seedBoard();
    });

    beforeEach(async () => {
      await db.contribution.deleteMany({ where: { boardId: { in: [boardId, otherBoardId] } } });
    });

    after(async () => {
      await db.contribution.deleteMany({ where: { boardId: { in: [boardId, otherBoardId] } } });
      await db.board.deleteMany({ where: { boardId: { in: [boardId, otherBoardId] } } });
      if (hostId) await db.host.deleteMany({ where: { id: hostId } });
      await db.$disconnect();
    });

    test("a confirmed donation renders as settled", async () => {
      const sid = await contribution({ status: "confirmed" });
      assert.deepEqual(donationReturnState(await lookup(sid), boardId), { settled: true });
    });

    // The redirect and the webhook race, and the redirect usually wins. Say so
    // rather than claiming a payment that has not confirmed.
    test("a pending donation renders, but NOT as settled", async () => {
      const sid = await contribution({ status: "pending" });
      assert.deepEqual(donationReturnState(await lookup(sid), boardId), { settled: false });
    });

    test("a released donation renders nothing", async () => {
      const sid = await contribution({ status: "released" });
      assert.equal(donationReturnState(await lookup(sid), boardId), null);
    });

    // A VOID LEAVES `status` READING `confirmed` - donations §7 makes voidedAt
    // write-once and never touches status, so the row stays visible as what it
    // was. Testing status alone would show "Payment received" over money the
    // host has already reversed. This test is what caught that.
    test("a voided donation renders nothing, despite status = confirmed", async () => {
      const sid = await contribution({ status: "confirmed", voided: true });
      const row = await lookup(sid);
      assert.equal(row?.status, "confirmed", "the void did not change status");
      assert.equal(donationReturnState(row, boardId), null);
    });

    // A session id is a lookup key, not a claim. None of these may produce a
    // confirmation.
    test("an unknown session id renders nothing", async () => {
      assert.equal(donationReturnState(await lookup("cs_test_nope"), boardId), null);
    });

    test("another board's session renders nothing on this board", async () => {
      const sid = await contribution({ board: otherBoardId, status: "confirmed" });
      const row = await lookup(sid);
      assert.ok(row, "the row exists");
      assert.equal(donationReturnState(row, boardId), null, "but not for this board");
      assert.deepEqual(donationReturnState(row, otherBoardId), { settled: true });
    });

    // A mixed checkout returns through ?success=true and renders the ticket
    // confirmation. Showing a donation receipt would silently drop the tickets
    // from what the contributor is told they bought.
    test("a mixed contribution renders nothing here", async () => {
      const sid = await contribution({ status: "confirmed", squareAmountCents: 5000 });
      assert.equal(donationReturnState(await lookup(sid), boardId), null);
    });
  }
);
