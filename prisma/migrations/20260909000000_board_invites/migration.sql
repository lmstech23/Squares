-- Manager invitations. collaborators v2.2 §5. Invariants 96-100, 119.
--
-- THE LINK IS AN INVITATION AND NEVER AN AUTHORIZATION -- invariant 96.
-- Possession offers access; it never grants it. Authorization remains the
-- `board_collaborators` row, and this table exists only so acceptance has
-- something to consume.
--
-- HASHED AT REST, like `volunteer_access.token_hash` and
-- `supporter_access_tokens.token_hash`. The raw token is shown to the owner
-- ONCE and never stored, so a database read cannot produce a working link.

CREATE TYPE "invite_status" AS ENUM ('pending', 'accepted', 'revoked');

CREATE TABLE "board_invites" (
  "id"                  UUID NOT NULL DEFAULT gen_random_uuid(),
  "board_id"            UUID NOT NULL,
  -- MANAGER ONLY. `board_role` carries OWNER too, and a CHECK below refuses it:
  -- invariant 100 says there is no path from an invite to owner-level access,
  -- and ownership transfer is a different act with a different audit trail.
  "role"                "board_role" NOT NULL,
  "token_hash"          TEXT NOT NULL,
  -- NULL means a BEARER invitation: whoever validly accepts first becomes the
  -- manager. Set, it binds acceptance to an authenticated identity whose
  -- VERIFIED EMAIL matches -- never to `hosts.email`, which is not unique and
  -- may hold a phone number or a UUID.
  "bound_email"         TEXT,
  "created_by_host_id"  UUID NOT NULL,
  "expires_at"          TIMESTAMPTZ(6) NOT NULL,
  -- SET ONCE, conditionally, in the transaction that creates the collaborator
  -- row -- invariant 97. Never cleared.
  "accepted_at"         TIMESTAMPTZ(6),
  "accepted_by_host_id" UUID,
  -- The owner cancelling an unused invitation, and the mechanism invariant 119
  -- uses when a collaborator is revoked.
  "revoked_at"          TIMESTAMPTZ(6),
  "revoked_by_host_id"  UUID,
  "created_at"          TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

  CONSTRAINT "board_invites_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "board_invites" ADD CONSTRAINT "board_invites_board_id_fkey"
  FOREIGN KEY ("board_id") REFERENCES "boards"("board_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "board_invites" ADD CONSTRAINT "board_invites_created_by_host_id_fkey"
  FOREIGN KEY ("created_by_host_id") REFERENCES "hosts"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "board_invites" ADD CONSTRAINT "board_invites_accepted_by_host_id_fkey"
  FOREIGN KEY ("accepted_by_host_id") REFERENCES "hosts"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "board_invites" ADD CONSTRAINT "board_invites_revoked_by_host_id_fkey"
  FOREIGN KEY ("revoked_by_host_id") REFERENCES "hosts"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- INVARIANT 100, AT THE DATABASE. Application logic refuses an OWNER invite;
-- this makes the row unrepresentable, the same belt-and-braces
-- `admission_grants_standalone_never_donates` applies to its own rule.
ALTER TABLE "board_invites" ADD CONSTRAINT "board_invites_manager_only"
  CHECK ("role" = 'MANAGER');

-- ACCEPTANCE FIELDS ARRIVE TOGETHER. An `accepted_at` with no host is a record
-- of an acceptance by nobody, which no reader could act on.
ALTER TABLE "board_invites" ADD CONSTRAINT "board_invites_accept_fields_together"
  CHECK (("accepted_at" IS NULL) = ("accepted_by_host_id" IS NULL));

-- AN INVITE IS ACCEPTED OR REVOKED, NEVER BOTH -- invariant 99 read as a state
-- machine rather than as two independent flags.
ALTER TABLE "board_invites" ADD CONSTRAINT "board_invites_not_both_resolutions"
  CHECK ("accepted_at" IS NULL OR "revoked_at" IS NULL);

-- The token is the lookup key and must be unique: two invites hashing alike
-- would make acceptance ambiguous.
CREATE UNIQUE INDEX "board_invites_token_hash_key"
  ON "board_invites" ("token_hash");

-- The owner's pending list, and the query invariant 119 runs on revocation.
CREATE INDEX "idx_board_invites_board_pending"
  ON "board_invites" ("board_id")
  WHERE "accepted_at" IS NULL AND "revoked_at" IS NULL;

-- ------------------------------------------------------------- containment --
ALTER TABLE public."board_invites" ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC, anon, authenticated;

GRANT ALL ON ALL TABLES    IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;

-- ------------------------------------------------------------------ gate ----
-- Read from the catalog, never inferred from the statements above.
DO $$
DECLARE
  missing TEXT;
  rls     BOOLEAN;
BEGIN
  SELECT string_agg(name, ', ') INTO missing FROM (
    SELECT unnest(ARRAY[
      'board_invites_token_hash_key',
      'idx_board_invites_board_pending'
    ]) AS name
    EXCEPT
    SELECT i.relname
      FROM pg_index ix
      JOIN pg_class i ON i.oid = ix.indexrelid
      JOIN pg_class t ON t.oid = ix.indrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public' AND t.relname = 'board_invites'
  ) x;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'board_invites aborted: missing index(es) %', missing;
  END IF;

  SELECT c.relrowsecurity INTO rls
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'board_invites';
  IF rls IS NOT TRUE THEN
    RAISE EXCEPTION 'board_invites aborted: RLS is not enabled';
  END IF;
END $$;
