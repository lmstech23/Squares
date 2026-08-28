-- ============================================================
-- Migration 5: squares.confirmation_emailed_at
-- Spec: fundraiser-admission-addendum.md §5 — one email per confirmation event
--
-- Run AFTER add_claimed_at.sql. Additive only.
-- ============================================================

-- Stamped when a square has been included in a confirmation email.
--
-- The unit is the confirmation EVENT, not the square. Without this column
-- there is no way to send "everything confirmed that has not been mailed yet"
-- — the sender would either re-send the whole batch every time or send one
-- email per square, which is what it did.
--
-- It also makes the partial-cash case work: 3 reserved, 2 confirmed sends for
-- the 2 and stamps them, and the third confirming later is a separate event
-- with its own email rather than a duplicate of the first.
ALTER TABLE squares
  ADD COLUMN confirmation_emailed_at TIMESTAMPTZ;

-- Backfill every already-confirmed square as "already emailed". These
-- contributors got their email — per square, which is the bug — and must not
-- receive another when the sweep first runs.
UPDATE squares
   SET confirmation_emailed_at = NOW()
 WHERE payment_status = 'paid'
   AND confirmation_emailed_at IS NULL;

-- The sweep looks for paid squares that have not been mailed.
CREATE INDEX idx_squares_unmailed
  ON squares(board_id)
  WHERE payment_status = 'paid' AND confirmation_emailed_at IS NULL;
