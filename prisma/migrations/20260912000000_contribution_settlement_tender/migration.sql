-- Payment method, M0 — expand: schema + writers.
-- fundraiser-payment-method-addendum.md v1.2.3 §8, §9. Invariants are cited
-- by name; the registry holds the numbers.
--
-- EXPAND, NOT CONTRACT. Adds `settlement`, `tender`, `tender_reference`,
-- `recorded_at` and `tender_correction_log`. `payment_method` stays: every
-- writer dual-writes it beside `settlement` until M1 moves the reads and drops
-- it. Nothing here changes a read.
--
-- ORDER IS LOAD-BEARING. The columns land nullable, the backfill runs, the
-- assertions check it, and only then do NOT NULL and the CHECK arrive. A CHECK
-- added before the backfill would reject every existing row.
--
-- OFFLINE ROWS ARE NOT BACKFILLED TO CASH. Most were cash and some were not,
-- and afterwards nobody could tell which rows a host asserted from which a
-- migration invented. NULL renders as "recorded by host" and says only what
-- is known.

-- ------------------------------------------------------------------- types --
CREATE TYPE "settlement" AS ENUM ('STRIPE', 'OFFLINE');
CREATE TYPE "tender" AS ENUM ('CARD', 'CASH', 'VENMO', 'ZELLE', 'CASHAPP', 'PAYPAL', 'CHECK', 'OTHER');
CREATE TYPE "tender_correction_field" AS ENUM ('TENDER', 'REFERENCE');

-- ----------------------------------------------------------------- columns --
-- All nullable here. `settlement` becomes NOT NULL after the backfill.
ALTER TABLE public.contributions
  ADD COLUMN settlement       "settlement",
  ADD COLUMN tender           "tender",
  ADD COLUMN tender_reference text,
  ADD COLUMN recorded_at      timestamptz(6);

-- ---------------------------------------------------------- correction log --
-- Written from M4; empty until then. The FKs are NOT NULL under RESTRICT, the
-- signup_logs convention: the trail is kept by refusing to delete what it
-- names, never by nulling the reference.
CREATE TABLE public.tender_correction_log (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contribution_id uuid NOT NULL,
  host_id         uuid NOT NULL,
  field           "tender_correction_field" NOT NULL,
  old_value       text,
  new_value       text,
  created_at      timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT tender_correction_log_contribution_id_fkey
    FOREIGN KEY (contribution_id) REFERENCES public.contributions(id)
    ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT tender_correction_log_host_id_fkey
    FOREIGN KEY (host_id) REFERENCES public.hosts(id)
    ON DELETE RESTRICT ON UPDATE NO ACTION
);

CREATE INDEX idx_tender_correction_log_contribution_created
  ON public.tender_correction_log (contribution_id, created_at);

-- ---------------------------------------------------------------- backfill --
UPDATE public.contributions SET settlement = 'STRIPE', tender = 'CARD'
 WHERE payment_method = 'stripe';

UPDATE public.contributions SET settlement = 'OFFLINE'
 WHERE payment_method = 'cash';

-- -------------------------------------------------------------- assertions --
-- STRUCTURAL, NEVER A HARD-CODED COUNT. The split differs by database, and a
-- number written here is wrong the day after it was checked. Production's
-- expected split is confirmed read-only before the production apply, not here.
-- Any failure raises, and the whole migration rolls back with it.
DO $$
DECLARE
  bad_stripe integer;
  bad_cash   integer;
  bad_method integer;
  unsettled  integer;
  n_stripe   integer;
  n_offline  integer;
