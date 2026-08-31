-- SignupLog.quantityAfter — magnitude for the audit trail.
-- fundraiser-signup-addendum.md §3, ruled 2026-08-31.
--
-- Direction alone cannot tell 4 -> 2 from 2 -> 0: both are CANCELLED, by the
-- same supporter, on the same slot. On a SHIFT that is harmless — a commitment
-- holds exactly one, so CANCELLED can only mean 1 -> 0. On an ITEM it loses
-- what the host is actually asking at 6am: not "did anyone cancel" but "am I
-- short, and by how much".
--
-- NOT NULL, NO DEFAULT, NO BACKFILL. Verified empty before writing this file:
-- signup_logs held 0 rows. A nullable column would reintroduce exactly the
-- special case this ruling removes, and a permanent default would make every
-- future row claim a quantity nobody wrote.
--
-- NOT A SECOND SOURCE OF CURRENT TRUTH. Invariant 39 still holds: current
-- quantity is count(helper_signup_positions) and nothing else. This records
-- what that count WAS at one instant.
--
-- ---------------------------------------------------------------------------
-- NO RLS OR GRANT STATEMENTS HERE, DELIBERATELY.
--
-- The S1 ordering rule — tables first, then REVOKE/GRANT in the same migration
-- — exists because `... ON ALL TABLES IN SCHEMA public` resolves AT EXECUTION
-- TIME and cannot cover a table created afterwards. That reasoning is about
-- CREATING RELATIONS.
--
-- This migration creates no relation. `signup_logs` already exists, already has
-- RLS enabled, and already carries `postgres=arwdDxtm | service_role=arwdDxtm`
-- with nothing for anon or authenticated. Postgres table-level privileges cover
-- every column of the table, including ones added later — column-level grants
-- are a separate mechanism this project does not use. So a new column inherits
-- the table's posture with no action.
--
-- Re-running the revokes would be a no-op that implies otherwise, and
-- re-enabling RLS on a table that already has it would suggest the column
-- somehow disturbed it. Containment at 22 relations after this is a REGRESSION
-- CHECK, not evidence of new coverage.
-- ---------------------------------------------------------------------------

-- Fails loudly rather than with Postgres's generic "column contains null
-- values" if the precondition ever stops holding between verification and
-- execution.
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM signup_logs;
  IF n > 0 THEN
    RAISE EXCEPTION
      'ABORT: signup_logs holds % row(s). quantityAfter is NOT NULL with no default and no backfill was ruled. Stop and report before changing schema.', n;
  END IF;
END $$;

ALTER TABLE "signup_logs" ADD COLUMN "quantity_after" INTEGER NOT NULL;
