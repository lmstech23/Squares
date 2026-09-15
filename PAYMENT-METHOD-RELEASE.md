# Payment method — release procedure

**Operator runbook, not a spec.** `fundraiser-payment-method-addendum.md` owns
the fields, constraints and invariants; `fundraiser-board-v2.md` owns the host
flows. This file answers one question: in what order do the three migrations and
the code deploy actually happen, and what can be undone afterwards.

Carries no date and no deployment id, deliberately — the same reason
`CLOSE-PROCEDURE.md` does not.

---

## 1. What is in this release

Three migrations, applied in this order by a single `migrate deploy`:

| | Migration | Does |
|---|---|---|
| M0 | `20260912000000_contribution_settlement_tender` | Adds `settlement`, `tender`, `tender_reference`, `recorded_at`, `tender_correction_log`. Backfills. Asserts. `settlement` **SET NOT NULL**. Adds both CHECKs |
| M1a | `20260913000000_contribution_checks_on_settlement` | Rewrites `contributions_card_requires_email` and `contributions_rail_is_cash_only` to read `settlement` |
| M1b | `20260914000000_drop_contribution_payment_method` | **`DROP COLUMN contributions.payment_method`** |

Plus the code: the picker on four confirm paths, the ledger Method column, the
correction route, and the close-panel breakdown.

---

## 2. What Vercel actually does after a merge to `main`

**Vercel does not run migrations. Nothing in this repository makes it.**

- Build command is `next build`. There is no `migrate` in it.
- `postinstall` is `prisma generate` — it reads `schema.prisma` and writes a
  client. It never connects to a database.
- `vercel.json` declares four crons and nothing else.

So the deploy pipeline is: push to `main` → install → `prisma generate` →
`next build` → the new deployment is aliased to `beta.daali.app`. Every push to
`main` deploys to production; there is no preview tier in front of it.

**The build does not read the database.** Every route that touches Prisma builds
as `ƒ (Dynamic) — server-rendered on demand`; the only statically prerendered
pages are `/`, `/_not-found`, `/login`, `/privacy` and `/terms`, none of which
query anything. A build therefore succeeds against *any* schema state, including
one the code cannot actually run against. **A green build is not evidence that
the schema is ready.**

**Can the new bundle receive traffic before migrations finish?** Yes — that is
the default, and it is the hazard. Vercel aliases the deployment the moment the
build completes. If the migrations have not run, the new bundle is live and
broken. Nothing sequences these two for you.

**Migrations are operator-run, out of band:**

```
DIRECT_URL=…  VERIFY_SITE_URL=https://beta.daali.app  npm run db:migrate:production
```

That is the only sanctioned path and it stays the path for this release —
`assertProductionTarget` refuses any `DIRECT_URL` that is not the production
project **before Prisma is spawned and before a connection is opened**, then
`prisma migrate deploy` applies every pending migration in order, then
`verify-containment.mts` runs against the same database. Dry run first with
`npm run db:migrate:production:dry`. The manual production-host verification
established earlier still applies: confirm the target project ref out of band
before the run, and never hand the script a URL that was not established as
production.

**In-flight requests during the migration window.** Each migration file applies
in its own transaction and takes `ACCESS EXCLUSIVE` on `contributions`.
Concurrent statements queue behind that lock rather than erroring. `contributions`
holds 76 rows, so the backfill, the `SET NOT NULL` scan, the CHECK validation and
the `DROP COLUMN` (a catalog-only operation) are all sub-second. Lock waiting is
not the risk here. The risk is the code-versus-schema window described next.

---

## 3. The window, stated plainly

**There is no ordering of these three migrations and this deploy that is free of
a broken window.** The reason is two columns with no defaults:

- `contributions.settlement` is **NOT NULL with no default** from the end of M0.
  Old code does not write it.
- `contributions.payment_method` is **NOT NULL with no default** until M1b drops
  it. New code does not write it.

Each version of the code is therefore incompatible with the schema the other one
needs, and the incompatibility is on `INSERT`, which no amount of deploy ordering
removes.

