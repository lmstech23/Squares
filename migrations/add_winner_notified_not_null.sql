-- add_winner_notified_not_null.sql
--
-- boards.winner_notified_by_period: nullable -> NOT NULL.
--
-- schema.prisma has always declared this column non-nullable
-- (`winnerNotifiedByPeriod Json @default("{}")`). The database did not enforce
-- it, so every `prisma migrate diff` proposed this statement. Applying it makes
-- the database match the declaration rather than silencing the declaration.
--
-- SAFE, and safe for a different reason than hosts.email was not:
--   * 17 rows, 0 NULL  -- verified immediately before applying
--   * DEFAULT '{}'::jsonb already exists, so every future INSERT that omits the
--     column still gets a value. The constraint demands nothing the product
--     cannot supply.
--
-- That second point is the whole distinction. hosts.email has no usable default
-- and four rows holding '' as a surrogate, so NOT NULL there would ratify a
-- workaround. Here there is nothing to ratify.
--
-- GAME DAY: this column is Game Day only. Behaviour is unchanged -- no row
-- moves, no default changes, no code path can now fail that could not before,
-- because no row was ever NULL.
--
-- Applied 2026-08-31.

BEGIN;

-- Fails loudly rather than silently coercing, if the precondition ever stops
-- holding between verification and execution.
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM boards WHERE winner_notified_by_period IS NULL;
  IF n > 0 THEN
    RAISE EXCEPTION 'ABORT: % board(s) have a NULL winner_notified_by_period', n;
  END IF;
END $$;

ALTER TABLE public.boards ALTER COLUMN winner_notified_by_period SET NOT NULL;

COMMIT;
