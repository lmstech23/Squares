-- A1 -- the Contribution ledger.
--
-- Implements fundraiser-donations-addendum.md v2.3 section 13. ADDITIVE ONLY:
-- `squares.batch_id` and `admission_grants.square_batch_id` are RETAINED and
-- deprecated, not dropped. Dropping them is a separate later migration, after
-- the gate has passed and the application has run against `contribution_id` in
-- production. With no preview environment, a migration that both rewrites
-- ownership and destroys the source of that rewrite has no recovery path.
--
-- Order: DDL, CHECK constraints, capture, backfill, gate, containment. The gate
-- runs in this same transaction and RAISEs on failure, so any assertion failing
-- rolls the entire migration back.
--
-- WHAT THIS DOES NOT DO. It assigns ownership of existing rows and writes no
-- amount anywhere. `final_raised_cents`, `final_prize_pool_cents` and every
-- square's `price_paid_cents` are untouched -- invariants 4, 13 and 68 hold
-- through it. `final_prize_basis_cents` is added and deliberately left NULL on
-- boards finalized before A1: their basis cannot be reconstructed, and inferring
-- one into a finalized money column is what those invariants exist to prevent.

-- CreateEnum
CREATE TYPE "contribution_status" AS ENUM ('pending', 'confirmed', 'released');

-- AlterTable
ALTER TABLE "admission_grants" ADD COLUMN     "contribution_id" UUID;

-- AlterTable
ALTER TABLE "boards" ADD COLUMN     "final_prize_basis_cents" INTEGER;

-- AlterTable
ALTER TABLE "squares" ADD COLUMN     "contribution_id" UUID;

