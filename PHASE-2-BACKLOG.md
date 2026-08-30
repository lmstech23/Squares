# Phase 2 Backlog

Deferred work with a reason and a trigger. An entry without a removal
condition is a wish, not a ticket.

---

## Remove `/volunteer-access` alias route

**Added:** 2026-08-30 (S0, check-in staff rename)
**File:** `src/app/api/host/boards/[id]/volunteer-access/route.ts`
**Delete after:** the first release *following* the S0 deploy — once no
browser can still be holding a pre-rename dashboard bundle.

S0 renamed the host route to `/api/host/boards/[id]/check-in-staff`. A host
dashboard loaded **before** that deploy still holds the old URL in its
JavaScript and will call it afterward, so deleting the old path immediately
would break the create and revoke buttons for anyone with a tab already open.

Both paths call one shared implementation in
`src/lib/check-in-staff-handlers.ts`, so there is no second copy to drift.

**To remove:** delete the route directory. Also drop the
`volunteerAccessId` fallback in `revokeCheckinStaffLink`, which exists for
the same reason and expires at the same moment.

Sign-up addendum §2 is explicit that an alias without a removal ticket is
permanent. This is that ticket.

---

## Physical rename of `volunteer_access`

**Added:** 2026-08-30 (S0)
**Blocked by:** needs a planned window with no event nearby.

S0 renamed at the application layer only. `schema.prisma` says
`CheckinStaffAccess` while psql says `volunteer_access`, pinned by `@@map`.
Same for `checked_in_by_volunteer_access_id` and `by_volunteer_access_id`.

A physical rename was rejected because production holds issued access records
and check-in logs referencing them, and a rolling deploy would leave old
instances querying an object that no longer exists — a failure that surfaces
at a gate, at an event, in front of a line.

**Either do it in a planned window, or consciously never do it.** Both are
fine. Drifting into it by accident is not.

Note the mapped approach also buys something: any raw SQL or Supabase RPC
still referencing `volunteer_access` keeps working untouched.

---

## Host row has an empty email

**Added:** 2026-08-30 (S0 verification)
**Row:** `hosts.id = c94cbd1c-b5f9-409f-ae53-efb2a00ddb31` — the host that owns
every current board, including `rpffdlbf` / "Homecoming Fundraising".

`hosts.email` is an empty string. It is `NOT NULL` and `UNIQUE`, so the column
is satisfied and nothing errors today, but:

- **A second host with an empty email cannot be created** — the unique index
  rejects it. `getHost()` upserts `email: user.email ?? user.phone ?? user.id`,
  so a Supabase user with neither email nor phone would collide here.
- Any transactional email keyed off the host address has nowhere to send.
- It is why fixture setup must pin the host by `id`: there is no
  distinguishing field to select on, and `findFirst` would be arbitrary.

**Not fixed here.** Correcting it means writing to a live production row that
owns real boards, which is out of scope for a rename. Needs a deliberate check
of where `hosts.email` is read before it is set.

Observed, not acted on, during S0 fixture planning.

---

## `fs.chmod` mode bits are inert on Windows — use `icacls`

**Added:** 2026-08-30 (S0 fixture tooling)
**Applies to:** S1 tooling, and anything writing a secret to disk.

`writeFileSync(path, data, { mode: 0o600 })` and `chmodSync(path, 0o600)` do
not restrict access on Windows. Node can only toggle the read-only attribute
there; POSIX permission bits have no NTFS equivalent. A file written that way
reports mode `666` and is protected only by whatever ACL it inherits from its
directory.

Observed during S0: the fixture manifest holds working admission tokens and was
believed to be `0600`. It was not.

**Two things to carry forward.**

1. **Harden with `icacls`, and check the exit code.** Grant SYSTEM `(F)`,
   Administrators `(F)`, and the current user `(M)` by SID rather than by
   account name, then `/inheritance:r`. `icacls` returns non-zero on failure
   (verified: exit 2 on a missing path), so a wrapper must throw rather than
   log-and-continue.