BEGIN
  SELECT count(*) INTO bad_stripe FROM public.contributions
   WHERE payment_method = 'stripe'
     AND (settlement IS DISTINCT FROM 'STRIPE' OR tender IS DISTINCT FROM 'CARD');
  IF bad_stripe > 0 THEN
    RAISE EXCEPTION 'settlement backfill aborted: % stripe row(s) did not map to STRIPE + CARD', bad_stripe;
  END IF;

  SELECT count(*) INTO bad_cash FROM public.contributions
   WHERE payment_method = 'cash'
     AND (settlement IS DISTINCT FROM 'OFFLINE' OR tender IS NOT NULL);
  IF bad_cash > 0 THEN
    RAISE EXCEPTION 'settlement backfill aborted: % cash row(s) did not map to OFFLINE + NULL', bad_cash;
  END IF;

  SELECT count(*) INTO bad_method FROM public.contributions
   WHERE payment_method::text NOT IN ('stripe', 'cash');
  SELECT count(*) INTO unsettled FROM public.contributions
   WHERE settlement IS NULL;
  IF bad_method > 0 OR unsettled > 0 THEN
    RAISE EXCEPTION 'settlement backfill aborted: % row(s) with a payment_method other than stripe or cash, % row(s) with no settlement', bad_method, unsettled;
  END IF;

  SELECT count(*) FILTER (WHERE settlement = 'STRIPE'),
         count(*) FILTER (WHERE settlement = 'OFFLINE')
    INTO n_stripe, n_offline
    FROM public.contributions;
  RAISE NOTICE 'settlement backfill: % STRIPE + CARD, % OFFLINE + NULL', n_stripe, n_offline;
END $$;

-- ----------------------------------------------------------------- enforce --
ALTER TABLE public.contributions ALTER COLUMN settlement SET NOT NULL;

-- "Settlement and tender pair only as enumerated." The legal pairs, written
-- out, and EVERY comparison against the nullable `tender` NULL-SAFE. A CHECK
-- rejects only FALSE: a plain `tender = 'CARD'` against a null is UNKNOWN, and
-- UNKNOWN is accepted. Written with `=`, this let STRIPE + NULL through — the
-- one row it exists to stop — in two different shapes before the rule was
-- stated. Addendum §8. `settlement` is compared with `=` because it is NOT
-- NULL by the statement above.
ALTER TABLE public.contributions
  ADD CONSTRAINT contributions_settlement_tender_valid CHECK (
    (settlement = 'STRIPE'  AND tender IS NOT DISTINCT FROM 'CARD')
    OR
    (settlement = 'OFFLINE' AND tender IS DISTINCT FROM 'CARD')
  );

ALTER TABLE public.contributions
  ADD CONSTRAINT contributions_tender_reference_length
  CHECK (tender_reference IS NULL OR char_length(tender_reference) <= 64);

-- ------------------------------------------------------------- containment --
-- The board_invites block, verbatim, targeting tender_correction_log.
ALTER TABLE public."tender_correction_log" ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC, anon, authenticated;

GRANT ALL ON ALL TABLES    IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;

-- -------------------------------------------------------------------- gate --
-- Read from the catalog, never inferred from the statements above.
DO $$
DECLARE
  missing     TEXT;
  is_required BOOLEAN;
  rls         BOOLEAN;
BEGIN
  SELECT string_agg(name, ', ') INTO missing FROM (
    SELECT unnest(ARRAY[
      'contributions_settlement_tender_valid',
      'contributions_tender_reference_length',
      'tender_correction_log_pkey',
      'tender_correction_log_contribution_id_fkey',
      'tender_correction_log_host_id_fkey'
    ]) AS name
    EXCEPT
    SELECT c.conname
      FROM pg_constraint c
      JOIN pg_namespace n ON n.oid = c.connamespace
     WHERE n.nspname = 'public' AND c.convalidated
  ) x;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'settlement/tender aborted: missing or unvalidated constraint(s) %', missing;
  END IF;

  SELECT a.attnotnull INTO is_required
    FROM pg_attribute a
   WHERE a.attrelid = 'public.contributions'::regclass
     AND a.attname = 'settlement' AND NOT a.attisdropped;
  IF is_required IS NOT TRUE THEN
    RAISE EXCEPTION 'settlement/tender aborted: contributions.settlement is not NOT NULL';
  END IF;

  SELECT c.relrowsecurity INTO rls
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'tender_correction_log';
  IF rls IS NOT TRUE THEN
    RAISE EXCEPTION 'settlement/tender aborted: RLS is not enabled on tender_correction_log';
  END IF;
END $$;