-- CreateTable
CREATE TABLE "contributions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "board_id" UUID NOT NULL,
    "status" "contribution_status" NOT NULL DEFAULT 'pending',
    "payment_method" "PaymentMethod" NOT NULL,
    "square_amount_cents" INTEGER NOT NULL DEFAULT 0,
    "donation_amount_cents" INTEGER NOT NULL DEFAULT 0,
    "total_paid_cents" INTEGER NOT NULL,
    "checkout_session_id" TEXT,
    "hold_expires_at" TIMESTAMPTZ(6),
    "contributor_name" TEXT NOT NULL,
    "contributor_email" TEXT,
    "contributor_phone" TEXT,
    "is_host_entry" BOOLEAN NOT NULL DEFAULT false,
    "display_anonymous" BOOLEAN NOT NULL DEFAULT false,
    "confirmed_at" TIMESTAMPTZ(6),
    "released_at" TIMESTAMPTZ(6),
    "recorded_by_host_id" UUID,
    "confirmed_by_host_id" UUID,
    "voided_at" TIMESTAMPTZ(6),
    "voided_by_host_id" UUID,
    "void_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contributions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_contributions_board_status" ON "contributions"("board_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "contributions_checkout_session_key" ON "contributions"("checkout_session_id");

-- CreateIndex
CREATE UNIQUE INDEX "admission_grants_contribution_key" ON "admission_grants"("contribution_id");

-- CreateIndex
CREATE INDEX "idx_squares_contribution" ON "squares"("contribution_id");

-- AddForeignKey
ALTER TABLE "squares" ADD CONSTRAINT "squares_contribution_id_fkey" FOREIGN KEY ("contribution_id") REFERENCES "contributions"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "admission_grants" ADD CONSTRAINT "admission_grants_contribution_id_fkey" FOREIGN KEY ("contribution_id") REFERENCES "contributions"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "contributions" ADD CONSTRAINT "contributions_board_id_fkey" FOREIGN KEY ("board_id") REFERENCES "boards"("board_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- ---------------------------------------------------------------------------
-- CHECK constraints -- donations section 5.
-- ---------------------------------------------------------------------------

ALTER TABLE "contributions" ADD CONSTRAINT "contributions_total_is_sum"
  CHECK (total_paid_cents = square_amount_cents + donation_amount_cents);

ALTER TABLE "contributions" ADD CONSTRAINT "contributions_amounts_non_negative"
  CHECK (square_amount_cents >= 0 AND donation_amount_cents >= 0);

ALTER TABLE "contributions" ADD CONSTRAINT "contributions_amount_positive"
  CHECK (square_amount_cents > 0 OR donation_amount_cents > 0);

-- Card requires an email; cash may omit it (donations section 10).
--
-- SNAPSHOT-VALIDATED, NOT STRUCTURALLY GUARANTEED. A read-only production
-- preflight on 2026-09-04 found ZERO eligible squares with a null
-- `player_email` -- 33 cash and 5 stripe, all populated -- so no contribution
-- backfilled from today's data can violate this.
--
-- That is a fact about the current rows, not a promise from the schema.
-- `squares.player_email` is nullable and always has been, so legacy data
-- containing a stripe batch with no email is possible in principle.
--
-- IF THAT EVER HAPPENS, THIS CHECK FAILS AND THE MIGRATION ABORTS. That is the
-- intended behaviour, not a defect: the alternative is silently writing a
-- Contribution with no way to reach the contributor, on a card payment where
-- an email is the only channel there is. A loud failure asks a human what the
-- right answer is; a silent one decides for them.
ALTER TABLE "contributions" ADD CONSTRAINT "contributions_card_requires_email"
  CHECK (payment_method = 'cash' OR contributor_email IS NOT NULL);

-- A void records itself and never changes `status` (donations section 7).
ALTER TABLE "contributions" ADD CONSTRAINT "contributions_void_fields_together"
  CHECK ((voided_at IS NULL AND voided_by_host_id IS NULL AND void_reason IS NULL)
      OR (voided_at IS NOT NULL AND voided_by_host_id IS NOT NULL));

-- The donation-on-a-Game-Day-board rule is API-level plus a periodic assertion.
-- `board_type` lives on `boards` and a CHECK cannot reach it; donations section
-- 5 says so explicitly. Nothing is enforced here.

-- ---------------------------------------------------------------------------
-- Backfill and correctness gate -- donations 13.1 and 13.2.
-- Same transaction. Any assertion failing aborts the migration.
-- ---------------------------------------------------------------------------
DO $a1$
DECLARE
  expected_attached      INTEGER;
  expected_grants        INTEGER;
  expected_contributions INTEGER;
  mixed_batches          INTEGER;
  actual                 INTEGER;
  bad                    INTEGER;
  pre_confirmed          JSONB;
  post_confirmed         JSONB;
  pre_finals             JSONB;
  post_finals            JSONB;
BEGIN
  ------------------------------------------------------------------ CAPTURE --
  -- PARAMETERISED, not hardcoded. v2.2 embedded production's 38 and 13, which
  -- cannot pass against a rehearsal database. These use the same predicate as
  -- the backfill, so the two cannot drift apart.
  SELECT count(*) INTO expected_attached
    FROM squares s JOIN boards b ON b.board_id = s.board_id
   WHERE b.board_type = 'fundraiser'
     AND s.batch_id IS NOT NULL
     AND s.payment_status <> 'open';

  SELECT count(*) INTO expected_grants
    FROM admission_grants WHERE square_batch_id IS NOT NULL;

  SELECT count(*) INTO expected_contributions FROM (
    SELECT s.board_id, s.batch_id
      FROM squares s JOIN boards b ON b.board_id = s.board_id
     WHERE b.board_type = 'fundraiser'
       AND s.batch_id IS NOT NULL
       AND s.payment_status <> 'open'
     GROUP BY s.board_id, s.batch_id) t;

  -- Per-board confirmed square money, for assertion 1. FUNDRAISER BOARDS ONLY:
  -- Game Day is outside A1 Contribution validation entirely and is not visited.
  SELECT COALESCE(jsonb_object_agg(board_id::text, cents), '{}'::jsonb)
    INTO pre_confirmed
    FROM (SELECT s.board_id, COALESCE(sum(s.price_paid_cents), 0) AS cents
            FROM squares s JOIN boards b ON b.board_id = s.board_id
           WHERE b.board_type = 'fundraiser' AND s.payment_status = 'paid'
           GROUP BY s.board_id) x;

  -- Finalized money, for assertion 7 -- captured for EVERY board carrying
  -- finals, not one hardcoded slug, so the assertion travels to any database.
  SELECT COALESCE(jsonb_object_agg(board_id::text,
           jsonb_build_array(final_raised_cents, final_prize_pool_cents)), '{}'::jsonb)
    INTO pre_finals FROM boards
   WHERE final_raised_cents IS NOT NULL OR final_prize_pool_cents IS NOT NULL;

  RAISE NOTICE 'A1 capture: attached=% grants=% contributions=%',
    expected_attached, expected_grants, expected_contributions;

  ------------------------------------------------- payment-method homogeneity --
  -- Verified zero on production 2026-09-04, but that is a snapshot property and
  -- not a schema guarantee. Fail loudly rather than pick a method.
  SELECT count(*) INTO mixed_batches FROM (
    SELECT s.board_id, s.batch_id
      FROM squares s JOIN boards b ON b.board_id = s.board_id
     WHERE b.board_type = 'fundraiser'
       AND s.batch_id IS NOT NULL AND s.payment_status <> 'open'
     GROUP BY s.board_id, s.batch_id
    HAVING count(DISTINCT s.payment_method) > 1) m;
  IF mixed_batches > 0 THEN
    RAISE EXCEPTION 'A1 aborted: % batch(es) mix payment methods; donations 13.1 assumes homogeneity', mixed_batches;
  END IF;

  ----------------------------------------------------------------- BACKFILL --
  -- One Contribution per eligible (board_id, batch_id). ELIGIBLE means: on a
  -- fundraiser board, carrying a batch_id, with at least one NON-OPEN square.
  --
  -- An `open` square carrying a stale batch_id from a released hold produces
  -- NOTHING. It holds no money and never completed; a ledger row for it would
  -- invent a contribution that never happened.
  --
  -- confirmed_at = MIN(payment_references.timestamp) across the batch's
  -- non-open squares, NULL where the batch has none. `claimed_at` is NEVER
  -- used: it records when a square left `open`, which on a cash reservation
  -- precedes confirmation by days.
  -- A TEMPORARY KEY, not a heuristic. An earlier draft matched contributions
  -- back to batches by (board_id, amount, contributor_name), which collides the
  -- moment one board has two batches of the same size from the same person. The
  -- column is added, used, and dropped inside this transaction.
  ALTER TABLE contributions ADD COLUMN a1_batch_id TEXT;

  INSERT INTO contributions (
    board_id, status, payment_method,
    square_amount_cents, donation_amount_cents, total_paid_cents,
    contributor_name, contributor_email, contributor_phone,
    is_host_entry, confirmed_at, recorded_by_host_id, confirmed_by_host_id,
    a1_batch_id)
  SELECT e.board_id,
         CASE WHEN e.any_paid THEN 'confirmed'::contribution_status
              ELSE 'pending'::contribution_status END,
         e.method::"PaymentMethod",
         COALESCE(e.cents, 0), 0, COALESCE(e.cents, 0),
         COALESCE(e.pname, 'Unknown'), e.pemail, e.pphone,
         COALESCE(e.host_entry, false),
         CASE WHEN e.any_paid THEN e.confirmed_at ELSE NULL END,
         -- Actor fields backfill to NULL, never to the board owner. Nothing
         -- recorded who did this, and a plausible guess written into an audit
         -- column is worse than an honest gap. Invariant 103 governs rows
         -- created after A1 and is not retroactive.
         NULL, NULL,
         e.batch_id
    FROM (
      SELECT s.board_id, s.batch_id,
             bool_or(s.payment_status = 'paid')          AS any_paid,
             min(s.payment_method::text)                 AS method,
             sum(s.price_paid_cents)                     AS cents,
             min(s.player_name)                          AS pname,
             min(s.player_email)                         AS pemail,
             min(s.player_phone)                         AS pphone,
             bool_or(s.is_host_entry)                    AS host_entry,
             min(pr.timestamp)                           AS confirmed_at
        FROM squares s
        JOIN boards b ON b.board_id = s.board_id
        LEFT JOIN payment_references pr ON pr.square_id = s.square_id
       WHERE b.board_type = 'fundraiser'
         AND s.batch_id IS NOT NULL
         AND s.payment_status <> 'open'
       GROUP BY s.board_id, s.batch_id
    ) e;

  GET DIAGNOSTICS actual = ROW_COUNT;
  RAISE NOTICE 'A1 backfill: % contribution(s) created', actual;

  -- Attach NON-OPEN squares only. Exact join on the temporary key.
  UPDATE squares s SET contribution_id = c.id
    FROM contributions c
   WHERE c.board_id = s.board_id
     AND c.a1_batch_id = s.batch_id
     AND s.payment_status <> 'open';

  -- AdmissionGrant relink: square_batch_id -> contribution_id.
  UPDATE admission_grants g SET contribution_id = c.id
    FROM contributions c
   WHERE c.a1_batch_id = g.square_batch_id;

  ALTER TABLE contributions DROP COLUMN a1_batch_id;

  --------------------------------------------------------------------- GATE --
  -- 1. Per fundraiser board, confirmed contribution money equals the
  --    pre-migration confirmed square total. Game Day is not visited.
  SELECT COALESCE(jsonb_object_agg(board_id::text, cents), '{}'::jsonb)
    INTO post_confirmed
    FROM (SELECT c.board_id, COALESCE(sum(c.total_paid_cents), 0) AS cents
            FROM contributions c
           WHERE c.status = 'confirmed' AND c.voided_at IS NULL
           GROUP BY c.board_id) y;
  IF pre_confirmed <> post_confirmed THEN
    RAISE EXCEPTION 'A1 gate 1 FAILED: confirmed money moved. before=% after=%',
      pre_confirmed, post_confirmed;
  END IF;

  -- 2. Every non-open square with a batch_id has a contribution_id.
  SELECT count(*) INTO actual
    FROM squares s JOIN boards b ON b.board_id = s.board_id
   WHERE b.board_type = 'fundraiser' AND s.batch_id IS NOT NULL
     AND s.payment_status <> 'open' AND s.contribution_id IS NOT NULL;
  IF actual <> expected_attached THEN
    RAISE EXCEPTION 'A1 gate 2 FAILED: attached % of expected %', actual, expected_attached;
  END IF;

  -- 3. HARD ZERO, in every environment. Not parameterised: zero is a rule, and
  --    deriving it from the database would make it self-fulfilling.
  SELECT count(*) INTO bad FROM squares
   WHERE payment_status = 'open' AND contribution_id IS NOT NULL;
  IF bad <> 0 THEN
    RAISE EXCEPTION 'A1 gate 3 FAILED: % open square(s) carry a contribution_id', bad;
  END IF;

  -- 4. Every grant with a square_batch_id resolves, and points at the
  --    contribution owning the squares that minted its passes.
  SELECT count(*) INTO actual
    FROM admission_grants WHERE square_batch_id IS NOT NULL AND contribution_id IS NOT NULL;
  IF actual <> expected_grants THEN
    RAISE EXCEPTION 'A1 gate 4 FAILED: relinked % of expected % grant(s)', actual, expected_grants;
  END IF;

  SELECT count(*) INTO bad
    FROM admission_grants g
   WHERE g.contribution_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM squares s
                      WHERE s.contribution_id = g.contribution_id
                        AND s.batch_id = g.square_batch_id);
  IF bad <> 0 THEN
    RAISE EXCEPTION 'A1 gate 4 FAILED: % grant(s) point at a contribution that does not own their batch', bad;
  END IF;

  -- 5. Uniqueness. Structurally guaranteed by admission_grants_contribution_key
  --    and by admission_grants_square_batch_key upstream; asserted on real rows.
  SELECT count(*) INTO bad FROM (
    SELECT contribution_id FROM admission_grants
     WHERE contribution_id IS NOT NULL
     GROUP BY contribution_id HAVING count(*) > 1) d;
  IF bad <> 0 THEN
    RAISE EXCEPTION 'A1 gate 5 FAILED: % duplicated contribution_id on grants', bad;
  END IF;

  -- 6. Same eligibility predicate as the backfill. v2.2 omitted the non-open
  --    filter and would have aborted a correct migration.
  SELECT count(*) INTO actual FROM contributions;
  IF actual <> expected_contributions THEN
    RAISE EXCEPTION 'A1 gate 6 FAILED: % contribution(s), expected %', actual, expected_contributions;
  END IF;

  -- 7. Finalized money is byte-identical, on every board carrying finals.
  SELECT COALESCE(jsonb_object_agg(board_id::text,
           jsonb_build_array(final_raised_cents, final_prize_pool_cents)), '{}'::jsonb)
    INTO post_finals FROM boards
   WHERE final_raised_cents IS NOT NULL OR final_prize_pool_cents IS NOT NULL;
  IF pre_finals <> post_finals THEN
    RAISE EXCEPTION 'A1 gate 7 FAILED: finalized money changed. before=% after=%',
      pre_finals, post_finals;
  END IF;

  RAISE NOTICE 'A1 gate: all 7 assertions passed';
END
$a1$;

-- ---------------------------------------------------------------------------
-- Containment. LAST, and in this same transaction -- same shape as S1.
-- ---------------------------------------------------------------------------

ALTER TABLE public."contributions" ENABLE ROW LEVEL SECURITY;

-- Zero client policies, deliberately. Nothing authenticates as anon or
-- authenticated against this table; every read is server-side through Prisma.
REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC, anon, authenticated;

GRANT ALL ON ALL TABLES    IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;
