import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";
import type { PaymentStatus } from "@prisma/client";
import { pricingLocks, hasConfirmedContribution } from "./board-lock.ts";
import { ticketCountFor } from "./board-inventory.ts";

// Invariant 76 against a REAL database — launch-readiness v2.1 §1.4.
//
//   "The early bird fields lock at the first confirmed square whose
//    priceSource = early_bird. The regular price locks at the first confirmed
//    square whose priceSource = regular. Neither lock affects the other."
//
// THERE IS NO priceSource COLUMN. The source is derived by comparing a
// confirmed square's pricePaidCents against the two board prices. A mocked
// square would prove only that the mock returns what the mock was told; these
// tests write real rows and read the predicate that the route and the edit
// form both consume, so the form disables exactly what the route refuses.
//
// Guarded on TEST_DATABASE_URL, like confirm-square.integration.test.ts.
// DELIBERATELY NO SKIP MARKER HERE — that file already carries the one that
// signals real-database coverage did not run, and a second would make the
// "1 skipped" line in CLAUDE.md stop meaning what it says.
//
//   npm run test:db:up && npm run test:integration:locks

const url = process.env.TEST_DATABASE_URL;
const prisma = url ? new PrismaClient({ datasources: { db: { url } } }) : null;

describe("pricingLocks (integration)", { skip: !url && "TEST_DATABASE_URL not set" }, () => {
  const db = prisma!;
  let hostId: string;
  let boardId = "";

  const REGULAR = 5000; // $50
  const EARLY = 4000; // $40
  const GOAL = 500_000; // $5,000 — 100 tickets at the REGULAR price

  /** A fundraiser with an early-bird schedule and `count` open squares. */
  async function seedBoard(count = 4, earlyBird: number | null = EARLY) {
    const board = await db.board.create({
      data: {
        hostId,
        gameName: "Lock Test",
        slug: "lock-" + randomUUID().slice(0, 8),
        boardType: "fundraiser",
        squarePrice: REGULAR,
        earlyBirdPriceCents: earlyBird,
        earlyBirdEndsAt: earlyBird == null ? null : new Date(Date.now() + 3 * 864e5),
        fundraisingGoalCents: GOAL,
        totalSquares: count,
        timezone: "America/New_York",
        campaignEndsAt: new Date(Date.now() + 7 * 864e5),
      },
    });
    boardId = board.boardId;
    await db.square.createMany({
      data: Array.from({ length: count }, (_, i) => ({
        boardId,
        position: i,
        paymentStatus: "open" as const,
      })),
    });
    return db.square.findMany({ where: { boardId }, orderBy: { position: "asc" } });
  }

  async function sell(
    squareId: string,
    pricePaidCents: number,
    status: PaymentStatus = "paid"
  ) {
    await db.square.update({
      where: { squareId },
      data: { paymentStatus: status, pricePaidCents, batchId: randomUUID() },
    });
  }

  before(async () => {
    const host = await db.host.create({
      data: { email: "lock-" + randomUUID() + "@example.com" },
    });
    hostId = host.id;
  });

  beforeEach(async () => {
    if (!boardId) return;
    await db.square.deleteMany({ where: { boardId } });
    await db.board.deleteMany({ where: { boardId } });
    boardId = "";
  });

  after(async () => {
    if (boardId) {
      await db.square.deleteMany({ where: { boardId } });
      await db.board.deleteMany({ where: { boardId } });
    }
    if (hostId) await db.host.deleteMany({ where: { id: hostId } });
    await db.$disconnect();
  });

  // PROOF 1 — before any confirmed contribution, every price field is editable.
  test("nothing confirmed: all three price fields are editable", async () => {
    await seedBoard(4);
    const locks = await pricingLocks(boardId, db);
    assert.deepEqual(locks, {
      inventoryLocked: false,
      earlyBirdLocked: false,
      regularLocked: false,
    });
  });

  // A hold is a promise, not money — board-lock.ts derives this from invariants
  // 1 and 3. A pending checkout that expires ten minutes later must not have
  // permanently locked the host out of her own pricing.
  test("pending and reserved_cash squares lock nothing", async () => {
    const sq = await seedBoard(4);
    await sell(sq[0].squareId, EARLY, "pending");
    await sell(sq[1].squareId, REGULAR, "reserved_cash");
    const locks = await pricingLocks(boardId, db);
    assert.deepEqual(locks, {
      inventoryLocked: false,
      earlyBirdLocked: false,
      regularLocked: false,
    });
    assert.equal(await hasConfirmedContribution(boardId, db), false);
  });

  // PROOF 2 — an early-bird sale locks the early-bird fields ONLY.
  test("early bird sale: early fields lock, regular price stays editable", async () => {
    const sq = await seedBoard(4);
    await sell(sq[0].squareId, EARLY);
    const locks = await pricingLocks(boardId, db);
    assert.equal(locks.earlyBirdLocked, true);
    assert.equal(locks.regularLocked, false, "nobody has paid the regular price yet");
    assert.equal(locks.inventoryLocked, true, "ticket numbers are already issued");
  });

  // PROOF 3 — a regular sale locks the regular price ONLY.
  test("regular sale: regular price locks, early bird stays independent", async () => {
    const sq = await seedBoard(4);
    await sell(sq[0].squareId, REGULAR);
    const locks = await pricingLocks(boardId, db);
    assert.equal(locks.regularLocked, true);
    assert.equal(locks.earlyBirdLocked, false, "nobody has paid the early price");
    assert.equal(locks.inventoryLocked, true);
  });

  test("one sale of each locks both, arrived at independently", async () => {
    const sq = await seedBoard(4);
    await sell(sq[0].squareId, EARLY);
    await sell(sq[1].squareId, REGULAR);
    const locks = await pricingLocks(boardId, db);
    assert.deepEqual(locks, {
      inventoryLocked: true,
      earlyBirdLocked: true,
      regularLocked: true,
    });
  });

  // The derivation is sound only where the two prices differ. Equal prices are
  // ambiguous, and board-lock.ts locks BOTH rather than guessing — it does not
  // rely on the boards_early_bird_coherent CHECK, which is live in production
  // but absent from 0_init and so from any database rebuilt by migration.
  test("equal prices are ambiguous and lock both", async () => {
    const sq = await seedBoard(4, REGULAR);
    await sell(sq[0].squareId, REGULAR);
    const locks = await pricingLocks(boardId, db);
    assert.deepEqual(locks, {
      inventoryLocked: true,
      earlyBirdLocked: true,
      regularLocked: true,
    });
  });

  // A confirmed square matching NEITHER price means an assumption has already
  // failed. The safe answer is to stop allowing price edits, not to guess.
  test("a confirmed square at neither price locks both", async () => {
    const sq = await seedBoard(4);
    await sell(sq[0].squareId, 1234);
    const locks = await pricingLocks(boardId, db);
    assert.equal(locks.earlyBirdLocked, true);
    assert.equal(locks.regularLocked, true);
  });

  // PROOF 4 — THE RESIZE GATE. The route recomputes inventory when, and only
  // when, `!locks.inventoryLocked`, on a goal change OR a price change. This
  // asserts the gate is open before the first confirmed contribution, and what
  // the derived count is on either side of a price edit.
  test("before any confirmation the resize gate is OPEN and price drives count", async () => {
    await seedBoard(100);
    const locks = await pricingLocks(boardId, db);
    assert.equal(locks.inventoryLocked, false, "the gate the route branches on");
    // A $5,000 goal is 100 tickets at $50 and 50 at $100. The price alone
    // changes the count; nothing else about the board has to move.
    assert.equal(ticketCountFor(GOAL, REGULAR), 100);
    assert.equal(ticketCountFor(GOAL, 10_000), 50);
  });

  // PROOF 5 — after the first confirmed contribution the count is fixed. The
  // gate is shut by ANY confirmed square, early bird or regular, because
  // ticket numbers are square positions.
  test("after the first confirmation the resize gate is SHUT", async () => {
    const sq = await seedBoard(4);
    await sell(sq[0].squareId, EARLY);
    assert.equal((await pricingLocks(boardId, db)).inventoryLocked, true);
    // The goal may still be raised. It simply stops driving size.
    await db.board.update({
      where: { boardId },
      data: { fundraisingGoalCents: 1_000_000 },
    });
    const after = await pricingLocks(boardId, db);
    assert.equal(after.inventoryLocked, true);
    assert.equal(await db.square.count({ where: { boardId } }), 4);
  });
});