| Combination | Result |
|---|---|
| Old code, pre-M0 schema | Working — this is production today |
| **Old code, post-M0 schema** | Reads fine. **Every contribution INSERT fails** — `settlement` is NOT NULL and the old client does not send it. Card checkout, donate, cash reserve, host-recorded donation, entry reservation |
| Old code, post-M1a schema | Same as post-M0. M1a is behaviour-neutral: it rewrites two CHECKs to read `settlement`, which dual-writing kept in lockstep with `payment_method` |
| **Old code, post-M1b schema** | The above, **plus reads fail wherever the old client names the column**: the host ledger selects `paymentMethod` explicitly, and `contribution.update()` with no `select` returns every scalar. The public board page survives — its contribution reads are an aggregate and a narrowly-selected `findUnique` |
| **New code, pre-M1b schema** | Reads fine. **Every contribution INSERT fails** — `payment_method` is still NOT NULL and the new client no longer sends it |
| New code, post-M1b schema | Working — the target state |

The new code needs all three migrations. Not M0, not M0+M1a — **all three.**

### The order to use, and why

**Migrate first, then merge.** Run `db:migrate:production` to completion, confirm
M0's assertions passed and the gates printed, then merge `--ff-only` and push.

Not because it is symmetric — both orders leave a window of roughly the same
length — but because of what failure does to each:

- **Migrate first.** If M0's gate aborts, the whole migration rolls back with it
  and production is untouched and fully healthy. Nothing was deployed. The
  release simply did not happen.
- **Deploy first.** A failed migration leaves a live bundle that cannot write a
  contribution, and the only way out is forward, under time pressure.

The exposed window runs from the moment M0 commits until the new deployment is
aliased: the rest of the migration, plus install, build and alias. During it,
**contribution creation fails** — card checkout, donations, cash reservations,
host-recorded donations, entry reservations — and once M1b commits, the host
ledger page fails too. Reading the public board keeps working throughout.

Run it when nobody is contributing. Expect minutes, not seconds.

**One expected complication.** `db:migrate:production` finishes by running
`verify-containment.mts`, which fetches `/` and `/board/<open-board-slug>` from
the live site. Those two pages are the ones that survive the old bundle, so the
smoke should pass — but the command reports **two independent conclusions** and
the one that matters at this step is `DATABASE CONTAINMENT`. If the site
conclusion fails while containment passes, that is the old bundle against the new
schema, not a containment defect. Re-run the check on its own after the deploy
lands, passing `DATABASE_URL` explicitly:

```
DATABASE_URL=…  VERIFY_SITE_URL=https://beta.daali.app \
  node --experimental-strip-types scripts/verify-containment.mts
```

---

## 4. Rollback reality

**M1b makes this a forward-only database release. After it commits there is no
rollback, only a forward fix.** Stated without softening, because the cost of
discovering it during an incident is far higher than the cost of reading it now.

Tier by tier:

**M1a is backward-compatible.** It renames nothing and changes no data. Both
rewritten CHECKs accept exactly the rows their predecessors accepted, for any
version of the code. Nothing needs undoing.

**M0 is recoverable, but not by reverting code.** Re-aliasing the previous Vercel
deployment restores the old bundle against a schema whose `settlement` column is
NOT NULL — and the old bundle does not write it, so contribution creation stays
broken. Recovering means a **forward-fix migration**:

```sql
ALTER TABLE public.contributions ALTER COLUMN settlement DROP NOT NULL;
```

That loses nothing: the columns, the backfilled values and the correction table
can all stay in place while the old code runs. It is one statement, and it is
still a migration written and applied under pressure.

**M1b cannot be rolled back.** `DROP COLUMN payment_method` destroys the column
and its data. Reverting to pre-M1 code is **impossible** without first restoring
that column and reconstructing its contents, because old code both reads it (the
host ledger selects it by name; `contribution.update()` returns it) and writes it
(both creation paths send it, and it is NOT NULL with no default). Restoring
means writing and applying a migration that re-creates the column, backfills it
from `settlement` — `STRIPE → 'stripe'`, `OFFLINE → 'cash'` — and sets NOT NULL
again.

Two things to be clear-eyed about if that day comes:

