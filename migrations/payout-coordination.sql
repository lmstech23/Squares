-- ============================================================
-- PAYOUT COORDINATION MIGRATION
-- Adds host payment handles, player payout info, phone, SMS opt-in
-- Reference: payout-coordination-memo.docx + SYSTEM-FLOW.md §8
-- ============================================================

-- 1. New enum for payout visibility
DO $$ BEGIN
  CREATE TYPE "PayoutVisibility" AS ENUM ('public', 'pin_gated');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 2. New enum for player payout method
DO $$ BEGIN
  CREATE TYPE "PlayerPayoutMethod" AS ENUM ('venmo', 'zelle', 'cashapp', 'cash');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 3. Board table — host payment handles + payout settings
ALTER TABLE boards
  ADD COLUMN IF NOT EXISTS host_venmo            TEXT,
  ADD COLUMN IF NOT EXISTS host_zelle            TEXT,
  ADD COLUMN IF NOT EXISTS host_cashapp          TEXT,
  ADD COLUMN IF NOT EXISTS payout_visibility     "PayoutVisibility" NOT NULL DEFAULT 'public',
  ADD COLUMN IF NOT EXISTS require_player_payout BOOLEAN NOT NULL DEFAULT false;

-- 4. Square table — player contact + payout info
ALTER TABLE squares
  ADD COLUMN IF NOT EXISTS player_phone          TEXT,
  ADD COLUMN IF NOT EXISTS player_payout_method  "PlayerPayoutMethod",
  ADD COLUMN IF NOT EXISTS player_payout_handle  TEXT,
  ADD COLUMN IF NOT EXISTS sms_opt_in            BOOLEAN NOT NULL DEFAULT false;
