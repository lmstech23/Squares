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

pass=0; fail=0
check() { # name expect db direct stripe mode
  local name="$1" expect="$2"
  DATABASE_URL="$3" DIRECT_URL="$4" STRIPE_SECRET_KEY="$5" \
    node scripts/guard-env.mjs "$6" >/dev/null 2>&1
  local rc=$?
  local got="REFUSE"; [ $rc -eq 0 ] && got="PASS"
  if [ "$got" = "$expect" ]; then pass=$((pass+1)); printf '  [ ok ] %-46s %s\n' "$name" "$got"
  else fail=$((fail+1)); printf '  [FAIL] %-46s expected %s got %s\n' "$name" "$expect" "$got"; fi
}

echo "  --- production ---"
check "production, run mode, live stripe"        PASS   "$PROD" "$PROD" "sk_live_x" run
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
check "localhost, test stripe, migrate"          PASS   "$LOCAL" "$LOCAL" "sk_test_x" migrate
check "127.0.0.1, test stripe, migrate"          PASS   "$LOCAL4" "$LOCAL4" "sk_test_x" migrate
check "localhost + LIVE stripe (E2)"             REFUSE "$LOCAL" "$LOCAL" "sk_live_x" run
check "localhost, unrecognised stripe prefix"    REFUSE "$LOCAL" "$LOCAL" "banana" run
check "localhost vs 127.0.0.1 are different"     REFUSE "$LOCAL" "$LOCAL4" "sk_test_x" run

echo ""
echo "  $pass passed, $fail failed"
[ $fail -eq 0 ] || exit 1
