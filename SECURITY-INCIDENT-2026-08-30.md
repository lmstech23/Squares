# Security incident — anonymous Data API exposure of the `public` schema

**Status:** Contained and verified. Log review complete.
**Discovered:** August 30, 2026
**Contained:** August 30, 2026
**Record written:** August 30, 2026

---

## Summary

Fifteen tables carried anonymous and authenticated DML grants. Seven tables were
anonymously readable and writable, including 1,300 contributor records.
Containment was applied on August 30, 2026. Logs were reviewed across the
project's seven-day retention window. No evidence was found within retained
logs; activity before that period is unobservable.

---

## What was exposed

Every table in the `public` schema granted `anon` and `authenticated` the full
set of table privileges — `SELECT`, `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`,
`REFERENCES`, `TRIGGER`. Row-level security was the only thing separating those
grants from live access over the PostgREST Data API.

**Seven tables had RLS disabled, so the grants were live:**

| Table | Rows | Sensitivity |
|---|---|---|
| `squares` | 1,300 | contributor name, email, phone; **writable and deletable** |
| `boards` | 17 | board configuration |
| `hosts` | 5 | host records |
| `payment_references` | 16 | payment linkage |
| `credit_transactions` | 16 | transaction records |
| `invite_codes` | 10 | unclaimed codes, **writable** |
| `hbcu_orgs` | 2 | organisation records |

`squares` is the material exposure: 1,300 rows of contributor personal data,
anonymously readable **and** writable.

**Eight tables had RLS enabled with zero policies**, so they denied by default:
`events`, `event_supporters`, `admission_grants`, `admission_passes`,
`check_in_logs`, `volunteer_access`, `attendance_access_tokens`, `free_entries`.
These were protected only by RLS while carrying identical grants underneath —
one `DISABLE ROW LEVEL SECURITY` from exposure.

## Root cause

`pg_default_acl`. Both `postgres` and `supabase_admin` held default privileges
on the `public` schema granting `arwdDxtm` to `anon` and `authenticated`. Every
table created in `public` therefore received full anonymous DML **automatically
at `CREATE TABLE`**, and the `pgrst_ddl_watch` event trigger published it to the
Data API immediately.

No migration granted anything. No code was wrong. The grants arrived on their
own, which is why nothing in the repository revealed the problem and why it
would have recurred on every future table — including the six S1 sign-up
tables, which will hold names and contact details.

**RLS and grants are invisible to `prisma/schema.prisma`.** `prisma migrate
diff` reported zero drift throughout the entire exposure period. Schema tooling
could not have surfaced this and will not surface a regression.

## Exposure period

The affected tables predate this work; the oldest surviving board row dates to
**2026-05-27**. Exposure therefore ran for **at least 95 days** — a lower bound,
since the tables themselves may be older than their oldest surviving row.

## Containment

`migrations/secure_data_api.sql`, applied August 30, 2026 as a single
transaction, 21 statements:

1. `ENABLE ROW LEVEL SECURITY` on all fifteen tables.
2. `REVOKE ALL ON ALL TABLES` and `ON ALL SEQUENCES IN SCHEMA public FROM
   PUBLIC, anon, authenticated` — so RLS is no longer the only barrier.
3. Corrected `postgres` default privileges, including the unqualified
   `ALTER DEFAULT PRIVILEGES FOR ROLE postgres REVOKE EXECUTE ON FUNCTIONS FROM
   PUBLIC` — Postgres's global `PUBLIC EXECUTE` default is not schema-scoped and
   a `IN SCHEMA public` revoke cannot cancel it.

`service_role` and `postgres` were untouched. No policies were created: no
application path authenticates as `anon` or `authenticated` against these
tables, so a policy would invent a permission nothing asks for.

