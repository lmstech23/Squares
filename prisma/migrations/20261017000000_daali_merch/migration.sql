-- Daali Merchandise — standalone merch sales (spec: daali-merchandise-architecture.md
-- Revision 3.1; impact: daali-merchandise-migration-impact.md).
--
-- ADDITIVE ONLY. Seven new tables and eight new enum types, all `daali_merch_`
-- prefixed. No existing table, column, index, policy or privilege is created,
-- altered, dropped, read or backfilled.
--
-- PRIVILEGES ARE TABLE-SCOPED. Unlike earlier migrations, nothing here uses
-- `ON ALL TABLES` / `ON ALL SEQUENCES` / `ALTER DEFAULT PRIVILEGES`: every
-- REVOKE and GRANT names the seven new tables, so no existing relation's ACL
-- can change. `scripts/verify-merch-migration-scope.mts` proves that in
-- rehearsal by diffing every other relation's privileges before and after.
--
-- UUID keys only, so no sequences are created.

-- ------------------------------------------------------------------ enums --
CREATE TYPE "daali_merch_context"             AS ENUM ('STANDALONE');
CREATE TYPE "daali_merch_listing_status"      AS ENUM ('DRAFT', 'OPEN', 'CLOSED');
CREATE TYPE "daali_merch_price_mode"          AS ENUM ('FREE', 'PAID');
CREATE TYPE "daali_merch_fulfillment_kind"    AS ENUM ('PICKUP', 'SHIP');
CREATE TYPE "daali_merch_order_status"        AS ENUM ('PENDING_PAYMENT', 'PAID', 'CONFIRMED_FREE', 'EXPIRED', 'CANCELLED', 'REFUNDED', 'PARTIALLY_REFUNDED');
CREATE TYPE "daali_merch_fulfillment_status"  AS ENUM ('UNFULFILLED', 'HANDED_OUT', 'SHIPPED');
CREATE TYPE "daali_merch_tax_handling"        AS ENUM ('INCLUDED_ORGANIZER_REMITS', 'EXEMPT_CONFIRMED', 'NOT_DUE_CONFIRMED');
CREATE TYPE "daali_merch_notification_status" AS ENUM ('PENDING', 'SENDING', 'SENT', 'FAILED');

-- --------------------------------------------------------------- listings --
-- owner_user_id is the Supabase user id (= hosts.supabase_user_id), text and
-- deliberately not a Host FK — the same choice public_themes made.
CREATE TABLE "daali_merch_listings" (
  "id"                   UUID NOT NULL DEFAULT gen_random_uuid(),
  "owner_user_id"        TEXT NOT NULL,
  "context"              "daali_merch_context" NOT NULL DEFAULT 'STANDALONE',
  "slug"                 TEXT,
  "title"                TEXT NOT NULL,
  "description"          TEXT,
  "status"               "daali_merch_listing_status" NOT NULL DEFAULT 'DRAFT',
  "closes_at"            TIMESTAMPTZ(6),
  "redirect_url"         TEXT,
  "redirect_verified_at" TIMESTAMPTZ(6),
  "redirect_verified_by" TEXT,
  "questions"            JSONB NOT NULL DEFAULT '[]'::jsonb,
  "tax_handling"         "daali_merch_tax_handling",
  "tax_confirmed_at"     TIMESTAMPTZ(6),
  "tax_confirmed_by"     TEXT,
  "created_at"           TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"           TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "daali_merch_listings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "daali_merch_listings_standalone_slug" CHECK ("context" <> 'STANDALONE' OR "slug" IS NOT NULL),
  CONSTRAINT "daali_merch_listings_slug_format" CHECK ("slug" IS NULL OR "slug" ~ '^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])$'),
  CONSTRAINT "daali_merch_listings_redirect_https" CHECK ("redirect_url" IS NULL OR "redirect_url" LIKE 'https://%'),
  CONSTRAINT "daali_merch_listings_redirect_verified_needs_url" CHECK ("redirect_verified_at" IS NULL OR "redirect_url" IS NOT NULL),
  CONSTRAINT "daali_merch_listings_tax_together" CHECK (("tax_handling" IS NULL) = ("tax_confirmed_at" IS NULL)),
  CONSTRAINT "daali_merch_listings_questions_max2" CHECK (jsonb_typeof("questions") = 'array' AND jsonb_array_length("questions") <= 2),
  CONSTRAINT "daali_merch_listings_title_len" CHECK (char_length("title") BETWEEN 1 AND 120)
);
CREATE UNIQUE INDEX "daali_merch_listings_slug_key" ON "daali_merch_listings" ("slug");
CREATE INDEX "idx_daali_merch_listings_owner" ON "daali_merch_listings" ("owner_user_id");

