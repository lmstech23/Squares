-- Entry ticket limit — fundraiser-board-v2.md §19.13, invariant 126.
--
-- A DEDICATED COLUMN, NEVER `total_squares`. `total_squares` is the grid size of
-- the square product; a board can sell entry tickets while never selling a
-- square, and welding the two numbers together is what made the host dashboard
-- read "0 of 100 tickets confirmed" on a board with fourteen tickets sold.
--
-- NULL MEANS UNLIMITED, and is not the same as zero. There is no default: a
-- board that has never been capped is uncapped, and a 0 would read as a cap of
-- none and refuse every sale.

ALTER TABLE public.boards
  ADD COLUMN entry_ticket_limit INTEGER;

-- A cap of zero is not a cap, it is a closed product. Refuse it at the column
-- rather than leaving every reader to decide what 0 meant.
ALTER TABLE public.boards
  ADD CONSTRAINT boards_entry_ticket_limit_positive
  CHECK (entry_ticket_limit IS NULL OR entry_ticket_limit > 0);

-- -------------------------------------------------------------------- gate --
-- Read from the catalog, never inferred from the statements above.
DO $$
DECLARE
  col_exists   boolean;
  col_nullable boolean;
  chk_ok       boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'boards'
       AND column_name = 'entry_ticket_limit'
  ) INTO col_exists;

  SELECT is_nullable = 'YES' FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'boards'
     AND column_name = 'entry_ticket_limit'
    INTO col_nullable;

  SELECT c.convalidated FROM pg_constraint c
    JOIN pg_class r ON r.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = r.relnamespace
   WHERE n.nspname = 'public' AND r.relname = 'boards'
     AND c.conname = 'boards_entry_ticket_limit_positive'
    INTO chk_ok;

  IF NOT col_exists THEN
    RAISE EXCEPTION 'entry_ticket_limit was not created';
  END IF;
  IF NOT col_nullable THEN
    RAISE EXCEPTION 'entry_ticket_limit must be nullable — NULL means unlimited';
  END IF;
  IF chk_ok IS NOT TRUE THEN
    RAISE EXCEPTION 'boards_entry_ticket_limit_positive missing or not validated';
  END IF;

  RAISE NOTICE 'entry_ticket_limit: nullable column + validated positive CHECK';
END $$;