**Safe because** a read-only trace found the anon key is used for `auth.*` only
— `getUser` ×10, `verifyOtp` ×4, `signInWithOtp` ×2, `signOut`,
`exchangeCodeForSession` — with zero `.from()` and zero `.rpc()` outside a
single service-role route. Public boards, checkout, the host dashboard and the
check-in gate read Postgres through Prisma over the connection pooler, which is
unaffected by role grants.

## Verification

| Check | Result |
|---|---|
| Anonymous PostgREST, all 15 tables | **HTTP 401** |
| `relacl` for PUBLIC / `anon` / `authenticated` | absent on all 15 |
| `has_table_privilege`, both roles × 7 privileges × 15 tables | all false |
| RLS enabled | all 15 |
| `service_role` privileges retained | all 7 on all 15 |
| `postgres` default privileges | `postgres` and `service_role` only |
| Production site (`https://beta.daali.app`) | home and board page HTTP 200 |
| Host dashboard, authenticated | confirmed by hand in a browser |
| Row counts before/after | unchanged (17 / 1300 / 5 / 5 / 9 / 1) |

`scripts/verify-containment.mts` is the standing check. It is catalog-driven —
it discovers relations rather than listing them, so tables added later are
covered without anyone remembering — and it fails closed on a table without
RLS, any PUBLIC/anon/authenticated privilege, a reachable view or function,
unsafe `postgres` defaults, missing `service_role` access, a missing catalog
column, or an HTTP probe that never completed. It reports two independent
conclusions, `DATABASE CONTAINMENT` and `PRODUCTION SITE SMOKE`, and the second
can never read green without `VERIFY_SITE_URL` naming a remote host.

## Log review

**Scope:** the project's full seven-day Data API retention window.
**Result:** 164 rows returned, the complete set — no truncation.

Every PostgREST request in retention originated from the containment session on
August 30, 2026, beginning at 16:15:25. Nothing appears before that timestamp
anywhere in the window. No request from any other source, by any method.

**No `POST`, `PATCH`, `PUT`, or `DELETE` appears anywhere in the window.** No
write reached the Data API within retention, from any source.

All 164 rows were attributed to verification activity by matched request
signature — method, path, query shape, status and timestamp — not by trusting
their origin address. Source addresses are summarised rather than recorded here:
a single address accounts for all 164 rows.

Two batches did not match the initially published signature and were
adjudicated explicitly rather than cleared:

- **17:06:04** — `GET` rather than `HEAD`, with `400` responses on
  `invite_codes`, `payment_references`, `squares` and `boards`. These are the
  `select=id` probes against tables with no `id` column, whose 400s were
  initially misread as "blocked" and were corrected during the investigation.
- **17:06:23** — a `HEAD` batch run **before** containment, returning `200`
  responses and a `206` on `squares`. This is the pre-containment baseline: a
  successful anonymous read of 1,300 contributor records, performed by the
  verification harness to establish that the exposure was real.

Both are verification traffic. Neither is third-party access. The published
signature was incomplete — it described only the final probe shape — and would
have flagged the first batch as a finding. It erred toward suspicion rather than
toward clearing, and the discrepancy was resolved by examination rather than by
assumption.

`hbcu_orgs` shows no `POST` in the window, so the service-role onboard route did
not run this week. That is expected idleness, not a fault.

### What this review can and cannot establish

Seven days of retention covers **under 8%** of an exposure lasting at least 95
days. The overwhelming majority of the exposure window produced logs that no
longer exist. **This review does not establish that no unauthorised access
occurred.** It establishes that no evidence of it survives within retention.

Further limits, stated plainly:

- These logs cover the **PostgREST Data API only**. Application traffic through
  Prisma uses the connection pooler and never appears here; its absence is
  expected and means nothing either way.
- **Realtime and Storage access paths were not examined.** The anon key also
  carries `USAGE` on the `realtime` and `storage` schemas. Whether the exposed
  tables were reachable through Realtime replication was not tested and remains
  an open question.
- Row counts are unchanged and no writes appear in retention, which is
  consistent with no destructive modification — but a modification made before
  the retention window would leave no trace in either signal.

