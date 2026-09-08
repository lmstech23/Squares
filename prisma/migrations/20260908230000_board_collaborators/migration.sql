-- Board-scoped delegation: OWNER and MANAGER as rows, not as `Board.hostId`.
-- board-collaborators-addendum.md v2.2 §9. Invariants 91, 92, 109.
--
-- COMMIT 1 OF THE SEQUENCE. This table is created and backfilled and NOTHING
-- READS IT YET. Authorization still runs through the 28 inline comparisons; the
-- switch is commit 3. That ordering is deliberate: a backfill that is wrong is
-- recoverable while nothing depends on it, and catastrophic the moment
-- `requireBoardAccess` is the only way onto a board.
--
-- THIS IS THE FIRST MIGRATION IN THE SEQUENCE TO WRITE ROWS FOR LIVE BOARDS.
-- The earlier ones added columns and tables nothing had written to. This one
-- creates a row for every board that exists, and commit 3 then makes those rows
-- the only thing standing between a host and her own board. A board with zero
-- owner rows becomes invisible to its creator -- discovered by the owner, not
-- by the deploy. Hence the gate at the bottom, which reads the catalog.

-- ------------------------------------------------------------------ enums ---
CREATE TYPE "board_role" AS ENUM ('OWNER', 'MANAGER');

-- `invited` exists now though no invite flow does. A status that has to be
-- added later means an ALTER TYPE on a table authorization depends on, and the
-- value costs nothing unused.
CREATE TYPE "collaborator_status" AS ENUM ('invited', 'active', 'revoked');

-- ------------------------------------------------------------------ table ---
CREATE TABLE "board_collaborators" (
  "id"                 UUID NOT NULL DEFAULT gen_random_uuid(),
  "board_id"           UUID NOT NULL,
  "host_id"            UUID NOT NULL,
  "role"               "board_role" NOT NULL,
  "status"             "collaborator_status" NOT NULL,
  -- Null for backfilled owners: nobody invited them, they created the board.
  "invited_by_host_id" UUID,
  "accepted_at"        TIMESTAMPTZ(6),
  "revoked_at"         TIMESTAMPTZ(6),
  "revoked_by_host_id" UUID,
  "created_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

  CONSTRAINT "board_collaborators_pkey" PRIMARY KEY ("id")
);