-- ------------------------------------------------------------------ items --
CREATE TABLE "daali_merch_items" (
  "id"              UUID NOT NULL DEFAULT gen_random_uuid(),
  "listing_id"      UUID NOT NULL,
  "name"            TEXT NOT NULL,
  "description"     TEXT,
  "image_url"       TEXT,
  "sort"            INTEGER NOT NULL DEFAULT 0,
  "price_mode"      "daali_merch_price_mode" NOT NULL,
  "net_cents"       INTEGER,
  "per_order_limit" INTEGER NOT NULL DEFAULT 10,
  "active"          BOOLEAN NOT NULL DEFAULT true,
  CONSTRAINT "daali_merch_items_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "daali_merch_items_listing_fkey" FOREIGN KEY ("listing_id") REFERENCES "daali_merch_listings"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "daali_merch_items_paid_has_net" CHECK (("price_mode" = 'PAID') = ("net_cents" IS NOT NULL)),
  CONSTRAINT "daali_merch_items_net_range" CHECK ("net_cents" IS NULL OR "net_cents" BETWEEN 50 AND 100000),
  CONSTRAINT "daali_merch_items_per_order_limit" CHECK ("per_order_limit" BETWEEN 1 AND 100),
  CONSTRAINT "daali_merch_items_name_len" CHECK (char_length("name") BETWEEN 1 AND 120)
);
CREATE INDEX "idx_daali_merch_items_listing" ON "daali_merch_items" ("listing_id");

-- --------------------------------------------------------------- variants --
CREATE TABLE "daali_merch_variants" (
  "id"          UUID NOT NULL DEFAULT gen_random_uuid(),
  "item_id"     UUID NOT NULL,
  "label"       TEXT NOT NULL,
  "sort"        INTEGER NOT NULL DEFAULT 0,
  "stock_limit" INTEGER,
  "active"      BOOLEAN NOT NULL DEFAULT true,
  CONSTRAINT "daali_merch_variants_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "daali_merch_variants_item_fkey" FOREIGN KEY ("item_id") REFERENCES "daali_merch_items"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "daali_merch_variants_stock_nonneg" CHECK ("stock_limit" IS NULL OR "stock_limit" >= 0),
  CONSTRAINT "daali_merch_variants_label_len" CHECK (char_length("label") BETWEEN 1 AND 40)
);
CREATE UNIQUE INDEX "daali_merch_variants_item_label_key" ON "daali_merch_variants" ("item_id", "label");

-- ---------------------------------------------------- fulfillment options --
CREATE TABLE "daali_merch_fulfillment_options" (
  "id"         UUID NOT NULL DEFAULT gen_random_uuid(),
  "listing_id" UUID NOT NULL,
  "label"      TEXT NOT NULL,
  "kind"       "daali_merch_fulfillment_kind" NOT NULL DEFAULT 'PICKUP',
  "sort"       INTEGER NOT NULL DEFAULT 0,
  "active"     BOOLEAN NOT NULL DEFAULT true,
  CONSTRAINT "daali_merch_fulfillment_options_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "daali_merch_fulfillment_options_listing_fkey" FOREIGN KEY ("listing_id") REFERENCES "daali_merch_listings"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "daali_merch_fulfillment_options_label_len" CHECK (char_length("label") BETWEEN 1 AND 120)
);
CREATE INDEX "idx_daali_merch_fulfillment_options_listing" ON "daali_merch_fulfillment_options" ("listing_id");