## Residual risk

**`supabase_admin` default privileges on `public` remain uncorrected.**
Correcting them requires membership in that role, which `postgres` does not hold
(`pg_has_role` returns false), and the dashboard SQL editor connects as
`postgres` too. The statements are preserved, unexecuted, at
`migrations/secure_data_api_supabase_admin_defaults.sql.pending`.

The residual is narrow: default privileges govern only objects created *by* the
named role. Every table in `public` is owned by `postgres`, and S1's tables will
be created by `postgres`, so the corrected `postgres` defaults govern them. What
remains uncovered is `supabase_admin` creating a table in `public` during a
future Supabase platform upgrade. **Re-run the verifier after any platform
upgrade.**

`anon` and `authenticated` also hold default privileges on the `storage`
(via `postgres`) and `graphql` / `graphql_public` (via `supabase_admin`)
schemas. These are Supabase-managed with their own policy models and were
deliberately not changed. If storage buckets ever hold non-public content,
audit `storage.objects` policies specifically.

## Notification assessment

Not a determination of legal obligation — input for one.

The exposed contributor data comprises name, email address and phone number for
1,300 square records, anonymously readable for at least 95 days. No payment card
data, credentials, or government identifiers were in scope; Stripe holds payment
instruments and was not affected. No evidence of third-party access survives,
and no evidence of modification exists in retention or in row counts.

The gap between "no evidence" and "no access" is the whole question, and seven
days of logs cannot close it. Whether that gap triggers a notification duty
depends on jurisdiction and on the standard applied — some regimes key on
demonstrated access, others on unauthorised accessibility regardless of proof.
**This warrants a decision by the host, informed by counsel, not a technical
judgement.**

## Baseline consequence

Closing this exposure surfaced a second, related gap: the containment could not
be reproduced. `prisma/migrations` was empty and `_prisma_migrations` did not
exist, so nothing in version control could rebuild the database — including the
RLS and grants applied here.

**`prisma/migrations/0_init` is this repo's first reproducible database history.
It is not consolidating an existing one — there was never a replayable base at
all.** Replayed against a clean database, the eleven hand-applied files fail on
the first: `add_monetization.sql` expects `hosts` to exist and no file ever
created it. Eleven files patched an undocumented state.

`0_init` is built from the physical catalog rather than from `schema.prisma`,
because the schema file cannot represent RLS, grants, default privileges, or
partial indexes. The catalog generator alone emitted 36 of production's 40
indexes and none of the security configuration; a baseline built from it would
replay into a database that is missing four indexes and fully exposed. It
revokes the unsafe default privileges BEFORE creating any table, so no table is
ever briefly exposed during a replay.

Verified against a disposable database in two states — clean, and deliberately
contaminated with the same unsafe default privileges production had. In the
contaminated case a table created before the baseline WAS anonymously readable
and deletable; after the baseline, all 15 tables and a freshly created table
exposed nothing to anon or authenticated.

## Follow-ups

1. Re-run `scripts/verify-containment.mts` after any migration that creates
   anything in `public`, and after any Supabase platform upgrade.
2. Run it immediately after S1 creates the six sign-up tables.
3. Escalate the `supabase_admin` default-privilege correction to Supabase
   support. Do not work around it by granting `supabase_admin` to `postgres`.
4. Consider whether Realtime exposes any `public` table, which this review did
   not examine.
5. Consider extending log retention, so a future review is not limited to seven
   days.

## References

- `migrations/secure_data_api.sql` — the applied containment
- `migrations/secure_data_api_supabase_admin_defaults.sql.pending` — preserved, not executed
- `scripts/verify-containment.mts` — the standing check
- `PHASE-2-BACKLOG.md` — residual risk entries
- `CLAUDE.md` — the standing rule that RLS and grants are invisible to Prisma
- Commits `8cd3e65`, `8e6a8d0`
