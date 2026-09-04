#!/usr/bin/env bash
# Guard test matrix. Every case states the EXPECTED outcome and the run asserts it.
cd "c:/Users/dtate/Downloads/squares/squares" || exit 1

PROD='postgresql://postgres.xfmonzvdlxbeskugrjmk:pw@aws-1-us-east-1.pooler.supabase.com:5432/postgres'
PRODDIRECT='postgresql://postgres:pw@db.xfmonzvdlxbeskugrjmk.supabase.co:5432/postgres'
STAGING='postgresql://postgres.udbhwoktsvaixpxfepae:pw@aws-1-us-east-1.pooler.supabase.com:5432/postgres'
OTHERPROD='postgresql://postgres.aaaaaaaaaaaaaaaaaaaa:pw@aws-0-eu-west-1.pooler.supabase.com:5432/postgres'
TYPO='postgresql://postgres.xfmonzvdlxbeskugrjmkTYPO:pw@aws-1-us-east-1.pooler.supabase.com:5432/postgres'
SHORT='postgresql://postgres.abc:pw@aws-1-us-east-1.pooler.supabase.com:5432/postgres'
LOCAL='postgresql://postgres:pw@localhost:55432/daali_dev'
LOCAL4='postgresql://postgres:pw@127.0.0.1:55432/daali_dev'
LOCALOTHER='postgresql://postgres:pw@localhost:55432/other_db'
JUNK='not-a-url-at-all'
MYSQL='mysql://root:pw@localhost:3306/x'
RANDOMHOST='postgresql://postgres:pw@some.random.host.example:5432/postgres'

PRODURL='https://xfmonzvdlxbeskugrjmk.supabase.co'
PRODANON='eyJhbGciOiAiSFMyNTYiLCAidHlwIjogIkpXVCJ9.eyJyZWYiOiAieGZtb256dmRseGJlc2t1Z3JqbWsiLCAicm9sZSI6ICJhbm9uIn0.testsig'
PRODSVC='eyJhbGciOiAiSFMyNTYiLCAidHlwIjogIkpXVCJ9.eyJyZWYiOiAieGZtb256dmRseGJlc2t1Z3JqbWsiLCAicm9sZSI6ICJzZXJ2aWNlX3JvbGUifQ.testsig'
OTHERURL='https://aaaaaaaaaaaaaaaaaaaa.supabase.co'
BADURL='https://not-supabase.example.com'
DEVDB='postgresql://postgres.iujjlgfrwavfhqatpqdy:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres'
DEVDIRECT='postgresql://postgres.iujjlgfrwavfhqatpqdy:pw@aws-0-us-east-1.pooler.supabase.com:5432/postgres'
DEVURL='https://iujjlgfrwavfhqatpqdy.supabase.co'
DEVANON='eyJhbGciOiAiSFMyNTYiLCAidHlwIjogIkpXVCJ9.eyJyZWYiOiAiaXVqamxnZnJ3YXZmaHFhdHBxZHkiLCAicm9sZSI6ICJhbm9uIn0.testsig'
DEVSVC='eyJhbGciOiAiSFMyNTYiLCAidHlwIjogIkpXVCJ9.eyJyZWYiOiAiaXVqamxnZnJ3YXZmaHFhdHBxZHkiLCAicm9sZSI6ICJzZXJ2aWNlX3JvbGUifQ.testsig'
# Same as check(), but with ALLOW_PROD_DB set. Kept separate so no ordinary
# case can acquire the override by accident.
checkovr() { # name expect db direct stripe mode [supaUrl] [anon] [service]
  local name="$1" expect="$2"
  ALLOW_PROD_DB=i-understand \
  DATABASE_URL="$3" DIRECT_URL="$4" STRIPE_SECRET_KEY="$5" \
  NEXT_PUBLIC_SUPABASE_URL="${7-}" NEXT_PUBLIC_SUPABASE_ANON_KEY="${8-}" \
  SUPABASE_SERVICE_ROLE_KEY="${9-}" \
    node scripts/guard-env.mjs "$6" >/dev/null 2>&1
  local rc=$?
  local got="REFUSE"; [ $rc -eq 0 ] && got="PASS"
  if [ "$got" = "$expect" ]; then pass=$((pass+1)); printf '  [ ok ] %-46s %s\n' "$name" "$got"
  else fail=$((fail+1)); printf '  [FAIL] %-46s expected %s got %s\n' "$name" "$expect" "$got"; fi
}

