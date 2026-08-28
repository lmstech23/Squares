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
  ADD COLUMN draw_timezone           TEXT,
  ADD COLUMN cash_hold_days          INTEGER NOT NULL DEFAULT 7,
  ADD COLUMN final_raised_cents      INTEGER,
  ADD COLUMN final_prize_pool_cents  INTEGER,
  ADD COLUMN drawn_at                TIMESTAMPTZ,
  ADD COLUMN draw_results            JSONB,
  ADD COLUMN title_history           JSONB;

-- Ranges from v2 §3. draw_trigger / draw_date / draw_timezone stay nullable:
-- the spec requires them on PRIZE boards only, which is a conditional
-- constraint and cannot be NOT NULL. API validation enforces it.
ALTER TABLE boards
  ADD CONSTRAINT boards_prize_pool_percent_range
    CHECK (prize_pool_percent BETWEEN 0 AND 50),
  ADD CONSTRAINT boards_prize_tier_count_range
    CHECK (prize_tier_count BETWEEN 1 AND 4);

-- 3. Square columns
ALTER TABLE squares
  ADD COLUMN hold_expires_at     TIMESTAMPTZ,
  ADD COLUMN checkout_session_id TEXT,
  ADD COLUMN batch_id            TEXT,
  ADD COLUMN is_host_entry       BOOLEAN NOT NULL DEFAULT FALSE;

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
