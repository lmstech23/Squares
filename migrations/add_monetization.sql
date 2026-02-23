-- ============================================================
-- Migration: Monetization — Invite Codes + Board Credits
-- Run AFTER existing schema is deployed
-- ============================================================

-- 1. Add board_credits to hosts
ALTER TABLE hosts ADD COLUMN board_credits INTEGER NOT NULL DEFAULT 2;

-- 2. Create credit transaction types
CREATE TYPE credit_tx_type AS ENUM (
  'signup_grant',
  'purchase',
  'admin_grant',
  'board_created'
);

-- 3. Create credit_transactions table
CREATE TABLE credit_transactions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  host_id           UUID NOT NULL REFERENCES hosts(id),
  type              credit_tx_type NOT NULL,
  amount            INTEGER NOT NULL,
  balance_after     INTEGER NOT NULL,
  stripe_session_id TEXT,
  note              TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_credit_tx_host_created ON credit_transactions(host_id, created_at);

-- 4. Create invite_codes table
CREATE TABLE invite_codes (
  code        TEXT PRIMARY KEY,
  email       TEXT,
  claimed_by  UUID REFERENCES hosts(id),
  claimed_at  TIMESTAMPTZ,
  expires_at  TIMESTAMPTZ NOT NULL
);

-- 5. Backfill: existing hosts get 2 credits + signup_grant log entry
INSERT INTO credit_transactions (host_id, type, amount, balance_after, note)
SELECT id, 'signup_grant', 2, 2, 'March Madness launch grant'
FROM hosts;

-- 6. Seed 10 invite codes (expires April 8, 2026 — day after championship)
INSERT INTO invite_codes (code, expires_at) VALUES
  ('DAALI-001', '2026-04-08T00:00:00Z'),
  ('DAALI-002', '2026-04-08T00:00:00Z'),
  ('DAALI-003', '2026-04-08T00:00:00Z'),
  ('DAALI-004', '2026-04-08T00:00:00Z'),
  ('DAALI-005', '2026-04-08T00:00:00Z'),
  ('DAALI-006', '2026-04-08T00:00:00Z'),
  ('DAALI-007', '2026-04-08T00:00:00Z'),
  ('DAALI-008', '2026-04-08T00:00:00Z'),
  ('DAALI-009', '2026-04-08T00:00:00Z'),
  ('DAALI-010', '2026-04-08T00:00:00Z');