pass=0; fail=0
# Supabase API vars are blanked unless a case supplies them, so each case tests
# what its name claims instead of inheriting whatever .env happens to hold.
check() { # name expect db direct stripe mode [supaUrl] [anon] [service]
  local name="$1" expect="$2"
  DATABASE_URL="$3" DIRECT_URL="$4" STRIPE_SECRET_KEY="$5" \
  NEXT_PUBLIC_SUPABASE_URL="${7-}" NEXT_PUBLIC_SUPABASE_ANON_KEY="${8-}" \
  SUPABASE_SERVICE_ROLE_KEY="${9-}" \
    node scripts/guard-env.mjs "$6" >/dev/null 2>&1
  local rc=$?
  local got="REFUSE"; [ $rc -eq 0 ] && got="PASS"
  if [ "$got" = "$expect" ]; then pass=$((pass+1)); printf '  [ ok ] %-46s %s\n' "$name" "$got"
  else fail=$((fail+1)); printf '  [FAIL] %-46s expected %s got %s\n' "$name" "$expect" "$got"; fi
}

echo "  --- production ---"
check "production, run mode, live stripe"         PASS   "$PROD" "$PROD" "sk_live_x" run "$PRODURL" "$PRODANON" "$PRODSVC"
check "production, MIGRATE mode"                 REFUSE "$PROD" "$PROD" "sk_live_x" migrate
check "production + TEST stripe (E2)"            REFUSE "$PROD" "$PROD" "sk_test_x" run
check "production via db.<ref>.supabase.co host" REFUSE "$PRODDIRECT" "$PRODDIRECT" "sk_live_x" migrate

echo "  --- allowlist ---"
check "unknown supabase project (other prod)"    REFUSE "$OTHERPROD" "$OTHERPROD" "sk_test_x" run
check "Squares-staging, NOT allowlisted"         REFUSE "$STAGING" "$STAGING" "sk_test_x" run
check "Squares-staging, migrate"                 REFUSE "$STAGING" "$STAGING" "sk_test_x" migrate

echo "  --- malformed ---"
check "trailing-garbage ref"                     REFUSE "$TYPO" "$TYPO" "sk_test_x" run
check "too-short ref"                            REFUSE "$SHORT" "$SHORT" "sk_test_x" run
check "unparseable url"                          REFUSE "$JUNK" "$JUNK" "sk_test_x" run
check "wrong protocol (mysql)"                   REFUSE "$MYSQL" "$MYSQL" "sk_test_x" run
check "unrecognised host"                        REFUSE "$RANDOMHOST" "$RANDOMHOST" "sk_test_x" run
check "empty DATABASE_URL"                       REFUSE "" "" "sk_test_x" run

echo "  --- mismatch ---"
check "db=local direct=production"               REFUSE "$LOCAL" "$PROD" "sk_test_x" migrate
check "db=local direct=other local db"           REFUSE "$LOCAL" "$LOCALOTHER" "sk_test_x" migrate
check "db=staging direct=local"                  REFUSE "$STAGING" "$LOCAL" "sk_test_x" run

echo "  --- local postgres ---"
check "localhost, test stripe, migrate"          REFUSE "$LOCAL" "$LOCAL" "sk_test_x" migrate
check "127.0.0.1, test stripe, migrate"          REFUSE "$LOCAL4" "$LOCAL4" "sk_test_x" migrate
check "localhost + LIVE stripe (E2)"             REFUSE "$LOCAL" "$LOCAL" "sk_live_x" run
check "localhost, unrecognised stripe prefix"    REFUSE "$LOCAL" "$LOCAL" "banana" run
check "localhost vs 127.0.0.1 are different"     REFUSE "$LOCAL" "$LOCAL4" "sk_test_x" run