-- ----------------------------------------------------------------- orders --
CREATE TABLE "daali_merch_orders" (
  "id"                       UUID NOT NULL DEFAULT gen_random_uuid(),
  "listing_id"               UUID NOT NULL,
  "public_token"             TEXT NOT NULL,
  "idempotency_key"          TEXT NOT NULL,
  "buyer_name"               TEXT NOT NULL,
  "buyer_email"              TEXT NOT NULL,
  "buyer_phone"              TEXT,
  "fulfillment_option_id"    UUID,
  "answers"                  JSONB NOT NULL DEFAULT '{}'::jsonb,
  "status"                   "daali_merch_order_status" NOT NULL,
  "total_cents"              INTEGER NOT NULL,
  "organizer_net_cents"      INTEGER NOT NULL,
  "pricing_version"          TEXT NOT NULL,
  "stripe_account_id"        TEXT,
  "stripe_session_id"        TEXT,
  "stripe_payment_intent_id" TEXT,
  "checkout_params"          JSONB,
  "checkout_url"             TEXT,
  "checkout_attempts"        INTEGER NOT NULL DEFAULT 0,
  "checkout_error"           TEXT,
  "stripe_fee_cents"         INTEGER,
  "refunded_cents"           INTEGER NOT NULL DEFAULT 0,
  "redirect_snapshot_url"    TEXT,
  "hold_expires_at"          TIMESTAMPTZ(6),
  "paid_at"                  TIMESTAMPTZ(6),
  "confirmed_at"             TIMESTAMPTZ(6),
  "cancelled_at"             TIMESTAMPTZ(6),
  "ip_hash"                  TEXT,
  "oversell_flag"            BOOLEAN NOT NULL DEFAULT false,
  "fulfillment_status"       "daali_merch_fulfillment_status" NOT NULL DEFAULT 'UNFULFILLED',
  "handed_out_at"            TIMESTAMPTZ(6),
  "handed_out_by"            TEXT,
  "created_at"               TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "daali_merch_orders_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "daali_merch_orders_listing_fkey" FOREIGN KEY ("listing_id") REFERENCES "daali_merch_listings"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "daali_merch_orders_fulfillment_fkey" FOREIGN KEY ("fulfillment_option_id") REFERENCES "daali_merch_fulfillment_options"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "daali_merch_orders_email_normalized" CHECK ("buyer_email" = lower(btrim("buyer_email")) AND "buyer_email" LIKE '%_@_%'),
  CONSTRAINT "daali_merch_orders_total_nonneg" CHECK ("total_cents" >= 0 AND "organizer_net_cents" >= 0),
  CONSTRAINT "daali_merch_orders_refund_bounds" CHECK ("refunded_cents" BETWEEN 0 AND "total_cents"),
  CONSTRAINT "daali_merch_orders_pending_shape" CHECK ("status" <> 'PENDING_PAYMENT' OR ("hold_expires_at" IS NOT NULL AND "stripe_account_id" IS NOT NULL AND "checkout_params" IS NOT NULL)),
  CONSTRAINT "daali_merch_orders_session_url_together" CHECK (("checkout_url" IS NULL) OR ("stripe_session_id" IS NOT NULL)),
  CONSTRAINT "daali_merch_orders_paid_shape" CHECK ("status" NOT IN ('PAID', 'REFUNDED', 'PARTIALLY_REFUNDED') OR ("paid_at" IS NOT NULL AND "stripe_session_id" IS NOT NULL)),
  CONSTRAINT "daali_merch_orders_free_shape" CHECK ("status" <> 'CONFIRMED_FREE' OR ("total_cents" = 0 AND "stripe_session_id" IS NULL AND "confirmed_at" IS NOT NULL)),
  CONSTRAINT "daali_merch_orders_cancelled_shape" CHECK ("status" <> 'CANCELLED' OR "cancelled_at" IS NOT NULL),
  CONSTRAINT "daali_merch_orders_checkout_attempts" CHECK ("checkout_attempts" BETWEEN 0 AND 50)
);
CREATE UNIQUE INDEX "daali_merch_orders_public_token_key"    ON "daali_merch_orders" ("public_token");
CREATE UNIQUE INDEX "daali_merch_orders_idempotency_key_key" ON "daali_merch_orders" ("idempotency_key");
CREATE UNIQUE INDEX "daali_merch_orders_session_key"         ON "daali_merch_orders" ("stripe_session_id");
CREATE UNIQUE INDEX "daali_merch_orders_payment_intent_key"  ON "daali_merch_orders" ("stripe_payment_intent_id");
-- D10: one confirmed free reservation per email per listing.
CREATE UNIQUE INDEX "daali_merch_orders_one_free_per_email"  ON "daali_merch_orders" ("listing_id", "buyer_email") WHERE "status" = 'CONFIRMED_FREE';
CREATE INDEX "idx_daali_merch_orders_listing_status"         ON "daali_merch_orders" ("listing_id", "status");
CREATE INDEX "idx_daali_merch_orders_pending_hold"           ON "daali_merch_orders" ("hold_expires_at") WHERE "status" = 'PENDING_PAYMENT';
CREATE INDEX "idx_daali_merch_orders_pending_no_session"     ON "daali_merch_orders" ("created_at") WHERE "status" = 'PENDING_PAYMENT' AND "stripe_session_id" IS NULL;
CREATE INDEX "idx_daali_merch_orders_email_rate"             ON "daali_merch_orders" ("listing_id", "buyer_email", "created_at");
CREATE INDEX "idx_daali_merch_orders_ip_rate"                ON "daali_merch_orders" ("listing_id", "ip_hash", "created_at");