1. The reconstruction is mechanical for rows that existed before this release,
   because M0's backfill was a bijection over the only two values in the enum.
2. It is **not** faithful for rows recorded after it. A contribution the host
   recorded as Venmo or Check comes back as `payment_method = 'cash'`, because
   that is the only offline value the old enum has. The reconstruction would
   assert a method nobody recorded — the exact falsehood the null-tender rule
   exists to prevent — and the true value survives only in `tender`.

**The honest summary: once `db:migrate:production` completes, the way out is
forward.** The Vercel rollback list is still there and still instant, and it is
not a rollback of this release. Plan the release as one that is not being undone.

---

## 5. Before M0: the snapshot, and what "restorable" was made to mean

A forward-only release earns a recovery artifact that has been *restored*, not
one that has merely been *written*. "A backup exists" is not an answer.

### The artifact

A logical snapshot of the production `public` schema, taken with `pg_dump 17.11`
against the production project over `DIRECT_URL`, custom format, compressed,
carrying data, constraints, indexes and ACLs:

```
C:\Users\dtate\Downloads\squares\backups\daali-prod-public-<UTC timestamp>.dump
```

Outside the repository, deliberately — it holds contributor names, emails and
phone numbers. Record for each run: file name, byte size, SHA-256, the UTC start
and finish, the production project ref, and `server_version_num`. Production is
PostgreSQL 17.6, so the dump must be taken with a **17.x** `pg_dump`; the 16
client in `scripts/test-db.mjs` refuses a 17 server.

### The restore, actually performed

Into a clean `postgres:17-alpine` container, not into production:

1. `DROP SCHEMA public CASCADE` on a fresh database — `pg_restore` issues
   `CREATE SCHEMA public`, and a stock database already has one.
2. Create the roles the production ACLs name — `anon`, `authenticated`,
   `service_role`, `supabase_admin` — as `NOLOGIN`, or every `GRANT`/`REVOKE`
   in the archive fails.
3. `CREATE SCHEMA extensions` and install `pgcrypto` and `uuid-ossp` into it:
   Supabase keeps extensions there and column defaults reference them.
4. `pg_restore --no-owner --exit-on-error`.

Then compare, rather than assume:

| Check | Result |
|---|---|
| Per-table row counts, all 28 tables | identical to production |
| CHECK constraints / foreign keys / indexes | identical (41 / 44 / 76) |
| `md5(string_agg(row::text))` over `contributions` | identical |
| `md5(string_agg(row::text))` over `squares` | identical |
| `payment_method` distribution | identical |
| Table grants to `anon` / `authenticated` / `PUBLIC` | none, in both |

The row-level md5 is the check that matters: equal counts can hide unequal rows.

**This snapshot is what makes M1b recoverable.** It carries `payment_method` for
every contribution — the column M1b destroys — so the reconstruction described in
§4 has a real source rather than an inference.

### Two traps, both hit

- **`pg_restore --table=contributions` alone does not work.** It restores the
  table without the enum types its columns are declared against, and every
  statement fails on `type "public.contribution_status" does not exist`. Recovery
  of one table means restoring the whole archive into a *separate* database and
  copying across. Plan for that, not for a one-table shortcut.
- **`docker exec` without `-i` silently discards a heredoc.** A setup step
  reported success and did nothing. Any `psql` fed from stdin needs
  `docker exec -i`.

### What is NOT verified, and cannot be from here

**Supabase's managed backups and PITR.** Their availability, retention and
restore procedure live in the Supabase dashboard. This repository holds no
Supabase personal access token — only `SUPABASE_SERVICE_ROLE_KEY`, which is a
PostgREST/Storage credential and cannot read the Management API — so the plan
tier, the backup schedule and the restore button cannot be confirmed from the
code side. Confirm it in the dashboard before the window.

**Restoring this dump back into the production project has not been rehearsed,
and should not be.** Doing so is destructive and needs its own decision. The
dump is proven to reconstruct the data faithfully; putting it back is a separate
operation.

Also true of any logical dump: it covers `public` only. `auth`, `storage` and the
rest of the Supabase-managed schemas are not in it. This release touches nothing
outside `public`.

---

