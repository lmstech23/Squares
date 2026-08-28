-- ============================================================
-- Migration 3: Donate-admissions model
-- Spec: fundraiser-admission-addendum.md v2.0 §3
--
-- Run AFTER add_admission_tables.sql. Additive plus two NOT NULL relaxations.
-- Nothing reads these yet — admission activation is A8.
--
-- The model changed: one confirmed square now mints one admission pass, and a
-- purchaser who is not attending checks a box that donates theirs. The
-- declaration model — picker, per-supporter ceiling, Manage attendance — is
-- gone. Its columns are retained rather than dropped, per v2.0 §3.
-- ============================================================

-- 1. The donate flag. The only column v2.0 adds by design.
ALTER TABLE admission_grants
  ADD COLUMN donate_admissions BOOLEAN NOT NULL DEFAULT FALSE;

-- 2. Which square minted a pass. Audit only, and newly meaningful: passes now
--    accrue one per square as each square confirms, rather than as a batch.
--    Nullable because a pass may later come from a non-square source
--    (STANDALONE, GATE_ALLOWANCE, HOST_APPROVED), all deferred.
ALTER TABLE admission_passes
  ADD COLUMN square_id UUID REFERENCES squares(square_id);

CREATE INDEX idx_admission_passes_square ON admission_passes(square_id);

-- 3. Two retained columns must lose NOT NULL or they block the writes that
--    replace them.
--
--    Both were NOT NULL with NO DEFAULT in migration 2. v2.0 marks them unused
--    and typed Int?, but "unused" is not the same as "writable without". Left
--    as they are:
--
--      events.max_attendees_per_supporter   the create form no longer collects
--                                           it, so event creation would fail
--                                           on the next fundraiser board
--      admission_grants.declared_at_purchase v2.0 removes it from the model
--                                           entirely, so createGrant at A5
--                                           would have nothing to supply
--
--    event_supporters.declared_count is NOT NULL too but carries DEFAULT 0, so
--    it is genuinely harmless and is left exactly as-is.
ALTER TABLE events
  ALTER COLUMN max_attendees_per_supporter DROP NOT NULL;

ALTER TABLE admission_grants
  ALTER COLUMN declared_at_purchase DROP NOT NULL;

-- attendance_access_tokens is left in place and unused. Manage attendance is
-- gone, so nothing writes it. Dropping it is a migration for no benefit, and
-- it is the right table if a self-service path ever returns.
