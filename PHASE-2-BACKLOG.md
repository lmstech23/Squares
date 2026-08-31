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
VERIFY_SITE_URL=https://beta.daali.app node --experimental-strip-types scripts/verify-containment.mts
```

Two independent conclusions: **DATABASE CONTAINMENT** and **PRODUCTION SITE SMOKE**. Without `VERIFY_SITE_URL` the site conclusion is `LOCAL ONLY / PRODUCTION UNVERIFIED` (exit 2) and never green — `NEXT_PUBLIC_URL` is a local dev value, and a page check against `localhost` once got reported as if it were production.

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

---

# Confirmation email — five confirmed defects

**Added:** 2026-08-30, from a read-only audit of every email caller.
**Production state at time of audit:** 16 paid squares, all `payment_method = cash`,
9 communication units, **0 unstamped**. Zero confirmed card squares exist, so the
webpath below has never run in production.

**Nothing here is a confirmed duplicate delivery.** Database patterns identify
duplicate-send CANDIDATES only — a supporter may legitimately contribute twice.
There is no `RESEND_API_KEY` in the local environment, so Resend history could
not be correlated by recipient, template, purchase key and time. Two recipients
show a **plausible duplicate pattern**; neither is established as a duplicate.

## 1. No atomic delivery claim — webhook and cron can select the same rows

`sendPendingConfirmations` runs `findMany` (unstamped, paid) → group → `sendEmail`
→ `updateMany` stamp. **No transaction, no lock, no claim step.** The window
between selecting a row and stamping it spans a network call to Resend.

The cron fires every five minutes with a global filter; the Stripe webhook fires
on card confirmation. Two invocations can select the same rows and both send.

The race becomes possible with the first confirmed card contribution, and can
produce duplicate receipts whenever webhook delivery overlaps another sweep.
**The defect exists now; the duplicate is timing-dependent.**

Fix shape: claim before sending — stamp under a conditional `updateMany` that
matches only still-unstamped rows, send only what the claim returned, and clear
the stamp on send failure. That inverts the current order deliberately.

## 2. Global sweep combines boards and applies `squares[0]` branding

The cron calls `sendPendingConfirmations({})` — no `boardId`, no `batchId` — so
the sweep spans every board. But `boardName` and `isFundraiser` are read from
`squares[0]` only. Every recipient in that sweep receives the **first** board's
name and the first board's copy.

Worse, `byRecipient` keys on email address alone, so one person holding squares
on two boards receives a single email listing both boards' positions under one
board's name, with fundraiser-vs-Game-Day wording chosen by whichever board
sorted first.

Latent only because production has one active board.

## 3. Board-level webhook fallback mails unrelated supporters

`handleCheckoutCompleted` calls `sendPendingConfirmations({ boardId })` whenever
the confirmed square has no `batchId`. That sweeps the whole board and mails
every unstamped recipient on it, not the purchaser.

**Implemented and reachable in code, but production-unexercised.** The five
units with no `batchId` are all cash and prove nothing about card behaviour.

## 4. `confirm-cash` writes `PaymentReference` after the transaction commits

`src/app/api/host/boards/[id]/confirm-cash/route.ts`: `confirmSquares` runs
inside `prisma.$transaction`, then `paymentReference.create` runs **outside** it.
A failure between the two leaves a `paid` square with no `PaymentReference`.

The Stripe webhook puts the same create **inside** its transaction. The two
confirmation paths do not behave the same way, and the cash path is the weaker
one. Do not assume they are symmetric.

## 5. `delete-expired` will fail on an aged board still holding squares

`src/app/api/cron/delete-expired/route.ts` calls `board.deleteMany` for boards
expired past 30 days. `squares_board_id_fkey` is physically **`ON DELETE
RESTRICT`**, so deleting a board that still has squares raises a foreign-key
violation and the route returns 500.

Has not fired because no board has both expired and aged past the cutoff.

## Semantic gap — recipient coalescing contradicts receipt identity

**Not a defect in the above sense, and not the design working.** `byRecipient`
groups on email address, collapsing two separately confirmed purchases into one
receipt. That contradicts v1.5's `grant:{id}` receipt identity.

**S4 must decide this deliberately:** either one delivery row per grant, matching
the invariant, or a redefined recipient digest with its own identity rule. **The
approved design says per grant.** Until S4 rules, do not treat coalescing as
correct behaviour merely because it is the current behaviour.

## Encoding artifact in prisma/schema.prisma

**Added:** 2026-08-31
**Severity:** cosmetic. No behavioural effect.

`prisma/schema.prisma` contains a mangled character in a comment:

```
// Dismiss feature (Addendum K) ? soft-hide from host dashboard
```

The `?` is a corrupted em-dash, almost certainly from a UTF-8 file being
written through a cp1252 path on Windows. It is inside a comment, so it changes
nothing at runtime and Prisma parses the file fine.

**Deliberately NOT fixed in the baseline commit.** Mixing a cosmetic character
change into a diff that carries schema declarations and a security baseline
makes the part that matters harder to review. Fix it on its own, and check
whether other files carry the same artifact from the same write path.

---

# S1 checklist — verification steps queued before the sign-up build

**Added:** 2026-08-31, queued behind `prisma migrate resolve --applied 0_init`
so they are not lost when that step is authorized.

## 1. Confirm the connecting role over DIRECT_URL

```sql
SELECT current_user;
```

Run this **over `DIRECT_URL`**, in the S1 verifier run, and assert the answer is
`postgres`.

**Why it is not a formality.** The four `ALTER DEFAULT PRIVILEGES` lines in
`0_init` are scoped `FOR ROLE postgres`. Default privileges govern only objects
created **by the named role**. If S1's six tables are created over a connection
authenticating as anything other than `postgres` — a different pooler user, a
Supabase-managed role, a migration run under another identity — those tables
fall outside the scope of the revoke entirely and will receive whatever default
privileges that other role carries. The protection is role-scoped, not
database-scoped, and asserting the role is what makes it real rather than
assumed.

`scripts/verify-containment.mts` already asserts `current_user = 'postgres'`,
but over `DATABASE_URL` (the pooler). The migration path uses `DIRECT_URL`.
**Assert it on the connection that actually creates the tables.**

## 2. Make the RLS table-name-set diff repeatable, not a one-time proof

The three-way diff run on 2026-08-31 — production catalog vs `0_init`
`CREATE TABLE` vs `0_init` `ENABLE ROW LEVEL SECURITY`, all 15 identical — was
a **one-time proof for the current 15 tables**. It is not a standing check.

**RLS is per-table.** There is no schema-wide form of
`ENABLE ROW LEVEL SECURITY`. Coverage is 15 individual statements whose names
happen to match, so coverage **can** drift table by table: a sixteenth table
added to a baseline without a matching RLS line is a silent gap, and only a
name-set diff catches it.

Before S1 merges, turn that diff into a repeatable check that covers the six
new tables automatically:

- derive the name set from the migration file(s), not a hardcoded list
- derive the name set from the live catalog
- fail on any name present in one set and absent from the other, in either
  direction
- run it in the same pass as `verify-containment.mts`

Note the related asymmetry while doing it: `REVOKE ... ON ALL TABLES IN SCHEMA
public` is schema-wide **at execution time only** — it covers tables existing
when it runs, never tables created later. Only the `ALTER DEFAULT PRIVILEGES`
lines cover the future case. A baseline that revokes and then creates a table
afterwards leaves that table exposed.

## 3. Sequence statements are currently no-ops — do not read them as coverage

No model uses `@default(autoincrement())`; production has **zero** sequences in
`public`. So these three lines in `0_init` act on an empty set today:

```
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC, anon, authenticated;
GRANT  ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;
ALTER DEFAULT PRIVILEGES ... REVOKE ALL ON SEQUENCES FROM anon, authenticated;
```

If S1 introduces an `autoincrement()` column, the **default-privilege** line is
the one that protects the resulting sequence. The two `ALL SEQUENCES` lines
operate at execution time and would not cover a sequence created later.

## Invariant 16 wording gap — "event date" is narrower than the code

**Added:** 2026-08-31, while writing the first enforcement of invariant 16.
**Severity:** documentation. The code is deliberately stricter than the text.

Money doc invariant 16 locks, on boards with an event, the **"event date"** —
singular. `src/lib/board-lock.ts` locks `startsAt`, `endsAt` **and** `timezone`.

**Why the code is broader.** An event stored as `2026-10-24T14:27Z` in
`America/New_York` reads 10:27am Eastern. Re-label the board `America/Chicago`
and the same stored instant reads 9:27am — the wall-clock time a supporter was
told has moved, with `startsAt` and `endsAt` untouched. Locking the date alone
leaves that bypass open, and an invariant that can be sidestepped by editing a
timezone string protects a column rather than a contributor. `endsAt` is
included because it is half of the event date; a supporter who planned around a
stated end time is as affected by moving it.

**The wording should say something closer to** "the event's scheduled time,
including its timezone" **rather than "event date".**

Flagged, not resolved — per the rule that a document gap is reported rather
than chosen. If the addendum lands narrower than the code, narrow the code to
match rather than leaving the two disagreeing.

**Related, not yet enforced anywhere:** contribution price, early-bird terms and
prize terms are also locked by invariant 16 and currently have no edit surface
at all, so nothing guards them. When any of them gets one it must call
`hasConfirmedContribution` from `lib/board-lock.ts` rather than growing its own
check.
