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

## 5. Order of operations

1. Confirm the branch is green locally: `tsc`, unit, every integration suite,
   `next build`.
2. Read-only production pre-flight: counts by `payment_method`, no value outside
   `stripe`/`cash`, no NULL, and M0's three assertions evaluated against the live
   rows. **No writes.**
3. `npm run db:migrate:production:dry` against production.
4. Pick a window with no contributor traffic.
5. `DIRECT_URL=… VERIFY_SITE_URL=https://beta.daali.app npm run db:migrate:production`.
   Read `DATABASE CONTAINMENT` first.
6. Merge `--ff-only` to `main` and push. Watch the build through to the alias.
7. Re-run `verify-containment.mts` standalone with an explicit `DATABASE_URL`.
8. Exercise the host surfaces against a real board: ledger Method column, a
   correction, the close-panel breakdown, and one offline confirmation through
   each of the four confirm paths.
