-- Payment method, M1a — the two CHECKs that read payment_method now read
-- settlement. fundraiser-payment-method-addendum.md v1.2.5 §8, §9.
--
-- SAME NAMES, SAME MEANING. Each constraint is dropped and re-added under its
-- existing name inside this one transaction, so there is no moment without it.
-- M0's backfill and dual-writes keep payment_method and settlement in lockstep
-- (cash <-> OFFLINE, stripe <-> STRIPE), so every row that satisfied the old
-- predicate satisfies the new one - and ADD CONSTRAINT validates every row
-- regardless.
--
-- THIS LANDS BEFORE payment_method IS DROPPED (M1b). DROP COLUMN silently drops
-- every CHECK that mentions the column. Rewritten first, these survive it.
--
-- NULL-SAFE BY THE RULE IN §8. `settlement` is NOT NULL, so `settlement =
-- 'OFFLINE'` is never UNKNOWN, and the other operand of each OR is an IS [NOT]
-- NULL test, which is never UNKNOWN either. Neither predicate can be UNKNOWN,
-- so neither can accept a row by default.

-- ---------------------------------------------------- card requires email --
-- Only a host-attested contribution may lack an email. `= 'OFFLINE'`, not
-- `<> 'STRIPE'`: a second witnessed settlement value must require an email
-- too, rather than inherit an exemption meant for rows the host vouches for.
ALTER TABLE public.contributions DROP CONSTRAINT contributions_card_requires_email;
ALTER TABLE public.contributions
  ADD CONSTRAINT contributions_card_requires_email
  CHECK (settlement = 'OFFLINE' OR contributor_email IS NOT NULL);

-- ---------------------------------------------------------- declared rail --
-- A declared rail exists only on a host-attested contribution. This relates
-- the declared rail to SETTLEMENT. The independence rule is between the
-- declared rail and TENDER, and is untouched. Together with "settlement and
-- tender pair only as enumerated" it means a declared-rail row cannot carry
-- tender = CARD: a consequence of two constraints, not a third (§8).
ALTER TABLE public.contributions DROP CONSTRAINT contributions_rail_is_cash_only;
ALTER TABLE public.contributions
  ADD CONSTRAINT contributions_rail_is_cash_only
  CHECK (payment_rail IS NULL OR settlement = 'OFFLINE');

-- -------------------------------------------------------------------- gate --
-- Read from the catalog, never inferred from the statements above.
DO $$
DECLARE
  bad TEXT;
BEGIN
  SELECT string_agg(name || ' (' || problem || ')', ', ') INTO bad FROM (
    SELECT e.name,
           CASE WHEN c.oid IS NULL THEN 'missing'
                WHEN NOT c.convalidated THEN 'not validated'
                WHEN pg_get_constraintdef(c.oid) LIKE '%payment_method%' THEN 'still reads payment_method'
                WHEN pg_get_constraintdef(c.oid) NOT LIKE '%settlement%' THEN 'does not read settlement'
           END AS problem
      FROM unnest(ARRAY['contributions_card_requires_email',
                        'contributions_rail_is_cash_only']) AS e(name)
      LEFT JOIN pg_constraint c
        ON c.conname = e.name AND c.conrelid = 'public.contributions'::regclass
  ) x
  WHERE problem IS NOT NULL;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'M1a aborted: %', bad;
  END IF;
END $$;
