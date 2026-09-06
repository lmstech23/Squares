-- Gap 2 -- the confirmation-email claim column for contributions.
--
-- WHY A COLUMN AND NOT A FLAG IN CODE. The confirmation sender's entire safety
-- model is an ATOMIC CLAIM: `UPDATE ... SET confirmation_emailed_at = now()
-- WHERE confirmation_emailed_at IS NULL RETURNING *` stamps and reports only
-- the rows that one statement changed. The five-minute cron sweeps globally
-- while the Stripe webhook fires on confirmation, so two invocations can select
-- the same work; the claim is what makes exactly one of them win. `squares` has
-- had this column since add_confirmation_emailed_at.sql. `contributions` has
-- not, which is why a donation could not be added to the sender at all.
--
-- ADDITIVE ONLY. One nullable column, no constraint, no index, nothing dropped.
--
-- THE BACKFILL IS THE POINT OF THIS MIGRATION, not a tidy-up. Without it every
-- donation ever confirmed is claimable the moment the sender ships, and the
-- first cron run -- within five minutes -- emails a receipt to everyone who has
-- ever donated, for money they gave days or weeks ago. Stamping them closes
-- that window before it can open.
--
-- COALESCE(confirmed_at, created_at) is deliberate, not defensive. A1 set
-- confirmed_at = MIN(payment_references.timestamp) across a batch and left it
-- NULL where the batch had none, so `status = 'confirmed' AND confirmed_at IS
-- NULL` rows genuinely exist. Stamping only on confirmed_at would leave exactly
-- those rows claimable -- the oldest ones, and the ones whose contributors are
-- least expecting a receipt.
--
-- DEPLOY ORDER, which this migration cannot enforce and the runbook must:
-- apply this FIRST, verify zero claimable historical rows, and only then ship
-- the sender. Between the two the old sender is running and reads no such
-- column, so the gap is safe for any length of time. The reverse order is not:
-- a sender deployed against a missing column fails every sweep.

ALTER TABLE "contributions"
  ADD COLUMN "confirmation_emailed_at" TIMESTAMPTZ;

-- Everything already confirmed is treated as already delivered.
UPDATE "contributions"
   SET "confirmation_emailed_at" = COALESCE("confirmed_at", "created_at")
 WHERE "status" = 'confirmed'
   AND "confirmation_emailed_at" IS NULL;

-- GATE. Runs in the same transaction, so a failure rolls the column back with
-- it rather than leaving a half-armed table.
DO $$
DECLARE
  claimable INTEGER;
BEGIN
  SELECT count(*) INTO claimable
    FROM contributions
   WHERE status = 'confirmed'
     AND confirmation_emailed_at IS NULL;

  IF claimable > 0 THEN
    RAISE EXCEPTION
      'Gap 2 aborted: % already-confirmed contribution(s) left claimable; the first sweep would email them',
      claimable;
  END IF;
END $$;
