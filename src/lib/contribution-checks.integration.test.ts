import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";

// The two contribution CHECKs that M1a moved from payment_method to settlement,
// against the REAL constraints. They live only in migration SQL, so this means
// something only against a database rebuilt by replaying migrations - see
// settlement-tender.integration.test.ts.
//
// Four things are pinned:
//
//  1. THE CATALOG. Both constraints exist under their existing names, are
//     validated, read `settlement`, and do not read `payment_method`.
//
//  2. THE DROPPED COLUMN IS GONE AND ITS TYPE IS NOT. M1b dropped
//     contributions.payment_method; the "PaymentMethod" enum stays, because
//     squares.payment_method and payment_references.method still use it.
//
//  3. NEITHER STORED PREDICATE CAN BE UNKNOWN. Each is evaluated FROM ITS OWN
//     CATALOG EXPRESSION over every combination of the columns it reads, so a
//     later rewrite that reintroduces a nullable comparison fails here. A CHECK
//     accepts UNKNOWN, which is how STRIPE + NULL got through twice
//     (payment-method addendum §8).
//
//  4. BEHAVIOUR, BY RAW SQL. While both columns existed, M1a also inserted rows
//     where payment_method and settlement DISAGREED - the only rows that tell a
//     settlement-reading constraint from a payment_method-reading one. They
//     went with the column in M1b; tests 1 and 2 hold that line now.
//
//   npm run test:db:up && npm run test:integration:contribution-checks

const url = process.env.TEST_DATABASE_URL;
const prisma = url ? new PrismaClient({ datasources: { db: { url } } }) : null;

const CARD_EMAIL = "contributions_card_requires_email";
const RAIL = "contributions_rail_is_cash_only";

type Row = {
  settlement: "STRIPE" | "OFFLINE";
  tender: "CARD" | null;
  rail: "zelle" | null;
  email: string | null;
};

const EMAIL = "case@example.invalid";