-- ------------------------------------------------------------ order lines --
CREATE TABLE "daali_merch_order_lines" (
  "id"               UUID NOT NULL DEFAULT gen_random_uuid(),
  "order_id"         UUID NOT NULL,
  "item_id"          UUID NOT NULL,
  "variant_id"       UUID NOT NULL,
  "quantity"         INTEGER NOT NULL,
  "unit_price_cents" INTEGER NOT NULL,
  "unit_net_cents"   INTEGER NOT NULL,
  "item_name"        TEXT NOT NULL,
  "variant_label"    TEXT NOT NULL,
  CONSTRAINT "daali_merch_order_lines_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "daali_merch_order_lines_order_fkey" FOREIGN KEY ("order_id") REFERENCES "daali_merch_orders"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "daali_merch_order_lines_item_fkey" FOREIGN KEY ("item_id") REFERENCES "daali_merch_items"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "daali_merch_order_lines_variant_fkey" FOREIGN KEY ("variant_id") REFERENCES "daali_merch_variants"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "daali_merch_order_lines_quantity" CHECK ("quantity" BETWEEN 1 AND 100),
  CONSTRAINT "daali_merch_order_lines_prices_nonneg" CHECK ("unit_price_cents" >= 0 AND "unit_net_cents" >= 0)
);
CREATE INDEX "idx_daali_merch_order_lines_order"   ON "daali_merch_order_lines" ("order_id");
CREATE INDEX "idx_daali_merch_order_lines_variant" ON "daali_merch_order_lines" ("variant_id");

