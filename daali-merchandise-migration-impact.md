# Daali Merchandise — Migration Impact Assessment

**Status:** For approval. Nothing applied anywhere.
**Date:** October 16, 2026
**Companion to:** `daali-merchandise-architecture.md` Revision 3.4 · this document updated to match the migration as built (`prisma/migrations/20261017000000_daali_merch/migration.sql`, sha256 `8a279618…b490cd`)
**Baseline:** `main` at `ab6de64`; last applied migration in the repo `20260921000000_board_entry_ticket_limit` [REPO]. Production's applied list is confirmed with `prisma migrate status` over `DIRECT_URL` immediately before applying.

## 1. Summary

| Question | Answer |
|---|---|
| Existing tables altered | **None** |
| Existing rows read, written or backfilled | **None** |
| Objects created | 7 tables, 8 enum types, indexes and CHECK constraints on those tables only |
| Locks on existing tables | **None** — `CREATE TABLE` / `CREATE INDEX` on brand-new tables only |
| Downtime | None |
| Effect on running Board code | None; it never references the new tables |
| Sequences | None (UUID keys, like the rest of the schema) |
| Reversible | Yes before real orders exist (drop the seven tables); after that, disable routes and keep the data |

## 2. Migration

`prisma/migrations/20261017000000_daali_merch/migration.sql`, applied only through `npm run db:migrate:production`, which runs `verify-containment.mts` against the same database and fails the run if containment fails [REPO, `CLAUDE.md`].

### 2.1 Enum types (new)

| Type | Values |
|---|---|
| `daali_merch_context` | STANDALONE *(EVENT, FUNDRAISER added later with `ALTER TYPE … ADD VALUE`)* |
| `daali_merch_listing_status` | DRAFT, OPEN, CLOSED |
| `daali_merch_price_mode` | FREE, PAID *(INCLUDED added later)* |
| `daali_merch_fulfillment_kind` | PICKUP, SHIP |
| `daali_merch_order_status` | PENDING_PAYMENT, PAID, CONFIRMED_FREE, EXPIRED, CANCELLED, REFUNDED, PARTIALLY_REFUNDED |
| `daali_merch_fulfillment_status` | UNFULFILLED, HANDED_OUT, SHIPPED |
| `daali_merch_tax_handling` | INCLUDED_ORGANIZER_REMITS, EXEMPT_CONFIRMED, NOT_DUE_CONFIRMED |
| `daali_merch_notification_status` | PENDING, SENDING, SENT, FAILED |

### 2.2 Tables

**`daali_merch_listings`**
`id uuid PK` · `owner_user_id text NOT NULL` (Supabase user id; no FK — `auth.users` is outside `public`) · `context` · `slug text UNIQUE` · `title` · `description` · `status` (default DRAFT) · `closes_at timestamptz` · `redirect_url text` · `redirect_verified_at` · `redirect_verified_by text` · `questions jsonb NOT NULL DEFAULT '[]'` · `tax_handling` · `tax_confirmed_at` · `tax_confirmed_by text` · `created_at` · `updated_at`
CHECKs: STANDALONE ⇒ slug NOT NULL; slug matches `^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])$`; redirect_url NULL or starts `https://`; redirect_verified_at NULL when redirect_url NULL; tax_handling and tax_confirmed_at set together; `jsonb_array_length(questions) <= 5` (amended in spec Revision 3.8 by `20261026000000_daali_merch_questions_max5`; originally `<= 2`, constraint `daali_merch_listings_questions_max2`).

**`daali_merch_items`**
`id` · `listing_id → listings ON DELETE CASCADE` · `name` · `description` · `image_url` · `sort int` · `price_mode` · `net_cents int` · `per_order_limit int NOT NULL DEFAULT 10` · `active bool DEFAULT true`
CHECKs: PAID ⇔ net_cents NOT NULL; net_cents between 50 and 100000; per_order_limit between 1 and 100.

**`daali_merch_variants`**
`id` · `item_id → items ON DELETE CASCADE` · `label` · `sort` · `stock_limit int` · `active bool DEFAULT true`
CHECKs: stock_limit NULL or ≥ 0; UNIQUE (item_id, label).

**`daali_merch_fulfillment_options`**
`id` · `listing_id → listings ON DELETE CASCADE` · `label` · `kind` · `sort` · `active bool DEFAULT true`