describe(
  "contribution CHECKs on settlement (integration)",
  { skip: !url && "TEST_DATABASE_URL not set" },
  () => {
    const db = prisma!;
    let hostId = "";
    let boardId = "";
    let n = 0;

    before(async () => {
      const host = await db.host.create({ data: { name: "Contribution checks fixture" } });
      hostId = host.id;
      const board = await db.board.create({
        data: {
          hostId,
          gameName: "Contribution checks",
          slug: "chk-" + randomUUID().slice(0, 8),
          boardType: "fundraiser",
          // boards_fundraiser_accepts_something refuses an empty list.
          acceptedPaymentMethods: ["card", "zelle"],
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

    // Raw SQL, not the Prisma client: the thing under test is the database.
    const insert = (r: Row) => db.$executeRaw`
      INSERT INTO contributions (board_id, status, settlement, tender,
                                 payment_rail, total_paid_cents, donation_amount_cents,
                                 contributor_name, contributor_email)
      VALUES (${boardId}::uuid, 'pending', ${r.settlement}::settlement,
              ${r.tender}::tender, ${r.rail}::payment_rail,
              100, 100, ${`check case ${++n}`}, ${r.email})`;

    const accepted = async (r: Row) => assert.equal(await insert(r), 1);
    const rejectedBy = (constraint: string) => async (r: Row) =>
      assert.rejects(() => insert(r), (e: Error) => {
        assert.match(e.message, new RegExp(constraint));
        return true;
      });

    test("both constraints are present, validated, read settlement and do not read payment_method", async () => {
      const rows = await db.$queryRaw<{ name: string; def: string; validated: boolean }[]>`
        SELECT conname AS name, pg_get_constraintdef(oid) AS def, convalidated AS validated
          FROM pg_constraint
         WHERE conrelid = 'public.contributions'::regclass
           AND conname IN (${CARD_EMAIL}, ${RAIL})
         ORDER BY conname`;
      assert.deepEqual(rows.map((r) => r.name), [CARD_EMAIL, RAIL].sort(),
        "a constraint is missing - was this database built by replaying migrations?");
      for (const r of rows) {
        assert.equal(r.validated, true, `${r.name} is not validated`);
        assert.match(r.def, /settlement = 'OFFLINE'::settlement/, `${r.name}: ${r.def}`);
        assert.doesNotMatch(r.def, /payment_method/, `${r.name} still reads payment_method`);
      }
    });

    test("contributions.payment_method is gone, and the PaymentMethod enum type is not", async () => {
      const [column] = await db.$queryRaw<{ n: bigint }[]>`
        SELECT count(*) AS n FROM pg_attribute
         WHERE attrelid = 'public.contributions'::regclass
           AND attname = 'payment_method' AND NOT attisdropped`;
      assert.equal(Number(column.n), 0, "contributions.payment_method is still present");
      // Game Day's squares.payment_method and payment_references.method still
      // use the type. Dropping a column is not dropping its type.
      const [type] = await db.$queryRaw<{ n: bigint }[]>`
        SELECT count(*) AS n FROM pg_type t
          JOIN pg_namespace ns ON ns.oid = t.typnamespace
         WHERE ns.nspname = 'public' AND t.typname = 'PaymentMethod'`;
      assert.equal(Number(type.n), 1, "the PaymentMethod enum type is gone");
    });

    // Evaluate a constraint's STORED expression over a derived table whose
    // columns carry the same names, so the predicate resolves against them.
    async function evaluate(name: string, domain: string) {
      const [{ expr }] = await db.$queryRaw<{ expr: string }[]>`
        SELECT pg_get_expr(conbin, conrelid) AS expr
          FROM pg_constraint
         WHERE conrelid = 'public.contributions'::regclass AND conname = ${name}`;
      return db.$queryRawUnsafe<{ a: string | null; b: string | null; ok: boolean | null }[]>(
        `SELECT a, b, (${expr}) AS ok FROM (${domain}) AS t`
      );
    }

    test("card_requires_email can never evaluate to UNKNOWN, and is FALSE only for STRIPE without an email", async () => {
      const rows = await evaluate(CARD_EMAIL, `
        SELECT s::text AS a, e AS b, s::settlement AS settlement, e AS contributor_email
          FROM unnest(ARRAY['STRIPE', 'OFFLINE']) s
         CROSS JOIN unnest(ARRAY[NULL, 'someone@example.invalid']::text[]) e`);
      assert.equal(rows.length, 4);
      for (const r of rows) assert.notEqual(r.ok, null, `UNKNOWN for settlement=${r.a} email=${r.b}`);
      assert.deepEqual(rows.filter((r) => r.ok === false).map((r) => [r.a, r.b]), [["STRIPE", null]]);
    });

    test("rail_is_cash_only can never evaluate to UNKNOWN, and is FALSE only for a declared rail on STRIPE", async () => {
      const rows = await evaluate(RAIL, `
        SELECT r AS a, s::text AS b, r::payment_rail AS payment_rail, s::settlement AS settlement
          FROM unnest(ARRAY[NULL, 'zelle', 'cashapp', 'venmo', 'paypal']::text[]) r
         CROSS JOIN unnest(ARRAY['STRIPE', 'OFFLINE']) s`);
      assert.equal(rows.length, 10);
      for (const r of rows) assert.notEqual(r.ok, null, `UNKNOWN for rail=${r.a} settlement=${r.b}`);
      assert.deepEqual(
        rows.filter((r) => r.ok === false).map((r) => r.a).sort(),
        ["cashapp", "paypal", "venmo", "zelle"],
        "only a declared rail with STRIPE may be rejected"
      );
      for (const r of rows.filter((r) => r.ok === false)) assert.equal(r.b, "STRIPE");
    });

    test("a STRIPE contribution without an email is rejected", () =>
      rejectedBy(CARD_EMAIL)({ settlement: "STRIPE", tender: "CARD", rail: null, email: null }));
    test("a STRIPE contribution with an email is accepted", () =>
      accepted({ settlement: "STRIPE", tender: "CARD", rail: null, email: EMAIL }));
    test("an OFFLINE contribution without an email is accepted", () =>
      accepted({ settlement: "OFFLINE", tender: null, rail: null, email: null }));
    test("a declared rail on a STRIPE contribution is rejected", () =>
      rejectedBy(RAIL)({ settlement: "STRIPE", tender: "CARD", rail: "zelle", email: EMAIL }));
    test("a declared rail on an OFFLINE contribution is accepted", () =>
      accepted({ settlement: "OFFLINE", tender: null, rail: "zelle", email: EMAIL }));
  }
);
