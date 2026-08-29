-- ============================================================
-- Migration 6: BoardStatus gains 'closing'
-- Spec: fundraiser-money-state-machine.md §7
--
-- Run AFTER add_confirmation_emailed_at.sql. Additive only.
-- ============================================================

-- CLOSING is a real persisted state, not a transient step.
--
-- It exists to eliminate the one moment where "payment always wins" and "final
-- amounts are immutable" could contradict each other: a campaign closes at
-- 3:00:00, totals finalize at 3:00:01 at $3,250, and a delayed webhook arrives
-- at 3:00:04 for a $150 checkout that genuinely succeeded before the cutoff.
--
-- A board in `closing` accepts no new claims and has not yet written
-- finalRaisedCents. Reconciliation can span several cron cycles if Stripe is
-- slow, so the state has to survive between them.
--
-- Game Day never enters it. Its close path is unchanged.
ALTER TYPE "BoardStatus" ADD VALUE IF NOT EXISTS 'closing';