-- --------------------------------------------------- notifications outbox --
-- Same shape as notification_deliveries (lease + fencing token), kept separate
-- so merch never writes a table the Board flows read.
CREATE TABLE "daali_merch_notifications" (
  "id"                  UUID NOT NULL DEFAULT gen_random_uuid(),
  "order_id"            UUID NOT NULL,
  "kind"                TEXT NOT NULL,
  "status"              "daali_merch_notification_status" NOT NULL DEFAULT 'PENDING',
  "attempts"            INTEGER NOT NULL DEFAULT 0,
  "first_attempt_at"    TIMESTAMPTZ(6),
  "next_attempt_at"     TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "locked_at"           TIMESTAMPTZ(6),
  "lock_token"          TEXT,
  "idempotency_suffix"  INTEGER NOT NULL DEFAULT 0,
  "provider_message_id" TEXT,
  "last_error"          TEXT,
  "sent_at"             TIMESTAMPTZ(6),
  "created_at"          TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "daali_merch_notifications_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "daali_merch_notifications_order_fkey" FOREIGN KEY ("order_id") REFERENCES "daali_merch_orders"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "daali_merch_notifications_kind" CHECK ("kind" IN ('RECEIPT', 'FREE_CONFIRMATION')),
  CONSTRAINT "daali_merch_notifications_sent_shape" CHECK (("status" = 'SENT') = ("sent_at" IS NOT NULL)),
  CONSTRAINT "daali_merch_notifications_sending_shape" CHECK ("status" <> 'SENDING' OR ("locked_at" IS NOT NULL AND "lock_token" IS NOT NULL)),
  CONSTRAINT "daali_merch_notifications_attempts" CHECK ("attempts" BETWEEN 0 AND 50)
);
CREATE UNIQUE INDEX "daali_merch_notifications_order_kind_key" ON "daali_merch_notifications" ("order_id", "kind");
CREATE INDEX "idx_daali_merch_notifications_claim" ON "daali_merch_notifications" ("status", "next_attempt_at");

-- ------------------------------------------------------------- containment --
-- Table-scoped. Nothing here can touch an existing relation.
ALTER TABLE public."daali_merch_listings"            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."daali_merch_items"               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."daali_merch_variants"            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."daali_merch_fulfillment_options" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."daali_merch_orders"              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."daali_merch_order_lines"         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."daali_merch_notifications"       ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE
  public."daali_merch_listings",
  public."daali_merch_items",
  public."daali_merch_variants",
  public."daali_merch_fulfillment_options",
  public."daali_merch_orders",
  public."daali_merch_order_lines",
  public."daali_merch_notifications"
  FROM PUBLIC, anon, authenticated;

GRANT ALL ON TABLE
  public."daali_merch_listings",
  public."daali_merch_items",
  public."daali_merch_variants",
  public."daali_merch_fulfillment_options",
  public."daali_merch_orders",
  public."daali_merch_order_lines",
  public."daali_merch_notifications"
  TO service_role;

-- ------------------------------------------------------------------ gate ----
-- Read from the catalog, never inferred from the statements above. Any failure
-- raises, and the migration's transaction rolls back with nothing left behind.
DO $$
DECLARE
  expected  TEXT[] := ARRAY[
    'daali_merch_listings', 'daali_merch_items', 'daali_merch_variants',
    'daali_merch_fulfillment_options', 'daali_merch_orders',
    'daali_merch_order_lines', 'daali_merch_notifications'];
  t         TEXT;
  r         TEXT;
  p         TEXT;
  missing   TEXT;
BEGIN
  FOREACH t IN ARRAY expected LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = t AND c.relrowsecurity
    ) THEN
      RAISE EXCEPTION 'daali_merch aborted: RLS not enabled on %', t;
    END IF;
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      FOREACH p IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
        IF has_table_privilege(r, 'public.' || quote_ident(t), p) THEN
          RAISE EXCEPTION 'daali_merch aborted: % holds % on %', r, p, t;
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;

  -- The name set derived from the catalog must equal the expected set.
  SELECT string_agg(x, ', ') INTO missing FROM (
    SELECT c.relname AS x FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE 'daali\_merch\_%'
    EXCEPT SELECT unnest(expected)
  ) d;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'daali_merch aborted: unexpected daali_merch table(s) %', missing;
  END IF;

  SELECT string_agg(name, ', ') INTO missing FROM (
    SELECT unnest(ARRAY[
      'daali_merch_listings_slug_key',
      'daali_merch_orders_session_key',
      'daali_merch_orders_payment_intent_key',
      'daali_merch_orders_idempotency_key_key',
      'daali_merch_orders_one_free_per_email',
      'daali_merch_notifications_order_kind_key',
      'idx_daali_merch_notifications_claim'
    ]) AS name
    EXCEPT
    SELECT i.relname FROM pg_class i JOIN pg_namespace n ON n.oid = i.relnamespace
     WHERE n.nspname = 'public' AND i.relkind = 'i'
  ) x;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'daali_merch aborted: missing index(es) %', missing;
  END IF;
END $$;
