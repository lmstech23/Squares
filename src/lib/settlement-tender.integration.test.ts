import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";

// The six settlement/tender pairs, against the REAL constraint.
//
// contributions_settlement_tender_valid lives only in migration SQL - Prisma
// cannot express a CHECK - so these cases mean something only against a
// database REBUILT BY REPLAYING MIGRATIONS (npm run test:db:up). Provisioned
// with `db push`, the constraint is absent and all six inserts succeed. The
// first test reads the constraint from the catalog and fails loudly if it is
// missing or compares the nullable `tender` with a plain `=` or `<>`, rather
// than letting the six pass or fail for a reason that has nothing to do with
// them.
//
// STRIPE + NULL COMES FIRST ON PURPOSE. It is the one row the constraint exists
// to stop, and it got through twice: once as an equality between two boolean
// tests, once as enumerated pairs compared with `=`. A CHECK rejects only
// FALSE, and a comparison against a null is UNKNOWN. Payment-method addendum §8.
//
// Raw SQL, not the Prisma client, so the thing under test is the database.
//
//   npm run test:db:up && npm run test:integration:settlement

const url = process.env.TEST_DATABASE_URL;
const prisma = url ? new PrismaClient({ datasources: { db: { url } } }) : null;

const CASES = [
  { settlement: "STRIPE", tender: null, legal: false },
  { settlement: "STRIPE", tender: "CASH", legal: false },
  { settlement: "OFFLINE", tender: "CARD", legal: false },
  { settlement: "STRIPE", tender: "CARD", legal: true },
  { settlement: "OFFLINE", tender: "ZELLE", legal: true },
  { settlement: "OFFLINE", tender: null, legal: true },
] as const;

describe(
  "settlement/tender constraint (integration)",
  { skip: !url && "TEST_DATABASE_URL not set" },
  () => {
    const db = prisma!;
    let hostId = "";
    let boardId = "";

    before(async () => {
      const host = await db.host.create({ data: { name: "Settlement fixture" } });
      hostId = host.id;
      const board = await db.board.create({
        data: {
          hostId,
          gameName: "Settlement",
          slug: "stl-" + randomUUID().slice(0, 8),
          boardType: "fundraiser",
          // boards_fundraiser_accepts_something refuses an empty list.
          acceptedPaymentMethods: ["card"],
          squarePrice: 5000,
          totalSquares: 4,
          timezone: "America/New_York",
          campaignEndsAt: new Date(Date.now() + 7 * 864e5),
        },
      });
      boardId = board.boardId;
    });

    after(async () => {
      await db.contribution.deleteMany({ where: { boardId } });
      await db.board.deleteMany({ where: { boardId } });
      await db.host.deleteMany({ where: { id: hostId } });
      await db.$disconnect();
    });

    test("the constraint is present, validated and null-safe - otherwise this database was not built by replaying migrations", async () => {
      const rows = await db.$queryRaw<{ def: string; validated: boolean }[]>`
        SELECT pg_get_constraintdef(c.oid) AS def, c.convalidated AS validated
          FROM pg_constraint c
         WHERE c.conrelid = 'public.contributions'::regclass
           AND c.conname = 'contributions_settlement_tender_valid'`;
      assert.equal(
        rows.length,
        1,
        "contributions_settlement_tender_valid is missing. This test database was not " +
          "rebuilt by replaying prisma/migrations - db push does not preserve migration-only " +
          "CHECK constraints. Run npm run test:db:up."
      );
      assert.equal(rows[0].validated, true);
      assert.match(rows[0].def, /tender IS DISTINCT FROM 'CARD'::tender/);
      assert.doesNotMatch(
        rows[0].def,
        /\btender (?:=|<>) /,
        "a plain comparison against the nullable tender is UNKNOWN on NULL, and a CHECK accepts UNKNOWN"
      );
    });

    for (const [i, c] of CASES.entries()) {
      const name = `${c.settlement} + ${c.tender ?? "NULL"}`;
      test(`${i + 1}. ${name} is ${c.legal ? "accepted" : "rejected"} by the database`, async () => {
        const insert = () => db.$executeRaw`
          INSERT INTO contributions (board_id, status, payment_method, settlement, tender,
                                     total_paid_cents, donation_amount_cents,
                                     contributor_name, contributor_email)
          VALUES (${boardId}::uuid, 'pending',
                  ${c.settlement === "STRIPE" ? "stripe" : "cash"}::"PaymentMethod",
                  ${c.settlement}::settlement, ${c.tender}::tender,
                  100, 100, ${`case ${i + 1}: ${name}`}, 'case@example.invalid')`;
        if (c.legal) {
          assert.equal(await insert(), 1);
        } else {
          await assert.rejects(insert, (e: Error) => {
            assert.match(e.message, /contributions_settlement_tender_valid/);
            return true;
          });
        }
      });
    }
  }
);