2. **Atomic temp-file-and-rename DISCARDS the target's ACL.** The temp file
   carries the directory's inherited ACL, and the rename replaces the hardened
   target with it. Verified directly: an explicit three-ACE file reverted to
   three inherited ACEs after a rename-over. **Harden the temp file before the
   rename**, so the file that lands is already protected and there is no
   unhardened window.

The second point is the one that bites, because the reversion is silent and
happens on the write that adds the secret rather than the one that created the
file.

---

## supabase_admin default privileges on `public` remain uncorrected

**Added:** 2026-08-30 (Data API containment)
**Applies to:** any future Supabase platform upgrade; re-check after each one.
**Blocks:** nothing. S1 may proceed.
**File, preserved and NOT executed:**
`migrations/secure_data_api_supabase_admin_defaults.sql.pending`

The `.pending` extension is deliberate. A known-unexecutable file sitting in
`migrations/` under a plain `.sql` name is a trap for whoever applies the
directory in order.

`migrations/secure_data_api.sql` closed anonymous Data API access to all 15
tables in `public` and corrected the `postgres` default privileges that caused
it. The matching correction for `supabase_admin` could not be applied.

**Precondition that is not met.** Altering another role's default privileges
requires membership in that role:

```
SELECT pg_has_role('postgres','supabase_admin','MEMBER');  -->  false
```

The Supabase dashboard SQL editor also connects as `postgres`, so it would fail
the same way. The file was therefore **preserved but never executed** — running
it would only write a failed transaction into production's log to prove
something `pg_has_role` already settles.

**Do not force it.** No `GRANT supabase_admin TO postgres`, no `SET ROLE`.
`supabase_admin` owns the auth, storage and realtime schemas; granting it to
work around a default-privilege revoke is a far larger change than the problem
it fixes. Escalate to Supabase support instead.

**Residual risk, stated narrowly.** Default privileges govern only objects
created *by* the named role. All 15 tables in `public` are owned by `postgres`,
and S1's six sign-up tables will be created by `postgres` — so the corrected
`postgres` defaults are what actually protect them, and they are sufficient.
What stays uncorrected is `supabase_admin` creating a table in `public` in
future, which a Supabase platform extension or upgrade could do. Such a table
would receive anon and authenticated grants automatically.

**Standing check after any Supabase platform upgrade:** re-run the verifier and
confirm group 2 and group 7 still pass. New tables in `public` are the signal.

## Default ACLs granting anon/authenticated outside `public`

**Added:** 2026-08-30 (observed during the same containment)
**Status:** recorded, deliberately not changed.

`pg_default_acl` also grants anon and authenticated on schemas the containment
did not touch: `postgres` on `storage` (table/sequence/function), and
`supabase_admin` on `graphql` and `graphql_public`. These are Supabase-managed
schemas with their own RLS and policy model — `storage.objects` ships with
policies, and `graphql_public.graphql` is the intended public entry point.

Not a finding to act on blind. If storage buckets ever hold anything
non-public, audit `storage.objects` policies specifically rather than revoking
the schema's default privileges.

## RLS and grants are invisible to `prisma/schema.prisma`

**Added:** 2026-08-30
**Applies to:** every future schema change, S1 included.

`prisma migrate diff` will never report a missing RLS flag or a stray grant,
`prisma db pull` will never introspect one, and `prisma migrate` will never
restore one. If the containment is ever undone it will show as **zero drift**.

The only thing that observes it is `scripts/verify-containment.mts`:

```
node --experimental-strip-types scripts/verify-containment.mts
```

**Run it after any migration that creates anything in `public`.** It is
catalog-driven — it discovers relations rather than enumerating them, so S1's
six tables are tested the moment they exist without anyone remembering to add
them. The exposure arrived through automatic grants; the check is automatic to
match. It fails closed on a table without RLS, any PUBLIC/anon/authenticated
privilege, a reachable view or function, unsafe `postgres` defaults, missing
`service_role` access, a missing catalog column, or a probe that never
completed.

A table that genuinely should be client-readable goes in the script's
`CLIENT_ACCESSIBLE` map with its reason. That is a reviewed exception, not a
silent pass: it still must have RLS on and at least one policy, and its
policies are printed on every run.