**`daali_merch_orders`**
`id` · `listing_id → listings ON DELETE RESTRICT` · `public_token text UNIQUE` · `idempotency_key text UNIQUE` · `buyer_name` · `buyer_email` · `buyer_phone` · `fulfillment_option_id → fulfillment_options ON DELETE RESTRICT` · `answers jsonb` · `status` · `total_cents int` · `organizer_net_cents int` · `pricing_version text` · `stripe_account_id text` · `stripe_session_id text UNIQUE` · `stripe_payment_intent_id text UNIQUE` · `checkout_params jsonb` (frozen line items, amounts, payee, expires_at — spec §5.7) · `checkout_url text` · `checkout_attempts int DEFAULT 0` · `checkout_error text` · `stripe_fee_cents int` · `refunded_cents int DEFAULT 0` · `redirect_snapshot_url text` · `hold_expires_at` · `paid_at` · `confirmed_at` · `cancelled_at` · `ip_hash text` · `oversell_flag bool DEFAULT false` · `fulfillment_status DEFAULT UNFULFILLED` · `handed_out_at` · `handed_out_by text` · `created_at`
CHECKs: buyer_email = lower(btrim(buyer_email)); total_cents ≥ 0; 0 ≤ refunded_cents ≤ total_cents; PENDING_PAYMENT ⇒ hold_expires_at, stripe_account_id and checkout_params NOT NULL; checkout_url NOT NULL ⇔ stripe_session_id NOT NULL; PAID ⇒ paid_at and stripe_session_id NOT NULL; CONFIRMED_FREE ⇒ total_cents = 0 and stripe_session_id NULL.

**`daali_merch_order_lines`**
`id` · `order_id → orders ON DELETE CASCADE` · `item_id → items ON DELETE RESTRICT` · `variant_id → variants ON DELETE RESTRICT` · `quantity int` · `unit_price_cents int` · `unit_net_cents int` · `item_name` · `variant_label`
CHECKs: quantity between 1 and 100; unit prices ≥ 0.

**`daali_merch_notifications`** (receipt outbox — spec §5.8; same shape as the existing `notification_deliveries` [REPO])
`id` · `order_id → orders ON DELETE RESTRICT` · `kind text` (RECEIPT, FREE_CONFIRMATION) · `status daali_merch_notification_status DEFAULT 'PENDING'` · `attempts int DEFAULT 0` · `first_attempt_at timestamptz` (start of the 23-hour auto-send window, spec §5.8.1) · `next_attempt_at timestamptz DEFAULT now()` · `locked_at` · `lock_token text` · `idempotency_suffix int DEFAULT 0` (bumped by a host-triggered resend) · `provider_message_id text` · `last_error text` · `sent_at` · `created_at`
UNIQUE `(order_id, kind)`; CHECKs: SENT ⇔ sent_at NOT NULL; SENDING ⇒ locked_at and lock_token NOT NULL; attempts between 0 and 50.

`ON DELETE RESTRICT` on anything an order references means an item or size that has been ordered can be deactivated but never deleted, so order history and the CSV stay intact.

### 2.3 Indexes (beyond PKs and the UNIQUEs above)

| Index | Purpose |
|---|---|
| orders `(listing_id, status)` | Host orders page, stock sums |
| orders `(hold_expires_at) WHERE status = 'PENDING_PAYMENT'` | Reconciliation cron |
| orders `(created_at) WHERE status = 'PENDING_PAYMENT' AND stripe_session_id IS NULL` | Checkout recovery (spec §5.7) |
| notifications `(status, next_attempt_at)` | Receipt retry claim, as `idx_notification_deliveries_claim` |
| orders UNIQUE `(listing_id, buyer_email) WHERE status = 'CONFIRMED_FREE'` | D10 duplicate free orders |
| orders `(listing_id, buyer_email, created_at)` | D10 per-email rate limit |
| orders `(listing_id, ip_hash, created_at)` | D10 per-IP rate limit |
| order_lines `(variant_id)` | Stock sums |
| listings `(owner_user_id)` | Host dashboard list |

### 2.4 Security — scoped to the seven new tables

