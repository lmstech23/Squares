import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";
import { confirmSquares, backfillPasses } from "./confirm-square.ts";

// Integration tests for confirmation and minting — addendum v2.0 §5.
//
// These need a REAL database and real concurrent transactions. Two sequential
// calls with a mocked race pass whether or not the guarantee holds, which
// makes such a test worse than no test: it reports safety that was never
// verified.
//
// Guarded on TEST_DATABASE_URL and skipped without it. It must never point at
// production — these tests create and delete rows.
//
//   TEST_DATABASE_URL=postgresql://... npm test

const url = process.env.TEST_DATABASE_URL;
const prisma = url
  ? new PrismaClient({ datasources: { db: { url } } })
  : null;

// A skipped `describe` is not enumerated at all, so without this marker a
// normal `npm test` run gives no sign that the concurrency guarantees went
// unverified. This shows up as one skipped test instead of silence.
test(
  "concurrency + backfill coverage (set TEST_DATABASE_URL to run)",
  { skip: url ? false : "TEST_DATABASE_URL not set — real-database coverage did not run" },
  () => {
    assert.ok(url);
  }
);

describe("confirmSquares (integration)", { skip: !url && "TEST_DATABASE_URL not set" }, () => {
  const db = prisma!;
  let hostId: string;
  let boardId: string;
  let eventId: string;

  /** One board, one event, `count` open squares. */
  async function seedBoard(count = 4) {
    const board = await db.board.create({
      data: {
        hostId,
        gameName: "Test Campaign",
        slug: `test-${randomUUID().slice(0, 8)}`,
        squarePrice: 3000,
        totalSquares: count,
        boardType: "fundraiser",
        timezone: "America/New_York",
        campaignEndsAt: new Date(Date.now() + 7 * 864e5),
        cashModeEnabled: true,
      },
    });
    boardId = board.boardId;

    const event = await db.event.create({
      data: {
        boardId,
        startsAt: new Date(Date.now() + 14 * 864e5),
        timezone: "America/New_York",
      },
    });
    eventId = event.id;

    await db.square.createMany({
      data: Array.from({ length: count }, (_, i) => ({
        boardId,
        position: i,
        paymentStatus: "open" as const,
      })),
    });

    return db.square.findMany({ where: { boardId }, orderBy: { position: "asc" } });
  }

  /** A claimed batch: squares reserved, supporter pending, grant written. */
  async function seedClaim(squareIds: string[], donate = false) {
    const batchId = randomUUID();
    await db.square.updateMany({
      where: { squareId: { in: squareIds } },
      data: {
        paymentStatus: "reserved_cash",
        paymentMethod: "cash",
        playerName: "Test Contributor",
        playerEmail: "contributor@example.com",
        batchId,
        pricePaidCents: 3000,
      },
    });

    const supporter = await db.eventSupporter.create({
      data: {
        eventId,
        identityKey: "contributor@example.com",
        name: "Test Contributor",
        email: "contributor@example.com",
      },
    });

    await db.admissionGrant.create({
      data: {
        eventId,
        eventSupporterId: supporter.id,
        squareBatchId: batchId,
        donateAdmissions: donate,
      },
    });

    return { batchId, supporterId: supporter.id };
  }

  async function cleanupBoard() {
    if (!boardId) return;
    await db.admissionPass.deleteMany({
      where: { supporter: { eventId } },
    });
    await db.admissionGrant.deleteMany({ where: { eventId } });
    await db.eventSupporter.deleteMany({ where: { eventId } });
    await db.event.deleteMany({ where: { boardId } });
    await db.square.deleteMany({ where: { boardId } });
    await db.board.deleteMany({ where: { boardId } });
  }

  before(async () => {
    const host = await db.host.create({
      data: { email: `test-${randomUUID()}@example.com` },
    });
    hostId = host.id;
  });

  after(async () => {
    await cleanupBoard();
    if (hostId) await db.host.deleteMany({ where: { id: hostId } });
    await db.$disconnect();
  });

  test("one confirmed square mints exactly one pass", async () => {
    const squares = await seedBoard(2);
    const { supporterId } = await seedClaim([squares[0].squareId]);

    await db.$transaction((tx) =>
      confirmSquares(tx, [squares[0].squareId], "reserved_cash")
    );

    const passes = await db.admissionPass.count({
      where: { eventSupporterId: supporterId },
    });
    assert.equal(passes, 1);

    const supporter = await db.eventSupporter.findUnique({
      where: { id: supporterId },
    });
    assert.equal(supporter!.status, "active");
    assert.equal(supporter!.passSequenceCursor, 1);

    await cleanupBoard();
  });

  test("CONCURRENT confirmation of two squares in one batch", async () => {
    // The real thing: two transactions in flight at once, as a host
    // double-tapping produces. The supporter must activate once and hold
    // exactly two passes — never four, never two supporters.
    const squares = await seedBoard(2);
    const { supporterId } = await seedClaim([
      squares[0].squareId,
      squares[1].squareId,
    ]);

    const results = await Promise.allSettled([
      db.$transaction((tx) =>
        confirmSquares(tx, [squares[0].squareId], "reserved_cash")
      ),
      db.$transaction((tx) =>
        confirmSquares(tx, [squares[1].squareId], "reserved_cash")
      ),
    ]);

    // A losing transaction may roll back on the sequence constraint; its
    // square stays reserved and is retryable. What must never happen is two
    // passes for one square, or a supporter activated twice.
    const passes = await db.admissionPass.findMany({
      where: { eventSupporterId: supporterId },
      select: { sequenceNumber: true, squareId: true },
    });

    const paidSquares = await db.square.count({
      where: { boardId, paymentStatus: "paid" },
    });

    assert.equal(
      passes.length,
      paidSquares,
      "one pass per confirmed square, no more"
    );
    assert.equal(
      new Set(passes.map((p) => p.sequenceNumber)).size,
      passes.length,
      "sequence numbers are unique"
    );
    assert.equal(
      new Set(passes.map((p) => p.squareId)).size,
      passes.length,
      "no square minted twice"
    );

    const supporter = await db.eventSupporter.findUnique({
      where: { id: supporterId },
    });
    assert.equal(supporter!.status, "active");
    assert.equal(supporter!.passSequenceCursor, passes.length);

    assert.ok(
      results.some((r) => r.status === "fulfilled"),
      "at least one transaction must succeed"
    );

    await cleanupBoard();
  });

  test("a donated purchase mints nothing but still confirms", async () => {
    const squares = await seedBoard(2);
    const { supporterId } = await seedClaim(
      [squares[0].squareId, squares[1].squareId],
      true
    );

    await db.$transaction((tx) =>
      confirmSquares(
        tx,
        squares.map((s) => s.squareId),
        "reserved_cash"
      )
    );

    assert.equal(
      await db.admissionPass.count({ where: { eventSupporterId: supporterId } }),
      0
    );
    assert.equal(
      await db.square.count({ where: { boardId, paymentStatus: "paid" } }),
      2,
      "the squares still fund the cause"
    );

    await cleanupBoard();
  });

  test("replayed confirmation mints nothing the second time", async () => {
    const squares = await seedBoard(1);
    const { supporterId } = await seedClaim([squares[0].squareId]);

    await db.$transaction((tx) =>
      confirmSquares(tx, [squares[0].squareId], "reserved_cash")
    );
    const second = await db.$transaction((tx) =>
      confirmSquares(tx, [squares[0].squareId], "reserved_cash")
    );

    assert.equal(second.confirmedSquareIds.length, 0);
    assert.equal(second.passesMinted, 0);
    assert.equal(
      await db.admissionPass.count({ where: { eventSupporterId: supporterId } }),
      1
    );

    await cleanupBoard();
  });

  test("backfill mints what is owed, and is a no-op on a second run", async () => {
    const squares = await seedBoard(3);
    const { supporterId } = await seedClaim(squares.map((s) => s.squareId));

    // Confirm WITHOUT minting — the state a square confirmed before A8 is in.
    await db.square.updateMany({
      where: { boardId },
      data: { paymentStatus: "paid" },
    });

    const first = await db.$transaction((tx) => backfillPasses(tx, eventId));
    assert.equal(first.minted, 3);
    assert.equal(
      await db.admissionPass.count({ where: { eventSupporterId: supporterId } }),
      3
    );

    const second = await db.$transaction((tx) => backfillPasses(tx, eventId));
    assert.equal(second.minted, 0, "idempotent");

    await cleanupBoard();
  });

  test("backfill skips donated grants", async () => {
    const squares = await seedBoard(2);
    const { supporterId } = await seedClaim(
      squares.map((s) => s.squareId),
      true
    );
    await db.square.updateMany({
      where: { boardId },
      data: { paymentStatus: "paid" },
    });

    const result = await db.$transaction((tx) => backfillPasses(tx, eventId));
    assert.equal(result.minted, 0);
    assert.equal(
      await db.admissionPass.count({ where: { eventSupporterId: supporterId } }),
      0
    );

    await cleanupBoard();
  });
});
