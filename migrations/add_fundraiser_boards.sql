-- ============================================================
-- Migration: Fundraiser Boards — schema + backfill
-- Spec: fundraiser-board-v2.md §3, build order step 1
--
-- Additive only. Every existing board becomes board_type = 'game'
-- and behaves exactly as before. No Game Day column changes.
--
-- Note: there is NO ticket table here and none should be added.
-- A paid drawing ticket is the square itself (money doc §5). The only
-- sequential counter in the system is the free-entry `F` sequence below.
-- ============================================================

-- 1. New enums
CREATE TYPE board_type AS ENUM (
  'game',
  'fundraiser'
);

CREATE TYPE draw_trigger AS ENUM (
  'date',
  'when_full'
);

-- 2. Board columns
--
-- board_type is added nullable, backfilled, then made NOT NULL, so the
-- table is never rewritten with a lock held against a default on a
-- populated table.
ALTER TABLE boards ADD COLUMN board_type board_type;

UPDATE boards SET board_type = 'game' WHERE board_type IS NULL;

ALTER TABLE boards
  ALTER COLUMN board_type SET NOT NULL,
  ALTER COLUMN board_type SET DEFAULT 'game';

ALTER TABLE boards
  ADD COLUMN cause_description       TEXT,
  ADD COLUMN prize_pool_percent      INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN prize_tier_count        INTEGER NOT NULL DEFAULT 4,
  ADD COLUMN draw_trigger            draw_trigger,
  ADD COLUMN draw_date               TIMESTAMPTZ,
  ADD COLUMN timezone                TEXT,
  ADD COLUMN cash_hold_days          INTEGER NOT NULL DEFAULT 7,
  ADD COLUMN final_raised_cents      INTEGER,
  ADD COLUMN final_prize_pool_cents  INTEGER,
  ADD COLUMN drawn_at                TIMESTAMPTZ,
  ADD COLUMN draw_results            JSONB,
  ADD COLUMN title_history           JSONB,
  -- Campaign backstop. draw_date used to do double duty as both the drawing
  -- schedule and the campaign end; with prizes deferred to Phase B, nothing
  -- else closes a no-prize fundraiser. Required on fundraiser boards,
  -- enforced by API validation for the same conditional reason as draw_date.
  ADD COLUMN campaign_ends_at        TIMESTAMPTZ,
  -- Early bird — money doc §8B. Null price = flat pricing, current behavior.
  ADD COLUMN early_bird_price_cents  INTEGER,
  ADD COLUMN early_bird_ends_at      TIMESTAMPTZ;

-- Ranges from v2 §3. draw_trigger / draw_date / timezone / campaign_ends_at
-- stay nullable: the spec requires them conditionally, which cannot be NOT NULL
-- on a table full of game boards. API validation enforces it.
--
-- The prize CHECK is deliberately added now even though prize boards are
-- deferred to Phase B and nothing exercises it yet — that is precisely why it
-- should not wait on someone remembering it later.
ALTER TABLE boards
  ADD CONSTRAINT boards_prize_pool_percent_range
    CHECK (prize_pool_percent BETWEEN 0 AND 50),
  ADD CONSTRAINT boards_prize_tier_count_range
    CHECK (prize_tier_count BETWEEN 1 AND 4),
  ADD CONSTRAINT boards_prize_requires_draw_date
    CHECK (prize_pool_percent = 0 OR draw_date IS NOT NULL);

-- 3. Square columns
--
-- price_paid_cents is nullable because an `open` square has no price yet. It is
-- written the moment the square leaves `open` — at claim or at cash reservation
-- — and never recomputed. `raised` is the sum of this column over confirmed
-- squares, never count x price. Money doc invariants 42-44.
ALTER TABLE squares
  ADD COLUMN hold_expires_at     TIMESTAMPTZ,
  ADD COLUMN checkout_session_id TEXT,
  ADD COLUMN batch_id            TEXT,
  ADD COLUMN is_host_entry       BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN price_paid_cents    INTEGER;

CREATE INDEX idx_squares_batch ON squares(batch_id);

-- 4. Free entries
--
-- Occupy no square, contribute $0, eligible in the draw (invariant 17).
-- Data path only — no UI in this step.
CREATE TABLE free_entries (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  board_id        UUID NOT NULL REFERENCES boards(board_id),
  sequence_number INTEGER NOT NULL,
  name            TEXT NOT NULL,
  phone           TEXT NOT NULL,
  verified_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The one index money doc §5 calls for. Two simultaneous free entries must
-- produce F1 and F2, never two F1s.
CREATE UNIQUE INDEX free_entries_board_sequence_key
  ON free_entries(board_id, sequence_number);