echo "  --- supabase api surface ---"
check "local pg, no supabase vars — now refuses"  REFUSE "$LOCAL" "$LOCAL" "sk_test_x" migrate
check "local pg + PRODUCTION supabase url"        REFUSE "$LOCAL" "$LOCAL" "sk_test_x" run "$PRODURL"
check "local pg + unallowlisted supabase url"     REFUSE "$LOCAL" "$LOCAL" "sk_test_x" run "$OTHERURL"
check "local pg + non-supabase url"               REFUSE "$LOCAL" "$LOCAL" "sk_test_x" run "$BADURL"
check "production db + production api, migrate"   REFUSE "$PROD" "$PROD" "sk_live_x" migrate "$PRODURL" "$PRODANON" "$PRODSVC"
check "production api jwt refs are read from claims" REFUSE "$LOCAL" "$LOCAL" "sk_test_x" run "" "$PRODANON"
check "dev db + PRODUCTION api (the 09-04 split)" REFUSE "$STAGING" "$STAGING" "sk_test_x" run "$PRODURL"
check "supabase db + absent api vars"             REFUSE "$STAGING" "$STAGING" "sk_test_x" run ""
check "malformed jwt in anon key"                 REFUSE "$LOCAL" "$LOCAL" "sk_test_x" run "" "eyJnope"

echo "  --- dev happy path (allowlisted) ---"
check "daali-dev everywhere + test stripe, run"    PASS   "$DEVDB" "$DEVDIRECT" "sk_test_x" run "$DEVURL" "$DEVANON" "$DEVSVC"
check "daali-dev everywhere + test stripe, MIGRATE" PASS  "$DEVDB" "$DEVDIRECT" "sk_test_x" migrate "$DEVURL" "$DEVANON" "$DEVSVC"
check "daali-dev db + LIVE stripe"                 REFUSE "$DEVDB" "$DEVDIRECT" "sk_live_x" run "$DEVURL" "$DEVANON" "$DEVSVC"
check "daali-dev db + PRODUCTION api url"          REFUSE "$DEVDB" "$DEVDIRECT" "sk_test_x" run "$PRODURL" "$DEVANON" "$DEVSVC"
check "daali-dev db + PRODUCTION service jwt"      REFUSE "$DEVDB" "$DEVDIRECT" "sk_test_x" run "$DEVURL" "$DEVANON" "$PRODSVC"
check "daali-dev db + staging direct url"          REFUSE "$DEVDB" "$STAGING" "sk_test_x" migrate "$DEVURL" "$DEVANON" "$DEVSVC"
check "daali-dev db + absent api vars"             REFUSE "$DEVDB" "$DEVDIRECT" "sk_test_x" run

echo "  --- production migration policy / override ---"
check    "A prod db+api+live, MIGRATE, no override"  REFUSE "$PROD" "$PROD" "sk_live_x" migrate "$PRODURL" "$PRODANON" "$PRODSVC"
checkovr "B same + ALLOW_PROD_DB override"           PASS   "$PROD" "$PROD" "sk_live_x" migrate "$PRODURL" "$PRODANON" "$PRODSVC"
checkovr "C dev everywhere + override, MIGRATE"      PASS   "$DEVDB" "$DEVDIRECT" "sk_test_x" migrate "$DEVURL" "$DEVANON" "$DEVSVC"
# The override must unlock ONLY the production-migrate block. Everything else
# still has to hold, or it becomes a skeleton key.
checkovr "override does NOT excuse a prod api split" REFUSE "$DEVDB" "$DEVDIRECT" "sk_test_x" migrate "$PRODURL" "$DEVANON" "$DEVSVC"
checkovr "override does NOT excuse live stripe"      REFUSE "$DEVDB" "$DEVDIRECT" "sk_live_x" migrate "$DEVURL" "$DEVANON" "$DEVSVC"
checkovr "override does NOT excuse a url mismatch"   REFUSE "$DEVDB" "$STAGING" "sk_test_x" migrate "$DEVURL" "$DEVANON" "$DEVSVC"
checkovr "override does NOT excuse absent api vars"  REFUSE "$DEVDB" "$DEVDIRECT" "sk_test_x" migrate
echo ""
echo "  $pass passed, $fail failed"
[ $fail -eq 0 ] || exit 1