Earlier repo migrations (e.g. `20260909000000_board_invites`) end with schema-wide `REVOKE ALL ON ALL TABLES … / GRANT ALL ON ALL TABLES …`. **This migration does not.** Every privilege statement names only the new tables:

```sql
ALTER TABLE public."daali_merch_listings" ENABLE ROW LEVEL SECURITY;
-- … one ENABLE per table, all seven named explicitly

REVOKE ALL ON TABLE
  public."daali_merch_listings", public."daali_merch_items", public."daali_merch_variants",
  public."daali_merch_fulfillment_options", public."daali_merch_orders",
  public."daali_merch_order_lines", public."daali_merch_notifications"
  FROM PUBLIC, anon, authenticated;

GRANT ALL ON TABLE
  -- the same seven tables
  TO service_role;
```

- No `ON ALL TABLES`, no `ON ALL SEQUENCES`, no `ALTER DEFAULT PRIVILEGES`. No sequences are created (UUID keys), so there is nothing sequence-level to grant or revoke.
- `0_init`'s default privileges (`FOR ROLE postgres`) already withhold `anon`/`authenticated` on new tables created by `postgres`; the explicit `REVOKE` is a second, table-scoped layer that also covers a run under the wrong role.
- No policies: nothing is client-readable; all access is server-side through Prisma. None of the tables goes in `CLIENT_ACCESSIBLE`.
- **In-migration gate** (same style as recent migrations): a `DO $$` block reads the catalog and raises — rolling the migration back — if any of the seven tables lacks RLS, if `anon` or `authenticated` holds any privilege on them, or if the expected indexes are missing.

**Proof that no existing table's permissions change.** `scripts/verify-merch-migration-scope.mts` (new, rehearsal-only) snapshots, for every relation in `public` **other than** `daali_merch_*`: `pg_class.relacl`, `relrowsecurity`, `relforcerowsecurity`, every `pg_policy` row, and the full `information_schema.role_table_grants` / `role_usage_grants` sets. It runs before and after applying the migration on the disposable database and fails on any difference. The result is part of the test report.

**`CLAUDE.md` S1 preconditions:**
1. Assert `SELECT current_user` = `postgres` **over `DIRECT_URL`** before applying.
2. RLS name-set diff: the set of `daali_merch_%` tables in `pg_class` equals the set with `relrowsecurity = true`, both derived from the catalog.
3. No sequences are created; nothing depends on sequence statements.

## 3. Prisma schema impact

- Seven models and eight enums appended to `prisma/schema.prisma` with `@@map` to the table names. No existing model, relation or enum edited. **No `prisma format`** (scope rule).
- `prisma generate` before tsc, tests and build (generate rule).
- CHECK constraints and partial indexes live only in migration SQL. The test database is rebuilt by **replaying migrations**, never `db push`, so the integration tests exercise them.

## 4. Other production configuration (outside the database)

| Item | Change | Reversible |
|---|---|---|
| Stripe live Dashboard | New Connect webhook endpoint `https://beta.daali.app/api/webhooks/merch`, events `checkout.session.completed`, `checkout.session.expired`, `charge.refunded`, **listening on connected accounts**. Existing endpoint untouched | Disable or delete the endpoint |
| Vercel env | `STRIPE_MERCH_WEBHOOK_SECRET`, `MERCH_IP_HASH_SALT`, `MERCH_SALES_ENABLED` (**new sales only**: off stops sale pages, new orders, new checkout sessions, sale creation and publishing; the webhook, return gate, cron, receipts and host order actions keep running — spec §13.1). `NEXT_PUBLIC_URL` stays `https://beta.daali.app` (unchanged; the selected merch host, spec §13.2), the same host as the Stripe endpoint | Set `MERCH_SALES_ENABLED=false` to stop new sales. Never a way to stop payment processing |
| Supabase Storage | New public-read bucket `merch-images`, server-side uploads only (same pattern as `hbcu-logos` [REPO]) | Delete bucket |
| `vercel.json` | One cron: `/api/cron/merch-reconcile` every 10 minutes | Remove line |

## 5. Deployment order

