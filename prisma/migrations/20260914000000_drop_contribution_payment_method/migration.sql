-- Payment method, M1b — contract: drop contributions.payment_method.
-- fundraiser-payment-method-addendum.md v1.2.6 §9, §12.
--
-- Every read moved to `settlement` first, and M1a rewrote both dependent
-- CHECKs to read it. The five writers stop writing the column in the same
-- commit as this migration, so nothing references it by the time it goes.
--
-- THE ENUM TYPE STAYS. "PaymentMethod" is still the type of
-- squares.payment_method and payment_references.method - Game Day columns this
-- change never touches. Dropping a column is not dropping its type.
--
-- DROP COLUMN SILENTLY DROPS EVERY CHECK THAT MENTIONS THE COLUMN. That is why
-- M1a rewrote the two of them first, and why the gate below reads them back
-- from the catalog rather than trusting that they survived.

ALTER TABLE public.contributions DROP COLUMN payment_method;

-- -------------------------------------------------------------------- gate --
DO $$
DECLARE
  col      integer;
  bad      text;
  enumtype integer;
BEGIN
  SELECT count(*) INTO col
    FROM pg_attribute
   WHERE attrelid = 'public.contributions'::regclass
     AND attname = 'payment_method' AND NOT attisdropped;
  IF col <> 0 THEN
    RAISE EXCEPTION 'M1b aborted: contributions.payment_method is still present';
  END IF;

  SELECT string_agg(name || ' (' || problem || ')', ', ') INTO bad FROM (
    SELECT e.name,
           CASE WHEN c.oid IS NULL THEN 'missing'
                WHEN NOT c.convalidated THEN 'not validated'
                WHEN pg_get_constraintdef(c.oid) LIKE '%payment_method%' THEN 'still reads payment_method'
           END AS problem
      FROM unnest(ARRAY['contributions_card_requires_email',
                        'contributions_rail_is_cash_only']) AS e(name)
      LEFT JOIN pg_constraint c
        ON c.conname = e.name AND c.conrelid = 'public.contributions'::regclass
  ) x
  WHERE problem IS NOT NULL;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'M1b aborted: %', bad;
  END IF;

  SELECT count(*) INTO enumtype
    FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
   WHERE n.nspname = 'public' AND t.typname = 'PaymentMethod';
  IF enumtype <> 1 THEN
    RAISE EXCEPTION 'M1b aborted: the "PaymentMethod" enum type is gone - squares.payment_method and payment_references.method still need it';
  END IF;
END $$;
