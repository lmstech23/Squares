-- Public theming, Deploy 1. docs/public-theme-spec.md v3.1 §2, §2.1.
--
-- Additive and inert. A new table nothing references yet, and three nullable
-- Board columns with no default and no backfill. Every existing board reads
-- NULL in all three, and NULL is exactly today's render (spec invariants 1, 11,
-- 12). Nothing is assigned to any board by this migration.
--
-- The statements between here and the containment block are spec §2's SQL,
-- verbatim.

CREATE TYPE "theme_surface" AS ENUM ('LIGHT', 'DARK');

CREATE TABLE public.public_themes (
  theme_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organizer_user_id text NOT NULL,
  primary_color     text NOT NULL,
  surface           "theme_surface" NOT NULL DEFAULT 'DARK',
  hero_image_url    text,
  created_at        timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT public_themes_primary_color_check CHECK (primary_color ~ '^#[0-9A-F]{6}$')
);

ALTER TABLE public.boards
  ADD COLUMN theme_id uuid,
  ADD COLUMN donation_default_cents integer,
  ADD COLUMN public_organizer_label text;

ALTER TABLE public.boards
  ADD CONSTRAINT boards_public_organizer_label_check
  CHECK (public_organizer_label IS NULL
         OR (char_length(public_organizer_label) BETWEEN 1 AND 60
             AND public_organizer_label = btrim(public_organizer_label))) NOT VALID;
ALTER TABLE public.boards VALIDATE CONSTRAINT boards_public_organizer_label_check;

ALTER TABLE public.boards
  ADD CONSTRAINT boards_donation_default_cents_check
  CHECK (donation_default_cents IS NULL OR donation_default_cents > 0) NOT VALID;
ALTER TABLE public.boards VALIDATE CONSTRAINT boards_donation_default_cents_check;

ALTER TABLE public.boards
  ADD CONSTRAINT boards_theme_id_fkey
  FOREIGN KEY (theme_id) REFERENCES public.public_themes(theme_id)
  ON DELETE RESTRICT ON UPDATE NO ACTION NOT VALID;
ALTER TABLE public.boards VALIDATE CONSTRAINT boards_theme_id_fkey;

-- ------------------------------------------------------------- containment --
-- The board_invites block, verbatim, targeting public_themes.
ALTER TABLE public."public_themes" ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC, anon, authenticated;

GRANT ALL ON ALL TABLES    IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;

-- ------------------------------------------------------------------ gate ----
-- Read from the catalog, never inferred from the statements above. Same shape
-- as board_invites' gate: a table without RLS, or a constraint that did not
-- land, aborts the migration rather than reaching the Data API.
DO $$
DECLARE
  missing TEXT;
  rls     BOOLEAN;
BEGIN
  SELECT string_agg(name, ', ') INTO missing FROM (
    SELECT unnest(ARRAY[
      'public_themes_pkey',
      'public_themes_primary_color_check',
      'boards_public_organizer_label_check',
      'boards_donation_default_cents_check',
      'boards_theme_id_fkey'
    ]) AS name
    EXCEPT
    SELECT c.conname
      FROM pg_constraint c
      JOIN pg_namespace n ON n.oid = c.connamespace
     WHERE n.nspname = 'public' AND c.convalidated
  ) x;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'public_themes aborted: missing or unvalidated constraint(s) %', missing;
  END IF;

  SELECT c.relrowsecurity INTO rls
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'public_themes';
  IF rls IS NOT TRUE THEN
    RAISE EXCEPTION 'public_themes aborted: RLS is not enabled';
  END IF;
END $$;
