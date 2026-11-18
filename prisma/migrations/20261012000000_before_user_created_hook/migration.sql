-- Daali Slice 1 (Auth + Onboarding), S1.8a - the before-user-created hook.
--
-- Auth spec, "The hook": a Postgres before-user-created hook rejects, with
-- HTTP 403,
--   (a) a user with no email - phone-only signups made by calling Supabase
--       directly with the anon key, so every account has a verified email (D3);
--   (b) an anonymous user - anonymous sign-ins stay off, and this makes that a
--       guarantee rather than a setting.
-- It is a pure check and writes nothing. Supabase does not call it for
-- updateUser or automatic identity linking, which is what lets /setup attach a
-- phone or an email to an existing account and Google link to one.
--
-- Contract (Supabase, "Before User Created Hook"): fn(event jsonb) returns
-- jsonb; '{}' allows, {"error": {"http_code", "message"}} rejects. Executable
-- by supabase_auth_admin only; revoked from PUBLIC, anon and authenticated.
--
-- It takes effect only where the project's auth configuration names it
-- (supabase/config.toml locally; the dashboard on a hosted project). Creating
-- the function changes nothing on its own.
--
-- Adds one function. Touches no table.

-- supabase_auth_admin exists on every Supabase database. A plain Postgres (the
-- throwaway test database) does not have it; create it there so the grants
-- below replay, exactly as 0_init does for anon / authenticated / service_role.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_auth_admin') THEN
    CREATE ROLE supabase_auth_admin NOLOGIN NOINHERIT;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.hook_before_user_created(event jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  u jsonb := event -> 'user';
BEGIN
  -- (b) Anonymous users. Supabase marks them is_anonymous = true; the
  -- app_metadata provider is "anonymous" as well. Either is enough.
  IF coalesce((u ->> 'is_anonymous')::boolean, false)
     OR (u -> 'app_metadata' ->> 'provider') = 'anonymous' THEN
    RETURN jsonb_build_object('error', jsonb_build_object(
      'http_code', 403,
      'message', 'Anonymous sign-ins are not allowed.'));
  END IF;

  -- (a) No email.
  IF nullif(btrim(coalesce(u ->> 'email', '')), '') IS NULL THEN
    RETURN jsonb_build_object('error', jsonb_build_object(
      'http_code', 403,
      'message', 'An email address is required to create a Daali account.'));
  END IF;

  RETURN '{}'::jsonb;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.hook_before_user_created(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hook_before_user_created(jsonb) TO supabase_auth_admin;

-- ---------------------------------------------------------------------------
-- FAIL CLOSED, in the form of the table containment self-checks: any finding
-- rolls the whole migration back.
--   1. anon or authenticated can execute the hook, by any route (direct grant,
--      PUBLIC, or role membership) - has_function_privilege;
--   2. any ACL entry grants it to PUBLIC (grantee 0) - aclexplode(proacl);
--   3. supabase_auth_admin cannot execute it (the hook would fail every signup).
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  fn        regprocedure := 'public.hook_before_user_created(jsonb)'::regprocedure;
  exposed   TEXT;
  to_public BOOLEAN;
BEGIN
  SELECT string_agg(r.role, ', ' ORDER BY r.role) INTO exposed
    FROM (VALUES ('anon'), ('authenticated')) AS r(role)
   WHERE has_function_privilege(r.role, fn, 'EXECUTE');
  IF exposed IS NOT NULL THEN
    RAISE EXCEPTION 'hook_before_user_created containment aborted: executable by %', exposed;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) AS a
     WHERE p.oid = fn AND a.grantee = 0
  ) INTO to_public;
  -- A NULL proacl means the default ACL, which includes PUBLIC.
  IF to_public OR (SELECT proacl IS NULL FROM pg_proc WHERE oid = fn) THEN
    RAISE EXCEPTION 'hook_before_user_created containment aborted: executable by PUBLIC';
  END IF;

  IF NOT has_function_privilege('supabase_auth_admin', fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'hook_before_user_created containment aborted: supabase_auth_admin cannot execute it';
  END IF;
END $$;
