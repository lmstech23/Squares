-- ============================================================
-- Migration 2: Event Admission — tables
-- Spec: fundraiser-admission-addendum.md §2, build order step A1b
--
-- Run AFTER add_fundraiser_boards.sql. Both are written before either is
-- applied, so there is no timing gap between them.
--
-- Additive only. Nothing here is read by any code path yet. A board with no
-- event behaves exactly as it does today.
--
-- Nothing is added to boards, squares, or hosts. There is no ticket table.
-- ============================================================

-- 1. Enums
CREATE TYPE supporter_status AS ENUM (
  'pending',
  'active'
);

-- Only FUNDRAISER is populated now. The other three exist so that adding them
-- later is a code path, not a migration.
CREATE TYPE admission_grant_source AS ENUM (
  'FUNDRAISER',
  'STANDALONE',
  'GATE_ALLOWANCE',
  'HOST_APPROVED'
);

-- `void` is terminal. A voided pass never returns to active under any path —
-- a screenshot shared last week must not become a working credential again.
CREATE TYPE admission_pass_status AS ENUM (
  'active',
  'used',
  'void'
);

CREATE TYPE check_in_action AS ENUM (
  'check_in',
  'undo'
);

-- 2. Event — at most one per board
CREATE TABLE events (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  board_id                    UUID NOT NULL REFERENCES boards(board_id),
  name                        TEXT,
  starts_at                   TIMESTAMPTZ NOT NULL,
  ends_at                     TIMESTAMPTZ,
  timezone                    TEXT NOT NULL,
  venue                       TEXT,
  max_attendees_per_supporter INTEGER NOT NULL,
  -- Reserved. Never read in Phase A. See addendum §5.
  gate_allowance_total        INTEGER NOT NULL DEFAULT 0,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX events_board_id_key ON events(board_id);

-- 3. VolunteerAccess — created before admission_passes, which references it
--
-- A bearer credential that will sit in a text thread on five phones for a week.
-- Hashed at rest so a database read never yields a working gate credential.
-- The raw link is shown once at creation and never stored.
CREATE TABLE volunteer_access (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id   UUID NOT NULL REFERENCES events(id),
  label      TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_volunteer_access_event ON volunteer_access(event_id);

-- 4. EventSupporter — the roster unit and the owner of passes
--
-- identity_key is the purchaser email, lowercased and trimmed. Two purchases
-- with the same email are the same supporter, with one allowance between them.
-- status is a latch: pending -> active, one way, never back.
CREATE TABLE event_supporters (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id             UUID NOT NULL REFERENCES events(id),
  identity_key         TEXT NOT NULL,
  name                 TEXT NOT NULL,
  email                TEXT NOT NULL,
  -- Nullable: the existing claim flow does not require a phone
  -- (squares.player_phone is nullable), and preparation must not fail for a
  -- contributor who gave none.
  phone                TEXT,
  declared_count       INTEGER NOT NULL DEFAULT 0,
  -- Monotonic. Never decremented, never reset. Values are never reused.
  pass_sequence_cursor INTEGER NOT NULL DEFAULT 0,
  status               supporter_status NOT NULL DEFAULT 'pending',
  activated_at         TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One family, one row, one allowance.
CREATE UNIQUE INDEX event_supporters_event_identity_key
  ON event_supporters(event_id, identity_key);

-- 5. AdmissionGrant — provenance, one row per purchase that touched admission
--
-- A grant is written even when it declares 0, so the host's headcount is
-- auditable rather than inferred from absence.
CREATE TABLE admission_grants (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id             UUID NOT NULL REFERENCES events(id),
  event_supporter_id   UUID NOT NULL REFERENCES event_supporters(id),
  square_batch_id      TEXT,
  source               admission_grant_source NOT NULL DEFAULT 'FUNDRAISER',
  declared_at_purchase INTEGER NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One fundraiser grant per purchase. This is what makes the claim-time
-- preparation step idempotent under retry — addendum §4.
--
-- The addendum says "unique where not null". No WHERE clause is needed:
-- Postgres already treats NULLs as distinct in a unique index, so rows from
-- non-fundraiser sources (null batch) never collide. Stated as a plain unique
-- index so it matches the Prisma model exactly and never reads as drift.
CREATE UNIQUE INDEX admission_grants_square_batch_key
  ON admission_grants(square_batch_id);

CREATE INDEX idx_admission_grants_supporter
  ON admission_grants(event_supporter_id);

-- 6. AdmissionPass — passes hang off the supporter, not the purchase
--
-- Every pass gets its own token whether or not it is ever named. A shared,
-- unidentified QR is one screenshot away from admitting six people.
--
-- checked_in_by_volunteer_access_id is a foreign key, never a bearer token.
-- No raw credential is stored anywhere, including audit trails.
CREATE TABLE admission_passes (
  id                                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_supporter_id                UUID NOT NULL REFERENCES event_supporters(id),
  sequence_number                   INTEGER NOT NULL,
  token                             TEXT NOT NULL,
  label                             TEXT,
  status                            admission_pass_status NOT NULL DEFAULT 'active',
  checked_in_at                     TIMESTAMPTZ,
  checked_in_by_volunteer_access_id UUID REFERENCES volunteer_access(id),
  created_at                        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The important one, and not decorative: concurrent activation cannot
-- double-mint. Safe because the cursor never reuses a value — addendum §4.
CREATE UNIQUE INDEX admission_passes_supporter_sequence_key
  ON admission_passes(event_supporter_id, sequence_number);

-- No token collision across the whole system.
CREATE UNIQUE INDEX admission_passes_token_key
  ON admission_passes(token);

-- 7. CheckInLog — undo has to be auditable or the host stops trusting the count
CREATE TABLE check_in_logs (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pass_id                 UUID NOT NULL REFERENCES admission_passes(id),
  event_id                UUID NOT NULL REFERENCES events(id),
  action                  check_in_action NOT NULL,
  at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  by_volunteer_access_id  UUID NOT NULL REFERENCES volunteer_access(id)
);

CREATE INDEX idx_check_in_logs_event_at ON check_in_logs(event_id, at);
CREATE INDEX idx_check_in_logs_pass ON check_in_logs(pass_id);

-- 8. AttendanceAccessToken — 20-minute single-use link for Manage attendance
--
-- Hashed. The raw value exists only in the email. Flow: v2 §6A.
CREATE TABLE attendance_access_tokens (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_supporter_id UUID NOT NULL REFERENCES event_supporters(id),
  token_hash         TEXT NOT NULL,
  expires_at         TIMESTAMPTZ NOT NULL,
  used_at            TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_attendance_tokens_supporter
  ON attendance_access_tokens(event_supporter_id);