1. Rehearse the migration on a disposable database (replay all migrations, then this one); run the integration suite.
2. `prisma migrate status` over `DIRECT_URL`: production matches the repo up to `20260921000000`.
3. Assert `current_user = postgres` over `DIRECT_URL`.
4. `DIRECT_URL=… VERIFY_SITE_URL=https://beta.daali.app npm run db:migrate:production` — must exit 0 (containment + site smoke). The live site is unaffected: no deployed code touches the new tables.
5. RLS name-set diff (§2.4).
6. Stripe live webhook endpoint, Vercel env vars, storage bucket.
7. Push the code (every push to `main` deploys production).
8. Host creates the Wizards listing as a draft; one live purchase on a $1 test item, then refund it; check the existing Board webhook logged no errors and wrote nothing.

Migration-before-code is deliberate: tables existing ahead of code is harmless; code ahead of tables would fail merch routes.

## 6. Rollback

Forward-only, like every migration in this repo. **Rows in `_prisma_migrations` are never edited or deleted by hand.**

| Situation | Rollback |
|---|---|
| Code problem | Vercel rollback to the previous deployment. Tables stay; nothing references them |
| Migration fails while applying | It runs as one transaction, so a failure leaves no merch objects behind (verified in rehearsal by forcing a failure on the last statement, both as one simple-query message and through `prisma migrate deploy`). Prisma records the attempt as failed and refuses every later `migrate deploy` until it is resolved (verified). After the cause is fixed, the documented command `prisma migrate resolve --rolled-back <name>` marks it, and the migration is re-applied through the guarded path |
| Applied, needs removing, **no real orders yet** | A new, reviewed forward migration `…_drop_daali_merch` drops the seven tables and eight types, applied through `db:migrate:production` with containment. It is written and rehearsed now, kept unapplied, so it is ready if needed |
| After real orders exist — **stop new sales** | Never drop. Set `MERCH_SALES_ENABLED=false` (and close the listings). New orders and new checkout sessions stop. Everything already in flight keeps settling: payments made on sessions that already exist are processed and redirected, refunds and expirations are applied, the cron reconciles, receipts send, and hosts keep their orders page and CSV. Covered by the shutdown tests in spec §9 |
| After real orders exist — **code problem** | Vercel rollback to the previous deployment that has the merch code. Do **not** roll back past the first merch deployment while orders are pending or refundable, because the merch webhook and cron would disappear. If that is unavoidable, disable the merch endpoint in Stripe first (Stripe queues and retries for up to three days), and redeploy merch within that window so the cron settles from Stripe directly |
| Emergency: stop payment processing | Disable the merch webhook endpoint in the Stripe Dashboard. Do not use the sales switch for this, because it deliberately leaves payment processing running |

## 7. Risks

| Risk | Mitigation |
|---|---|
| New tables created without RLS (has happened twice, Sep 7) | Guarded migrate path fails the run; name-set diff; explicit `ENABLE` per table |
| Migration run by a role other than `postgres` escapes default-privilege revokes | `current_user` assertion over `DIRECT_URL` before applying |
| CHECKs silently missing in tests | Test DB replays migrations; never `db push` |
| Privilege statements touch existing tables | Not possible: every statement names only the seven new tables; proven by the before/after permission snapshot of every other relation |
| Legacy webhook reacts to merch events | Verified by code reading and an integration test before deploy |
| Docs-only or migration commit triggers a production deploy | Migration ships in the same commit as the code that uses it, after step 4 has been run manually; or the commit lands only once approved |

---

## Amendment — Revision 3.8: up to 5 buyer questions (October 26, 2026)

**Migration:** `prisma/migrations/20261026000000_daali_merch_questions_max5`.

- **What it does:** drops `daali_merch_listings_questions_max2` and adds `daali_merch_listings_questions_max5`: `CHECK (jsonb_typeof(questions) = 'array' AND jsonb_array_length(questions) <= 5)`.
- **Data:** none changed. It only loosens a limit; every existing listing has 2 or fewer questions and satisfies the new check (checked Oct 26: dev 3 listings, max 0; production 0 listings).
- **Security:** no table, column, grant, RLS or policy change, so containment is unaffected. The containment check still runs on the guarded production path.
- **Order:** dev → Preview test → production through `npm run db:migrate:production`, then the code deploy. Code allowing 5 questions must not reach production before the migration; a sale saved with 3 or more questions would otherwise fail on the old check.
- **Rollback:** forward-only. Returning to 2 is possible only while no listing has more than 2 questions.
