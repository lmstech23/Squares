-- ============================================================
-- Migration 4: squares.claimed_at
-- Spec: fundraiser-board-v2.md §9 — the contributor list
--
-- Run AFTER add_donate_admissions.sql. Additive only.
-- ============================================================

-- When a square left `open` — at claim or at direct-payment reservation.
--
-- Nothing recorded this. PaymentReference.timestamp exists, but it is written
-- at CONFIRMATION, so it covers exactly the rows that do not need it: an
-- AWAITING row is the one a host chases, and "how long has this been
-- outstanding" is the question she is asking. Without this column that row has
-- no date at all.
--
-- Written alongside price_paid_cents, at the same moment and by the same code,
-- and never recomputed after.
ALTER TABLE squares
  ADD COLUMN claimed_at TIMESTAMPTZ;

-- Backfill what can be known. Confirmed squares get their payment timestamp —
-- that is the confirmation moment rather than the claim moment, so it is
-- approximate for anything reserved and confirmed later. Accepted: the
-- alternative is a blank column on every historical row.
--
-- Squares awaiting payment today keep NULL. There is no record of when they
-- were reserved, and inventing one would be worse than showing nothing.
UPDATE squares s
   SET claimed_at = pr.timestamp
  FROM payment_references pr
 WHERE pr.square_id = s.square_id
   AND s.claimed_at IS NULL;

CREATE INDEX idx_squares_claimed_at ON squares(board_id, claimed_at);