-- RESTRICT, matching every other relation in this schema. A collaborator row is
-- an authorization record: deleting a host or a board out from under one must
-- fail loudly rather than silently removing somebody's access.
ALTER TABLE "board_collaborators" ADD CONSTRAINT "board_collaborators_board_id_fkey"
  FOREIGN KEY ("board_id") REFERENCES "boards"("board_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "board_collaborators" ADD CONSTRAINT "board_collaborators_host_id_fkey"
  FOREIGN KEY ("host_id") REFERENCES "hosts"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "board_collaborators" ADD CONSTRAINT "board_collaborators_invited_by_host_id_fkey"
  FOREIGN KEY ("invited_by_host_id") REFERENCES "hosts"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "board_collaborators" ADD CONSTRAINT "board_collaborators_revoked_by_host_id_fkey"
  FOREIGN KEY ("revoked_by_host_id") REFERENCES "hosts"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- ---------------------------------------------------------------- indexes ---
-- ONE LIVE GRANT PER PERSON PER BOARD, unlimited revoked history. Partial, so
-- `revoked` is terminal and re-granting creates a NEW row rather than reviving
-- one -- invariant 109. A full unique index would make re-granting impossible.
CREATE UNIQUE INDEX "board_collaborators_live_grant_key"
  ON "board_collaborators" ("board_id", "host_id")
  WHERE "status" <> 'revoked';

-- EXACTLY ONE ACTIVE OWNER PER BOARD -- invariant 92, enforced by the database
-- rather than by the code that writes it. Two owners is not a state any route
-- should have to reason about.
CREATE UNIQUE INDEX "board_collaborators_one_owner_key"
  ON "board_collaborators" ("board_id")
  WHERE "role" = 'OWNER' AND "status" = 'active';

-- The manager board list looks up by host alone, so it needs its own index --
-- the live-grant index above leads with board_id and cannot serve it.
CREATE INDEX "idx_board_collaborators_host_status"
  ON "board_collaborators" ("host_id", "status");

-- --------------------------------------------------------------- backfill ---
-- ONE ACTIVE OWNER PER EXISTING BOARD, INCLUDING GAME DAY. Delegation is
-- board-scoped, not fundraiser-scoped, and a Game Day board with no owner row
-- would vanish from its creator's dashboard at commit 3 exactly as a fundraiser
-- would.
--
-- `accepted_at` is the board's own `created_at`: the owner's access began when
-- the board did, and a backfill timestamp would claim they accepted an
-- invitation today. `invited_by_host_id` stays NULL -- nobody invited them.
INSERT INTO "board_collaborators" ("board_id", "host_id", "role", "status", "accepted_at", "created_at")
SELECT b."board_id", b."host_id", 'OWNER', 'active', b."created_at", b."created_at"
  FROM "boards" b;

-- ------------------------------------------------------------- containment --
-- RLS AND GRANTS, in this same transaction. Every table-creating migration
-- since the August incident ends with this block; the one that did not left two
-- tables exposed for a day. Zero client policies: nothing authenticates as anon
-- or authenticated against this table, and an authorization table is the last
-- one that should be reachable over the Data API.
ALTER TABLE public."board_collaborators" ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC, anon, authenticated;

GRANT ALL ON ALL TABLES    IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;

-- ------------------------------------------------------------------ gate ----
-- FOUR ASSERTIONS ON THE RESULTING STATE, read from the catalog and the tables
-- themselves -- never from the ORM, and never inferred from the statements
-- above. An ALTER that succeeded says nothing about what is now true:
-- `migrate diff` reports zero drift whether or not an index exists, and a
-- generated client reports what the schema file claims rather than what the
-- database holds.
DO $$
DECLARE
  boards_total     INTEGER;
  owner_rows       INTEGER;
  boards_wrong     INTEGER;
  mismatched       INTEGER;
  missing_indexes  TEXT;
BEGIN
  SELECT count(*) INTO boards_total FROM boards;
  SELECT count(*) INTO owner_rows
    FROM board_collaborators WHERE role = 'OWNER' AND status = 'active';

  -- 1. EXACTLY ONE ACTIVE OWNER PER BOARD. Counts zero AND two: the unique
  --    index forbids two, so this catches the index having silently not been
  --    created as much as it catches a bad backfill.
  SELECT count(*) INTO boards_wrong FROM (
    SELECT b.board_id
      FROM boards b
      LEFT JOIN board_collaborators c
        ON c.board_id = b.board_id AND c.role = 'OWNER' AND c.status = 'active'
     GROUP BY b.board_id
    HAVING count(c.id) <> 1
  ) x;
  IF boards_wrong > 0 THEN
    RAISE EXCEPTION
      'collaborator backfill aborted: % board(s) do not have exactly one active OWNER', boards_wrong;
  END IF;

  -- 2. EVERY OWNER ROW POINTS AT ITS BOARD'S OWN HOST. A row per board is not
  --    enough; the right person has to be on it.
  SELECT count(*) INTO mismatched
    FROM board_collaborators c
    JOIN boards b ON b.board_id = c.board_id
   WHERE c.role = 'OWNER' AND c.status = 'active' AND c.host_id <> b.host_id;
  IF mismatched > 0 THEN
    RAISE EXCEPTION
      'collaborator backfill aborted: % OWNER row(s) do not match their board host_id', mismatched;
  END IF;

  -- 3. THE COUNTS AGREE. Redundant with 1 by construction, and kept because it
  --    fails differently: 1 catches a board without an owner, this catches an
  --    owner row for a board that does not exist, or a second write to the
  --    table between the insert and this gate.
  IF owner_rows <> boards_total THEN
    RAISE EXCEPTION
      'collaborator backfill aborted: % active OWNER rows for % boards', owner_rows, boards_total;
  END IF;

  -- 4. THE INTENDED INDEXES EXIST IN THE RESULTING CATALOG. Both partial
  --    uniques carry an invariant apiece -- 109 and 92 -- and neither is
  --    observable through schema.prisma.
  SELECT string_agg(missing, ', ') INTO missing_indexes FROM (
    SELECT unnest(ARRAY[
      'board_collaborators_live_grant_key',
      'board_collaborators_one_owner_key',
      'idx_board_collaborators_host_status'
    ]) AS missing
    EXCEPT
    SELECT i.relname
      FROM pg_index ix
      JOIN pg_class i ON i.oid = ix.indexrelid
      JOIN pg_class t ON t.oid = ix.indrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public' AND t.relname = 'board_collaborators'
  ) x;
  IF missing_indexes IS NOT NULL THEN
    RAISE EXCEPTION 'collaborator backfill aborted: missing index(es) %', missing_indexes;
  END IF;

  RAISE NOTICE 'board_collaborators: % active OWNER row(s) for % board(s)', owner_rows, boards_total;
END $$;
