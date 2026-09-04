#!/usr/bin/env node
// scripts/seed-dev-fixtures.mts
// ============================================================================
// SYNTHETIC STRUCTURAL FIXTURES for the development database.
//
// NOT A PRODUCTION COPY. Nothing here is derived from production. No real
// contributor names, emails or phone numbers; no live Stripe ids; no
// PaymentReference rows carrying real charge ids; no dump, no restore.
//
// The point is to reproduce the SHAPES a migration has to survive — a paid
// batch, a cash reservation, a legacy batch_id with no contribution, an
// admission grant keyed to square_batch_id, and a closed board with finalized
// money. Volume is irrelevant; only structure is.
//
// REFUSES TO RUN AGAINST PRODUCTION. The guard is invoked first, and the seed
// re-checks the project ref itself, because a fixture script that ran against
// the live database would be the single worst outcome in this repository.
// ============================================================================

import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

const PROD_PROJECT_REF = "xfmonzvdlxbeskugrjmk";

for (const v of [process.env.DATABASE_URL, process.env.DIRECT_URL]) {
  if (v?.includes(PROD_PROJECT_REF)) {
    console.error("\n  REFUSED — this points at the production project. Never seed production.\n");
    process.exit(1);
  }
}
if (!process.env.DATABASE_URL) {
  console.error("\n  REFUSED — DATABASE_URL is not set.\n");
  process.exit(1);
}

const prisma = new PrismaClient();

/** Synthetic identities. Obviously fake, and .invalid can never resolve. */
const person = (n: string) => ({
  name: `Fixture ${n}`,
  email: `fixture-${n.toLowerCase()}@example.invalid`,
  phone: "+15550000000",
});

