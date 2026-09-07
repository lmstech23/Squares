-- Accepted payment methods become a BOARD DECISION instead of an inference.
--
-- Before this, a fundraiser's payment methods were derived entirely from
-- account state: cash_mode_enabled was hardcoded true at creation and its
-- toggle never rendered, the four rails were whichever handles happened to be
-- populated, and card was on whenever the host's Stripe account had charges
-- enabled. A host could not say "this board takes Zelle only", and connecting
-- Stripe for any unrelated reason silently turned card on for every fundraiser
-- they owned.
--
-- NARROWING ONLY. The list is checked IN ADDITION to the existing capability
-- checks, never instead of them: `card` still requires a live Stripe account
-- and a rail still requires its handle. Listing a method the account cannot
-- perform grants nothing. That is what makes this safe to add to boards that
-- are already taking money - the worst a wrong value can do is offer less.
--
-- SEPARATE ENUM FROM payment_rail. A reservation can never be `card`, so the
-- two describe different domains; sharing one would put an unreachable value
-- in each and leave the next person to add a rail guessing which meaning they
-- were extending.

CREATE TYPE "board_payment_method" AS ENUM ('card', 'zelle', 'cashapp', 'venmo', 'paypal');

-- Empty default, so Game Day and any future board type is unaffected and the
-- column can be added without touching a row.
ALTER TABLE "boards"
  ADD COLUMN "accepted_payment_methods" "board_payment_method"[] NOT NULL DEFAULT '{}';

-- ------------------------------------------------------------- backfill ----
--
-- FROM CURRENT EFFECTIVE BEHAVIOUR, so no board changes what it offers. Card
-- where the host has charges enabled today; every rail whose handle is
-- populated. Reproduces exactly what each board is doing right now, which is
-- the property that lets this ship without a host noticing.
--
-- NOT derived from hosts.payment_preference. That field is host-wide, predates
-- fundraisers, is a nullable String with no enum behind it, and is already out
-- of step with reality - a host set to "cash" can have card live on every board
-- because their Stripe account is connected.
UPDATE "boards" b
   SET "accepted_payment_methods" = (
     SELECT array_remove(ARRAY[
       CASE WHEN COALESCE(h."stripe_charges_enabled", false) THEN 'card'::board_payment_method END,
       CASE WHEN b."host_zelle"   IS NOT NULL THEN 'zelle'::board_payment_method   END,
       CASE WHEN b."host_cashapp" IS NOT NULL THEN 'cashapp'::board_payment_method END,
       CASE WHEN b."host_venmo"   IS NOT NULL THEN 'venmo'::board_payment_method   END,
       CASE WHEN b."host_paypal"  IS NOT NULL THEN 'paypal'::board_payment_method  END
     ], NULL)
     FROM "hosts" h WHERE h."id" = b."host_id"
   )
 WHERE b."board_type" = 'fundraiser';

-- A fundraiser that accepts nothing cannot take money and should not exist.
-- Game Day is exempt: its direct-payment model is a PIN-gated square
-- reservation rather than a rail chosen at checkout, so its array stays empty
-- and nothing consults it.
--
-- cardinality(), NOT array_length(). `array_length('{}', 1)` returns NULL, not
-- zero, and a CHECK PASSES when it evaluates to NULL - so the obvious spelling
-- of this constraint permits exactly the row it exists to forbid. Verified
-- against the catalog rather than assumed:
--   SELECT array_length('{}'::text[],1) IS NULL  ->  t
--   SELECT cardinality('{}'::text[])             ->  0
ALTER TABLE "boards" ADD CONSTRAINT "boards_fundraiser_accepts_something"
  CHECK ("board_type" <> 'fundraiser' OR cardinality("accepted_payment_methods") >= 1);

-- ------------------------------------------------------------------ gate ---
DO $$
DECLARE
  empty_fundraisers INTEGER;
  widened           INTEGER;
BEGIN
  SELECT count(*) INTO empty_fundraisers FROM boards
   WHERE board_type = 'fundraiser' AND cardinality(accepted_payment_methods) = 0;
  IF empty_fundraisers > 0 THEN
    RAISE EXCEPTION
      'accepted payment methods aborted: % fundraiser board(s) accept nothing after backfill',
      empty_fundraisers;
  END IF;

  -- THE BACKFILL MUST NOT HAVE WIDENED ANYTHING. Every listed method must be
  -- one the board can actually perform today; if this fires, a board would
  -- start offering something it could not complete.
  SELECT count(*) INTO widened FROM boards b JOIN hosts h ON h.id = b.host_id
   WHERE b.board_type = 'fundraiser'
     AND (
       ('card'::board_payment_method    = ANY(b.accepted_payment_methods) AND NOT COALESCE(h.stripe_charges_enabled, false))
    OR ('zelle'::board_payment_method   = ANY(b.accepted_payment_methods) AND b.host_zelle   IS NULL)
    OR ('cashapp'::board_payment_method = ANY(b.accepted_payment_methods) AND b.host_cashapp IS NULL)
    OR ('venmo'::board_payment_method   = ANY(b.accepted_payment_methods) AND b.host_venmo   IS NULL)
    OR ('paypal'::board_payment_method  = ANY(b.accepted_payment_methods) AND b.host_paypal  IS NULL)
     );
  IF widened > 0 THEN
    RAISE EXCEPTION
      'accepted payment methods aborted: % board(s) list a method they cannot perform', widened;
  END IF;
END $$;