## 6. The window cannot orphan a charge

Confirmed from the code, because §3 says contribution INSERTs fail during the
window and the obvious next question is whether a contributor can be charged
anyway.

**In all three contributor-facing card paths the pending contribution row is
committed before Stripe is called.**

| Path | Insert | Session |
|---|---|---|
| `api/checkout/route.ts` | inside the `prisma.$transaction` that locks the squares, which returns at 461 | `sessions.create` at 515 — step 7, after the transaction |
| `api/board/[slug]/donate/route.ts` | `prisma.$transaction` at 226 | `sessions.create` at 244 |
| `api/board/[slug]/entry/route.ts` | `prisma.$transaction` at 164 | `sessions.create` at 216 |

The full order is: **contribution INSERT commits → Checkout Session created →
`checkoutSessionId` written back to the row → `checkoutUrl` returned to the
browser → contributor pays on Stripe's page → webhook confirms by looking the row
up on `checkoutSessionId`.** A contributor cannot reach a payment form before the
row exists, because the URL that shows them one is returned after it. Each of the
three routes also compensates if `sessions.create` throws: the row it just wrote
is set `released`, and nothing was charged.

Those are the only three `stripe.checkout.sessions.create` calls that involve a
contribution. The other two — `api/credits/purchase` and
`api/host/credits/checkout` — are host credit purchases with no contribution row
by design.

**The consequence for the release: during the window a contributor gets an error,
not a charge.** The INSERT is the first thing that happens and the first thing
that fails, before any Stripe object exists.

One thing that is *not* a defect and should not be read as one: on a Game Day
board `isFundraiser` is false and no contribution row is ever created. Game Day
squares stay outside the ledger by design, and M0 and M1b never touch them.

---

## 7. Order of operations

Steps 1–4 are reversible. Step 6 is the point of no return.

1. Confirm the branch is green locally: `tsc`, unit, every integration suite,
   `next build`.
2. **Choose the window deliberately.** Not "whenever convenient": no fundraiser
   close due, no event within days, nothing mid-event, and an hour with no
   recorded contribution traffic. Derive the hour from the data — group
   `contributions.created_at` by hour in `America/New_York` over the last 90 days
   and pick a band that is empty.
3. **Take the snapshot and restore it** — §5. Record name, size, SHA-256, UTC
   times. Do not continue on "a backup exists".
4. Read-only production pre-flight, immediately before the migration: counts by
   `payment_method`, no value outside `stripe`/`cash`, no NULL, and M0's three
   assertions evaluated against the live rows. **No writes.**
5. Verify the production host/project ref by hand, out of band.
6. `npm run db:migrate:production:dry`, then
   `DIRECT_URL=… VERIFY_SITE_URL=https://beta.daali.app npm run db:migrate:production`.
   M0 → M1a → M1b, one command. Read `DATABASE CONTAINMENT` first.
7. **Read the production catalog and verify six things**, from `pg_catalog`, not
   from the migration's own output:
   - `contributions.settlement` exists and is `NOT NULL`
   - `contributions_settlement_tender_valid` exists and is validated
   - `contributions_card_requires_email` and `contributions_rail_is_cash_only`
     exist, are validated, and no longer mention `payment_method`
   - `contributions.payment_method` is gone
   - the `"PaymentMethod"` enum type still exists — `squares.payment_method` and
     `payment_references.method` still use it
   - the row mapping is intact: every pre-existing row's `settlement`/`tender`
     matches what it had as `payment_method`, against the snapshot
8. **If the migration failed before completing, stop. Do not merge the code.**
9. Merge `--ff-only` to `main` and push. Wait until the new deployment actually
   owns the production alias — not until the build goes green.
10. Re-run `verify-containment.mts` standalone with an explicit `DATABASE_URL`.
11. Exercise the host surfaces by hand against a real board: ledger Method cells,
    a historical `Recorded by host` row, the tender picker, a correction, the
    `Unspecified` filter, the close breakdown — and confirm one Game Day board is
    unchanged.

If a problem appears after step 6 completed, the database is forward-only.
**Do not attempt a code-only rollback to pre-M1** — §4 says what that leaves.