async function main() {
  const host = await prisma.host.create({
    data: { name: "Fixture Host", email: "host@example.invalid", boardCredits: 10 },
  });

  // ---- Board A: open fundraiser with an event -----------------------------
  const boardA = await prisma.board.create({
    data: {
      hostId: host.id,
      gameName: "Fixture Open Fundraiser",
      slug: `fx-open-${Date.now()}`,
      boardType: "fundraiser",
      squarePrice: 2500,
      prizePoolPercent: 0,
      timezone: "America/New_York",
      status: "open",
    },
  });
  const eventA = await prisma.event.create({
    data: {
      boardId: boardA.boardId,
      startsAt: new Date(Date.now() + 30 * 86400_000),
      timezone: "America/New_York",
    },
  });
  await prisma.square.createMany({
    data: Array.from({ length: 25 }, (_, i) => ({
      boardId: boardA.boardId, position: i, paymentStatus: "open" as const,
    })),
  });
  const squaresA = await prisma.square.findMany({
    where: { boardId: boardA.boardId }, orderBy: { position: "asc" },
  });

  // FIXTURE 1 — paid fundraiser batch. Four squares, one batch, one supporter.
  const paidBatch = randomUUID();
  const p1 = person("Paid");
  await prisma.square.updateMany({
    where: { squareId: { in: squaresA.slice(0, 4).map((s) => s.squareId) } },
    data: {
      paymentStatus: "paid", playerName: p1.name, playerEmail: p1.email,
      playerPhone: p1.phone, pricePaidCents: 2500, batchId: paidBatch,
      claimedAt: new Date(),
    },
  });
  const supporterA = await prisma.eventSupporter.create({
    data: {
      eventId: eventA.id, identityKey: p1.email, name: p1.name,
      email: p1.email, status: "active",
    },
  });

  // FIXTURE 4 — admission grant keyed to the LEGACY square_batch_id. This is
  // the row the contributionId migration has to carry forward.
  await prisma.admissionGrant.create({
    data: {
      eventId: eventA.id,
      eventSupporterId: supporterA.id,
      squareBatchId: paidBatch,
      source: "FUNDRAISER",
      declaredAtPurchase: 4,
    },
  });

  // FIXTURE 1b — PaymentReference rows for the PAID batch only.
  //
  // A1 derives `Contribution.confirmedAt` from MIN(PaymentReference.timestamp)
  // over the batch's non-open squares, and null where the batch has none
  // (donations addendum §13.1, ruled 2026-09-04). Both paths need exercising, so
  // exactly one batch gets payment references and the others deliberately do
  // not:
  //
  //   paid batch          -> 2 rows, 90 and 45 minutes ago. MIN is the older.
  //   reserved_cash batch -> none. Cash is not confirmed; there is no payment.
  //   closed paid batch   -> none. Mirrors production, where the
  //                          resolveExpiredHolds cron confirms squares without
  //                          writing a PaymentReference — which is why 21 of 38
  //                          production rows have none.
  //
  // Synthetic ids only. No Stripe call is made and no real session exists.
  const paidSquares = squaresA.slice(0, 2);
  const t0 = new Date(Date.now() - 90 * 60_000);
  const t1 = new Date(Date.now() - 45 * 60_000);
  await prisma.paymentReference.createMany({
    data: [
      { squareId: paidSquares[0].squareId, stripeSessionId: `cs_test_fixture_${randomUUID().slice(0, 12)}`,
        amount: 2500, method: "stripe", timestamp: t0 },
      { squareId: paidSquares[1].squareId, stripeSessionId: `cs_test_fixture_${randomUUID().slice(0, 12)}`,
        amount: 2500, method: "stripe", timestamp: t1 },
    ],
  });

  // FIXTURE 2 — reserved_cash batch. Priced at reservation, not yet confirmed.
  const cashBatch = randomUUID();
  const p2 = person("Cash");
  await prisma.square.updateMany({
    where: { squareId: { in: squaresA.slice(4, 7).map((s) => s.squareId) } },
    data: {
      paymentStatus: "reserved_cash", playerName: p2.name, playerEmail: p2.email,
      pricePaidCents: 2000, batchId: cashBatch, claimedAt: new Date(),
    },
  });

  // FIXTURE 3 — stale OPEN square still carrying a legacy batch_id. Left behind
  // by a released hold. Production has these; a migration that assumes
  // batch_id implies a contribution will trip on exactly this row.
  await prisma.square.update({
    where: { squareId: squaresA[7].squareId },
    data: { batchId: randomUUID(), paymentStatus: "open", releaseReason: "expired" },
  });

  // ---- Board B: CLOSED fundraiser with finalized money --------------------
  // FIXTURE 5. Money is final here. Any migration that rewrites square money on
  // a closed board is rewriting the history of a completed campaign.
  const boardB = await prisma.board.create({
    data: {
      hostId: host.id,
      gameName: "Fixture Closed Fundraiser",
      slug: `fx-closed-${Date.now()}`,
      boardType: "fundraiser",
      squarePrice: 1000,
      prizePoolPercent: 20,
      timezone: "America/New_York",
      status: "closed",
      finalPrizePoolCents: 1000,
    },
  });
  await prisma.square.createMany({
    data: Array.from({ length: 10 }, (_, i) => ({
      boardId: boardB.boardId, position: i, paymentStatus: "open" as const,
    })),
  });
  const squaresB = await prisma.square.findMany({
    where: { boardId: boardB.boardId }, orderBy: { position: "asc" },
  });
  const closedBatch = randomUUID();
  const p3 = person("Closed");
  await prisma.square.updateMany({
    where: { squareId: { in: squaresB.slice(0, 5).map((s) => s.squareId) } },
    data: {
      paymentStatus: "paid", playerName: p3.name, playerEmail: p3.email,
      pricePaidCents: 1000, batchId: closedBatch, claimedAt: new Date(),
    },
  });

  // ---- Board C: Game Day, to prove migrations leave it alone --------------
  const boardC = await prisma.board.create({
    data: {
      hostId: host.id, gameName: "Fixture Game Day", slug: `fx-game-${Date.now()}`,
      boardType: "game", squarePrice: 500, timezone: "America/New_York", status: "open",
    },
  });
  await prisma.square.createMany({
    data: Array.from({ length: 100 }, (_, i) => ({
      boardId: boardC.boardId, position: i, paymentStatus: "open" as const,
    })),
  });

  console.log("\n  SYNTHETIC FIXTURES CREATED\n");
  console.log(`  1  paid fundraiser batch          4 squares @ 2500  batch ${paidBatch.slice(0, 8)}`);
  console.log(`  2  reserved_cash batch            3 squares @ 2000  batch ${cashBatch.slice(0, 8)}`);
  console.log(`  3  stale open square, legacy batch_id, releaseReason expired`);
  console.log(`  4  admission grant on square_batch_id  declaredAtPurchase 4, supporter active`);
  console.log(`  5  closed fundraiser, finalPrizePoolCents 1000, 5 paid @ 1000`);
  console.log(`  1b 2 PaymentReference rows on the paid batch only — MIN ${t0.toISOString()}`);
  console.log(`     reserved_cash and closed batches deliberately have none (null confirmedAt path)`);
  console.log(`  +  Game Day board, 100 open squares, untouched control\n`);
  console.log(`  No production data. No real PII. No Stripe ids. No PaymentReference rows.\n`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
