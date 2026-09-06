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

## resolveExpiredHolds confirms without writing a PaymentReference

**Added:** 2026-08-31
**Severity:** edge case — *now*. It was affecting **every card payment** until
the Stripe webhook was configured on 2026-08-31.

`src/lib/checkout-holds.ts` calls `confirmSquares` when Stripe reports a session
paid, but never creates a `PaymentReference`. Only three paths create one:
`api/webhooks/stripe/route.ts:151`, `api/checkout/resume/route.ts:163`, and
`api/host/boards/[id]/confirm-cash/route.ts:79`.

A square confirmed by the cron is therefore `paid` with **no payment record**.
`raised` is unaffected — it sums `Square.pricePaidCents` (invariant 49), not
payment rows — so money figures stay correct. What is missing is the audit
trail: `PaymentReference.timestamp` is the confirmation moment, and for these
squares it does not exist.

**How this was found, and why the severity moved.** Diagnosing a contributor
seeing a false "hold expired", the walkthrough's square #1 was `paid` with no
`PaymentReference` — which is what proved the webhook had never fired and the
cron backstop had confirmed it ~12.7 minutes later. At that point *every* card
payment took this path. The webhook is now live (Connect destination, connected
accounts, snapshot payloads), confirmed by a test purchase that settled in
seconds and did produce a `PaymentReference`. So the cron is back to being what
it was designed as: a backstop for a missed or delayed webhook.

The presence or absence of a `PaymentReference` on a paid card square is a
useful signal — it distinguishes a webhook confirmation from a cron rescue.

## Destination 2 not created — host credit purchases still fail silently

**Added:** 2026-08-31

`/api/webhooks/stripe-platform` handles credit purchases, which run on the
PLATFORM Stripe account rather than a host's connected account, and verifies
against `STRIPE_PLATFORM_WEBHOOK_SECRET`. No Stripe destination points at it.

Same failure shape as the Connect webhook had: a purchase completes at Stripe,
nothing tells the app, and there is no cron backstop for credits the way there
is for squares.

`STRIPE_PLATFORM_WEBHOOK_SECRET` is also absent from local `.env`; confirm
whether it exists in Vercel. Needed: a destination on the **platform** account
listening for `checkout.session.completed` at
`https://beta.daali.app/api/webhooks/stripe-platform`, its signing secret in
Vercel, then a redeploy.

## Should fundraiser boards have a true per-supporter cap?

**Added:** 2026-08-31
**Status:** open product question. Today the answer is accidentally "no".

`Board.maxSquaresPerPlayer` exists but is **Game Day only**:

- `api/checkout/route.ts` enforces it at lines 270 and 374, both behind
  `!isFundraiser`
- it is hard-coded to `10` at creation, `api/boards/route.ts:420`
- no fundraiser form exposes it, and it never reaches the fundraiser view

So a fundraiser contributor may claim any number of squares across repeated
checkouts, and nothing stops them. That is not a decision anyone made — it is
what falls out of the Game Day guard.

The contributor UI uses `MAX_PER_CLAIM` (`src/lib/claim-limits.ts`), which is a
per-TRANSACTION affordance and says so. It is not a per-person cap and must not
be described as one.

**Answering the question needs three things, not one:**

1. a field on the fundraiser creation form — reusing `maxSquaresPerPlayer`
   would be reusing a Game Day rule for a different meaning
2. server enforcement on the fundraiser path, counting across a supporter's
   prior confirmed squares rather than per request
3. a ruling on whether invariant 16 covers it. It is not in the invariant's
   list today. If a cap is a term of the deal, it should lock after the first
   confirmed contribution; if it is aspirational like the goal, it should not.

Worth considering alongside: whether a cap should apply per `EventSupporter`
(identity-keyed by email, so it survives separate checkouts) or per square
claim. The supporter identity already exists and is the natural unit.

## Host panel shows no public slug — the URL is a UUID nobody can verify

**Added:** 2026-09-01
**Scope:** display only. Host panel only. No routing, schema, or API change.
**Do not implement during the S3 manual test session.**

The host board page is addressed by board UUID:

```
/host/boards/[boardId]        page.tsx:37   where: { boardId: id }
```

Slugs appear only on public routes — `/board/[slug]`, `/api/board/[slug]/...`.
So the host panel carries no human-verifiable identifier at all, and two boards
with near-identical names are indistinguishable from the address bar.

**This already cost us a session.** On 2026-08-31 the volunteer sign-up sheet
and its slots were configured on `Fundraiser Test1` (`67ri0sk7`) while the S3
token mint was targeting `Fundraiser Test` (`jtuyrtvu`). Both boards belong to
the same host, so both panels opened normally and neither errored. The mismatch
surfaced only when a precondition check read the database directly:

```
Fundraiser Test    jtuyrtvu   /host/boards/8aecc880-f8a8-4ea8-9498-c0b8ce04b446
Fundraiser Test1   67ri0sk7   /host/boards/a9e46e05-d170-458c-b58b-c185f526e4fe
```

Verifying "by slug" is not possible on this screen, which is exactly the trap.

### Change

Render the board's public slug next to or directly beneath the board name in
the host panel header:

```
Fundraiser Test
jtuyrtvu
```

### Notes for whoever picks this up

- **No new query is needed.** `page.tsx:36` uses `include:` with no top-level
  `select`, so every scalar `Board` column — `slug` included — is already on the
  loaded row. This is one JSX addition.
- **There are two header sites, not one.** `board.gameName` renders in an `h1`
  at both `page.tsx:332` and `page.tsx:486` (the fundraiser and Game Day
  branches). Changing only one leaves the other trap open.
- Consider making it a link to the public board page — the host's most common
  reason to want the slug is to go look at what contributors see.

### Why this is worth doing before Phase B

Phase B testing will create more boards with deliberately similar names. The
failure mode is silent: every write succeeds, authorization passes, and the data
lands correctly on the wrong board. Nothing in the application can detect it,
because from the server's view nothing went wrong.

## Capacity cannot be lowered below occupancy — because host removal does not exist

**Added:** 2026-09-02
**Status:** intentional for S3b. **Not a defect in the capacity guard.**

A host cannot reduce a slot's capacity below its filled count. The guard is one
conditional statement in the slot `PATCH` route and refuses with `409`:

```sql
UPDATE signup_slots SET capacity = $2
 WHERE id = $1::uuid
   AND $2 >= (SELECT count(*) FROM helper_signup_positions
               WHERE slot_id = signup_slots.id)
```

That is correct and deliberate — capacity must never silently orphan a
commitment someone is relying on. **The gap is that there is no other way out.**
`HOST_REMOVED` exists as a `SignupAction` enum value with **no endpoint behind
it**, so a host holding a full slot she needs to shrink has no path at all.

Found during S3b Phase One, 2026-09-02: `Case of Water` at 6/6, `6 → 5` refused
correctly. The refusal copy said *"or remove someone first"*, pointing at a
control that does not exist. That copy was corrected the same day to
`"6 spots are already filled. Set it to 6 or higher."` — the wording no longer
promises the missing action, but the missing action is still missing.

### What future work has to decide first

- **What removal means to the supporter.** Her commitment disappears from a
  sheet she was emailed a link to. Silently, or with a notification?
- **The log semantics.** `HOST_REMOVED` is already the third `SignupAction`
  direction alongside `CLAIMED` and `CANCELLED`, and `quantityAfter` applies —
  a host removing 2 of 6 writes `HOST_REMOVED / 4`.
- **Whether removal is per-position or per-commitment.** Highest-first release
  already exists in `setTargetQuantity`; a host path should reuse it rather than
  grow a second allocator. §14 of the sign-up addendum makes `signups.ts` the
  sole owner of position allocation.
- **Whether lowering capacity should offer removal inline**, or stay a hard
  refusal that sends the host to a separate control. The refusal is the safer
  default and should not be relaxed casually.

Only once that is defined can capacity be reduced below current occupancy. Until
then the refusal is the correct behaviour, not a bug to route around.

## Re-run S3b revalidation against beta after deploy

**Added:** 2026-09-02
**Status:** open. Blocked until S3b is deployed.

S3b Phase One verified main-board freshness after a host action on `/volunteers`
on **both** return paths — the in-app link and the browser Back button. `Checkin`
capacity `2 → 3` rendered `6 of 9`, `3 → 2` rendered `6 of 8`, on both arms.

**That was the local dev server.** `npm run dev` and a production build cache
differently: dev re-renders aggressively, and the Router Cache behaviour that
would produce a stale board page is exactly what dev is least likely to
reproduce. The result rules nothing out for beta.

No cache or revalidation correction was added, and none is justified on this
evidence. **Re-run both arms against `beta.daali.app` once S3b deploys.** If a
path is stale there, correct that path with the smallest change — `prefetch={false}`
on the back link first, then `router.refresh()` before navigating — and re-run
that exact arm.

The failure this guards against: a host saves on `/volunteers`, presses Back, and
sees "Set up volunteer sign-up". She has been told her work vanished.

## `SignupSlot` has no `updatedAt` — reorder writes leave no row-level trace

**Added:** 2026-09-02
**Status:** acceptable now. Revisit if concurrent editing becomes a concern.

`SignupSlot` carries `createdAt` and no `updatedAt`. The reorder handler writes
unconditionally — `normalizeSortOrder` maps every submitted id to its array index
and each row is `UPDATE`d with no diffing:

```ts
for (const { id: slotId, sortOrder } of normalizeSortOrder(submitted)) {
  await tx.signupSlot.update({ where: { id: slotId }, data: { sortOrder } });
}
```

So a reorder and a reorder-then-undo are **indistinguishable in the data**. During
S3b Phase One the slots were moved and restored; the final `sortOrder` values
matched baseline exactly, but whether the rows had been rewritten could only be
established **from the handler's code, not from the rows**. There is no
`updatedAt` to consult and no log — `SignupLog` records supporter quantity
changes, not host slot administration.

**This is fine today.** One host administers one sheet, reorder is idempotent in
effect, and the unconditional write is simpler than diffing.

**Revisit if any of these become true:**

- two people can administer the same board, and a "who moved this?" question
  arises
- slot administration needs an audit trail the way claims already have one
- a lost-update between concurrent reorders becomes plausible — today the last
  writer simply wins, silently

Adding `updatedAt` is a schema change and out of S3b scope. Note that host slot
administration has **no audit trail at all**, which is the larger of the two gaps
and the one worth ruling on first.

## No preview environment — every deployment is production

**Added:** 2026-09-03
**Status:** open. Recorded during S3b deploy.

`vercel ls squares` returns every deployment as `Environment: Production`. **Zero
previews exist.** Four hostnames alias the same production deployment:

```
beta.daali.app
squares-sigma.vercel.app
squares-daaliyah-tates-projects.vercel.app
squares-git-main-daaliyah-tates-projects.vercel.app
```

A push to `main` moves all four together. None is separately pinned, so **there
is no rollback-by-alias net** — recovering means promoting a previous deployment,
not repointing one hostname.

**"Deploy to beta" has meant "deploy to production" for the life of this
project.** The name implied a staging tier that does not exist. Every acceptance
run described as "against beta" ran against production, on the production
database, against real contributor rows.

S3b was presentation-only, which is the only reason this is a note rather than a
blocker. **Stand up a real preview environment before anything with a schema or
API component ships.** At minimum a preview deployment on a non-production branch
with its own database.

## Expose the deployed commit through a build-info surface

**Added:** 2026-09-03
**Status:** open.

`vercel inspect --json` returns `aliases, builds, contextName, createdAt, id,
name, readyState, target, url` and nothing else. **No `meta`, no `gitSource`, no
commit-shaped key anywhere in 134 KB of payload.** The CLI cannot answer "what
commit is deployed".

During the S3b deploy this could only be resolved from the Vercel dashboard by
hand. Timestamp correlation was available — the build started six seconds after
the commit — but correlation is not verification, and a deploy should not depend
on someone reading a web page.

Expose `process.env.VERCEL_GIT_COMMIT_SHA` through a small build-info surface so
the deployed commit is checkable from the command line. Keep it internal or
authenticated: it is not secret, but it is not for contributors either.

## Unit test for the zero-position display filter

**Added:** 2026-09-03
**Status:** open. Reclassified from a manual gap.

`/volunteers` filters out any `HelperSignup` holding zero positions — an
invariant-39 violation — and logs it with `console.warn` under a `volunteers:`
prefix. That path has never been exercised.

It was previously recorded as needing a violating row in production or a
disposable-database run. **That was the wrong classification.** The filter is
pure: it takes the selected slot data and returns the helpers to render. Testing
it needs neither a database nor a second supporter.

Construct a slot whose `signups` include one with `_count.positions === 0`, and
assert it is excluded from the rendered list. **The cheapest of the six open S3b
gaps, and the only one not blocked on a fixture.**

**The work is a small extraction plus a unit test, not a test alone.** The filter
currently lives inline in `volunteers/page.tsx` as `helpersFor`, a closure over
`board` and `event` for the warning's identifiers. Nothing can import it, so
nothing can test it.

Lift the pure part — take slot signups, drop zero-position entries, sort by name
with the supporter-id tiebreak, return the render list — into a module the test
runner can load, leaving the `console.warn` call site to supply identifiers.

**`signup-rules.ts` is the precedent, and it exists for exactly this reason.**
Pure sign-up policy was split out of `signups.ts` after that module gained
`import { prisma } from "@/lib/prisma"` and became unimportable from a test:
`node --experimental-strip-types` does not resolve tsconfig path aliases, and 30
assertions silently stopped running behind a load error. Display and filter logic
belongs on the same side of that line.

## Verification steps must state the screen and the moment of observation

**Added:** 2026-09-03
**Status:** convention, not a task. Apply when writing acceptance steps.

The first production revalidation attempt produced four numbers that measured
nothing, because the protocol said what value to record but not **where** or
**when** to read it.

Both were missing:

- **the screen** — the values came from `/volunteers`, the page that performed
  the write, when the thing under test was the compact card on
  `/host/boards/[id]`, the page being returned to
- **the moment** — the values were read after a hard refresh, and a refresh
  discards the client cache that staleness lives in, so the reading could not
  have failed

Either omission alone invalidates the result. The corrected protocol named the
screen, the navigation path, and both moments — before refresh as the
measurement, after refresh as the control — and only then could the arms pass or
fail on their merits.

**When specifying a verification step, state the screen and the moment of
observation, not just the value to record.** A step that cannot fail is not a
test.

## Stripe test mode is unverified, and there is nowhere to put test keys

**Added:** 2026-09-03
**Status:** open. **Blocks any card-path acceptance test.**

`STRIPE_SECRET_KEY` and `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` are single values in
the environment. There is no test/live switch in the code, no test variant among
the environment variable names, and — because every deployment is production —
nowhere to hold test keys even if there were.

**Nobody has confirmed whether the deployed keys are test or live.** If they are
live, a card checkout on `beta.daali.app` is a real charge against the host's
connected account and creates real `paid` squares plus a real `EventSupporter`.

This blocked the 11+ card acceptance test for the quantity fix: the changed
guard in `checkout/route.ts` is card-path only, and `cash-reserve` cannot
exercise it. So the one line that most needed production verification is the one
that could not be verified.

Needed, in order:

1. Confirm the mode — publishable key prefix, `pk_test_` or `pk_live_`.
2. If live, decide whether card acceptance testing happens at all before a
   preview environment exists, or whether it waits for one.
3. If a preview environment lands, give it test keys and a separate database.

Related: the no-preview-environment item above. These two are the same problem
seen from two directions.

## SQUARE_TAKEN copy is Game Day language on a fundraiser board

**Added:** 2026-09-03
**Status:** open, small.

When another donor takes a square between page load and submit, the atomic
`updateMany` in `checkout/route.ts` matches fewer rows than requested and throws
`SQUARE_TAKEN`, surfacing as:

> One or more selected squares were just taken. Please pick again.

**There is nothing to pick again on a quantity-first fundraiser.** The donor
chose a number; she never selected squares. The copy describes a Game Day grid
that this screen does not have.

Something closer to: *"Some tickets were just taken. Only N are left now."*

Two things it needs beyond the string:

- the **unit** from `purchaseUnit()` — ticket, entry, or contribution — never a
  hardcoded noun
- a **refresh path**. `openSquares` is a prop fixed at render, so the modal
  cannot compute N after a failure without re-fetching. The current message
  avoids this by naming no number.

The rejection itself is correct and the transaction rolls back cleanly. This is
copy plus a refresh, not a correctness fix.

## `maxQuantity` in the claim sheet is stale by construction

**Added:** 2026-09-03
**Status:** noted, not a defect. Do not "fix" by tightening the client.

`maxQuantity = openSquares.length` is computed from props at render, so the
"97 tickets are left" line and the blur clamp both reflect inventory **as of page
load**. On a busy board they drift.

**This is fine, and the client is not the defence.** The real ceiling is the
atomic conditional `updateMany` in `checkout/route.ts`, which matches only rows
still `open` and throws `SQUARE_TAKEN` if fewer match than requested. That guard
holds under concurrency; the displayed number is a courtesy.

Recorded so nobody mistakes the displayed ceiling for authoritative, and so
nobody adds polling or a live inventory subscription to "fix" a number that was
never load-bearing.

## The four production cron endpoints are unguarded execution surfaces

**Added:** 2026-09-04
**Status:** open. `delete-expired` needs review before A1.

`vercel.json` schedules four endpoints that run **in production, against the
production database, on a schedule**, with nothing in this repository inspecting
their environment first:

```
*/5 * * * *   /api/cron/release-expired
0 0 * * *     /api/cron/cleanup
0 6 * * *     /api/cron/expire-boards
0 12 * * *    /api/cron/delete-expired
```

`scripts/guard-env.mjs` does not cover them. Established 2026-09-04 by tracing
every execution path: the guard runs only through wired npm scripts, and a
Vercel deployment executes neither — `vercel.json` sets no `buildCommand` or
`installCommand`, `build` is `next build` with no prebuild hook, and
`postinstall` is `prisma generate` with none either. Cron invocations reach the
database over HTTP with production credentials and never pass through it.

**This is recorded, not a call to add a guard there.** A prebuild or runtime hook
was considered and explicitly rejected — the guard is local safety tooling and
must not be described as a security boundary.

### `delete-expired` needs an authorization and invariant review before A1

It is the destructive one. Before A1 expands the state it can encounter:

- **What it may delete once `Contribution` exists.** Today a board's squares are
  the money record. After A1 the money lives in `Contribution`, and deleting a
  board that still has contribution rows would orphan or destroy the ledger
  those rows constitute.
- **Interaction with invariant 4 (CONFIRMED is terminal) and invariant 68 (the
  three final amounts are written together and are immutable).** A cron that
  deletes a finalized board is deleting numbers those invariants say never
  change. *Citation corrected 2026-09-04: this previously said "13 (final
  amounts immutable)". Invariant 13 governs `finalPrizePoolCents` alone;
  invariant 68 is the carrier for all three fields.*
- **`releaseAdmissionForBatch` already carries an invariant-42 cleanup guard**
  refusing to delete a supporter holding any `HelperSignup`. Whether
  `delete-expired` honours the equivalent for contributions is unverified.
- **Authorization.** It is reached by `CRON_SECRET`; whether that is checked on
  every one of the four, and what happens on a missing or wrong secret, has not
  been read.

Review before A1 lands, not after.

## RETRACTED — "Invariant 13 is cited for three fields but written for one"

**Retracted 2026-09-04**, the day after it was written. **The finding below was
wrong.** It is kept rather than deleted so the error and its cause stay legible.

**What was claimed, and why it was false:**

| Claim | Reality |
|---|---|
| *"`finalPrizeBasisCents` does not exist in the money doc at all"* | **False.** It appears at `fundraiser-money-state-machine.md:367`, inside invariant 21's amended blockquote |
| *"the immutability of `finalRaisedCents` and `finalPrizeBasisCents` is asserted in prose but not carried by any numbered invariant"* | **False.** Donations invariant **68** carries exactly that, and registry row 68 records it |
| *"two plausible resolutions exist and choosing between them is a ruling"* | **False.** The package had already chosen — the second option was the one implemented |

**The evidence that settles it:**

```
fundraiser-donations-addendum.md:207
68. `finalRaisedCents`, `finalPrizeBasisCents`, and `finalPrizePoolCents` are
    written in one transaction and are immutable.
    `finalPrizePoolCents = round(prizePoolPercent × finalPrizeBasisCents / 100)`.

fundraiser-donations-addendum.md:181
54. A confirmed contribution's amounts never change. Square economics remain
    immutable exactly as money doc invariants 4 and 13 require.
```

**Invariant 13 is intentionally one-field and unchanged.** The money doc's
`### Amendments in force` block lists it among *"Invariants 1, 4, 5, 13, 15, 17
are **unchanged**"*, and donations §3 classifies it the same way. Invariant 68
carries the three final amounts; invariant 54 is the cross-reference tying
square economics back to 4 and 13. Nothing is missing.

**How the error happened, because the method is the lesson.** The original
search was `grep -E "^13\. "` against the money doc plus one registry row. From
a scoped search I asserted a universal negative — *"does not exist at all"* — and
never looked outside invariants 1–50, which is precisely where invariant 68
lives. A single unanchored `grep finalPrizeBasisCents` would have refuted it in
one command.

The entry was committed in `290c331` and pushed before the error was found.

---

### Original entry, retained as written and now known to be wrong

## Invariant 13 is cited for three fields but written for one

**Added:** 2026-09-04
**Status:** open. **Reported, not resolved** — the spec package is frozen.

**The money doc, §9, invariant 13:**

> Once `finalPrizePoolCents` is written, it never changes — including for later
> disputes.

**`invariant-registry.md` row 13** records that faithfully — one field:

> `finalPrizePoolCents` never changes once written, including for disputes

**`fundraiser-donations-addendum.md` §3** lists 13 under *"Invariants 4, 5, 13,
15, 17, 24, 31 — unchanged, scope clarified"*, with the clarification:

> 13 — final amounts immutable | Now three fields, written together. See §8

**§8 then relies on that broader reading**, twice. Its closing sequence writes
three immutable fields:

```
7. Write finalPrizeBasisCents — new field, immutable
8. Write finalRaisedCents     — immutable
9. Write finalPrizePoolCents  — immutable
```

and its argument against post-close donations rests on it directly:

> invariant 13 makes `finalRaisedCents` immutable at finalization

### The gap

**Invariant 13, as written, names only `finalPrizePoolCents`.** Read the money
doc and the registry alone and `finalRaisedCents` is not covered by 13 —
invariant 21 governs *when* it is written, not that it may never change
afterwards. `finalPrizeBasisCents` does not exist in the money doc at all.

So §8 leans on 13 for two fields 13 does not name. Nothing contradicts anything;
the addendum classifies 13 as *unchanged*, so the registry is right to quote the
original text. But "unchanged, scope clarified" is doing load-bearing work: the
scope is silently three times what the sentence says.

### Why this is not being fixed here

The package is frozen and §3 explicitly places 13 in the *unchanged* group. Two
plausible resolutions exist and choosing between them is a ruling, not an edit:

- **amend invariant 13** to name all three fields, moving it out of the
  *unchanged* group and into §3's amended list; or
- **leave 13 alone** and let the two new fields' immutability rest on a new
  invariant in the donations block (51–70), where `finalPrizeBasisCents` is
  already introduced.

Until then, anyone implementing §8 should know the immutability of
`finalRaisedCents` and `finalPrizeBasisCents` is asserted in prose but not
carried by any numbered invariant.

**Note on a related citation.** `PHASE-2-BACKLOG.md`'s cron entry cites
"invariant 13 (final amounts immutable)" in the plural. That matches the
addendum's clarified scope rather than the registry's text. It is left as-is:
the plural is the reading §8 depends on, and narrowing it would hide this gap
rather than record it.

## Numeric cross-reference defects in the frozen spec package

**Added:** 2026-09-04
**Status:** open. **Reported, not fixed** — the package is frozen and
`invariant-registry.md` is the numbering authority. Correcting these is a ruling.

Found by auditing every qualified invariant citation across all three addenda.
**Every `<document> invariant N` citation resolves to the correct owning block** —
the audit found zero mismatches there. The defects are all in `§N` pointers and
one unqualified citation.

### 1. Registry row 16 points at the wrong invariant

```
invariant-registry.md
| 16 | **Amended (§72).** Terms lock after the first confirmed square contribution |
```

`§72` is *"Effective price reads early bird or regular; no third source"* —
unrelated to locking. **The lock rule is invariant 76:**

```
fundraiser-launch-readiness-addendum.md:528
76. Early bird fields lock at the first confirmed square with
    `priceSource = early_bird`. The regular price locks at the first confirmed
    square with `priceSource = regular`.
```

Proposed: `§72` → `§76`.

### 2. Registry row 21 points at the wrong invariant

```
invariant-registry.md
| 21 | **Amended (§64).** Finalization cannot occur while any square or contribution is unresolved |
```

`§64` is *"A donation-only contribution has no hold, no `holdExpiresAt`, and no
countdown"* — unrelated to finalization. **The amending invariant is 67:**

```
fundraiser-donations-addendum.md:206
67. `CLOSING` resolves every pending contribution against Stripe ... `CLOSING`
    does not advance while any contribution is `pending`.
```

Proposed: `§64` → `§67`.

Both are near-misses — 72 for 76, 64 for 67 — consistent with transcription
slips rather than a misunderstanding. Rows 2 and 49 use `§51 block`, a range
pointer, and are correct.

### 3. Donations §8 cites invariant 13 for a field 13 does not govern

```
fundraiser-donations-addendum.md, §8
"But invariant 13 makes `finalRaisedCents` immutable at finalization."
```

Invariant 13 governs `finalPrizePoolCents` alone. The carrier for
`finalRaisedCents` is **invariant 68, defined in the same document**. The
argument §8 makes is sound; only the citation is wrong.

Proposed: cite 68.

### 4. The money doc's amendment block is INCOMPLETE for invariant 16

**This is the finding with the most consequence, and it is mine.**

`fundraiser-money-state-machine.md` `### Amendments in force` records:

```
**Invariant 16 — amended by `fundraiser-donations-addendum.md` §3.**
```

**But invariant 16 is amended twice.** Launch readiness §1.4 amends it as well:

```
fundraiser-launch-readiness-addendum.md:130
> **Amendment.** The early bird fields lock at the first confirmed square whose
> `priceSource = early_bird`. The regular price locks at the first confirmed
> square whose `priceSource = regular`. Neither lock affects the other.
```

carried as invariant 76.

**Neither source records both halves.** The money doc names only the donations
amendment; registry row 16 points only at the launch-readiness one (via the
wrong number). A reader consulting either alone gets half the rule.

**Cause.** I wrote that block during the reconciliation commit `91c9a98`, working
from an instruction scoped to *"Sources: donations §3."* I transcribed faithfully
and never asked whether another addendum also amended those invariants. The
instruction was narrow; the block it produced reads as complete.

Proposed: add the launch-readiness amendment to `### Amendments in force`, and
correct registry row 16 to cite both. **Requires a ruling — the money doc is
frozen and this is not a typo but a missing rule.**

## `.env.bak` holds production credentials outside the guard's reach

**Added:** 2026-09-04
**Status:** open. **Do not delete without deciding what replaces it.**

The environment split left two backups in the repository root:

```
.env.bak         production DATABASE_URL, DIRECT_URL, service_role key
.env.local.bak   the same
```

Both are gitignored by `.gitignore:34` (`.env*`) and are untracked, so they have
never been committed. **They are not a leak. They are a bypass.**

`scripts/guard-env.mjs` inspects `.env` and `.env.local` only. A script that
reads `.env.bak` directly reaches production with a full `service_role` key —
RLS-bypassing DML on every table — while the guard reports the environment as
`dev (iujjlgfrwavfhqatpqdy)` and every `npm run db:*` command passes.

**This is not hypothetical.** Three read-only production `SELECT`s were run this
way on 2026-09-04, to answer the A1 pre-implementation questions. They were
authorized, `SELECT`-only, and each asserted the production ref before
connecting. The same mechanism with an `UPDATE` would have been just as invisible
to the guard.

**Why it is not simply deleted now.** The credentials are the only local copy;
production reads for A1 gate calibration may still be needed, and re-fetching
them means another trip through the dashboard and another file on disk holding
them. Deleting the file is easy — deciding what legitimate production reads use
instead is the actual question.

Options, none chosen:

- **delete both**, and fetch production credentials per-use via `vercel env pull`
  to a scratch path, reading and discarding them in one operation
- **move them outside the repository** so no repo-relative read finds them
- **teach the guard to refuse when any `.env*` file in the working directory
  contains the production ref**, which catches the bypass at its source rather
  than relying on the file's location
- **keep them and accept it**, recording that production access is one file read
  away for anyone with the checkout

The third is the only one that closes the class rather than the instance. It also
makes the guard fail on the current working tree until the backups are dealt
with, which is either the point or an obstacle depending on the ruling.

## Donations §5 says `card | cash`; the physical enum is `stripe | cash`

**Added:** 2026-09-04
**Status:** open, cosmetic. **Spec follow-up, not an implementation defect.**

Donations §5 defines `Contribution.paymentMethod` as `card · cash`. The physical
`PaymentMethod` enum has been `stripe | cash` since `0_init`, and `Square` has
used it throughout.

**A1 reuses the existing enum. No second enum was introduced.** A `card` enum
alongside a `stripe` enum, both meaning the same thing, would be worse than the
wording gap: every read would need to know which table used which, and the two
would drift the first time one gained a value.

The schema records the decision at the field:

```prisma
/// Reuses the existing `PaymentMethod` enum (`stripe` | `cash`). Donations §5
/// writes "card"; the physical enum has said `stripe` since 0_init, and a
/// second enum meaning the same thing is worse than the wording gap.
paymentMethod       PaymentMethod      @map("payment_method")
```

**Correct donations §5 to say `stripe | cash` in the next spec revision**, so the
document matches what the database has always held. Nothing in the frozen spec
was modified for this — recorded here per the versioning process.

Worth noting the direction of the error: the spec is describing a *nicer* word
than the schema uses. If anyone later decides `card` is the better name, that is
a rename migration touching `squares.payment_method` too, not a Contribution-only
change.

---

## A1 production apply — runbook, rollback, and the no-PITR ruling

**Added:** 2026-09-04
**Status:** open. **A1 is committed and pushed but NOT applied to production.**
**PITR:** declined on cost, 2026-09-04. A1 approved to proceed without it —
scoped ruling, not precedent. See below.
**Migration:** `prisma/migrations/20260904140000_a1_contribution_ledger`
**Rollback artifact:** `migrations/a1_rollback.sql.pending`
**Rehearsed on:** daali-dev (`iujjlgfrwavfhqatpqdy`) — replayed from zero, seeded
with synthetic fixtures, A1 applied, all seven gates passed, containment
re-verified. **The rollback artifact was then executed there too** — guards,
reversal and forward re-apply, all proven end to end. See "Rollback rehearsal"
below.

Production currently holds **four** migrations. A1 would be the fifth. Nothing
in the deployed application reads `contributions` yet, which is exactly why the
schema change could ship ahead of the feature work — and exactly why there is no
urgency to apply it.

### PITR — DECLINED, and A1 approved to proceed without it

**Ruled 2026-09-04. This closes the blocker that stood here.** It is a scoped
ruling, not a general one — read the last paragraph before citing it.

```
+---------------------------------------------------------------+
|                                                               |
|   POINT-IN-TIME RECOVERY IS NOT ENABLED, AND WILL NOT BE      |
|   PURCHASED FOR THIS APPLY. DECLINED ON COST.                 |
|                                                               |
|   A1 IS APPROVED TO PROCEED WITHOUT IT.                       |
|                                                               |
|   The recovery floor is therefore the latest SCHEDULED        |
|   BACKUP -- not a point in time of your choosing.             |
|                                                               |
+---------------------------------------------------------------+
```

**Why A1 specifically is approved without PITR.** Four things, and all four have
to hold:

1. **A1 is additive.** It creates `contributions`, two nullable link columns and
   one nullable Board column. It writes nothing else.
2. **It is reconstruction-complete.** Every row it backfills is derivable from
   `squares` and `admission_grants`, which it does not mutate — `batch_id`,
   `square_batch_id`, `price_paid_cents`, `final_raised_cents` and
   `final_prize_pool_cents` all come out the far side untouched.
3. **It does not destroy or mutate its own reconstruction sources.** Re-running
   it reproduces the same ledger from the same inputs.
4. **The rollback was proven in both directions on daali-dev** — reversal and
   forward re-apply, 2026-09-04, recorded below under "Rollback rehearsal".

**THIS IS NOT PRECEDENT.** It does not carry to a migration that mutates or
drops existing data, or that writes state which cannot be recomputed from
surviving rows. For those, the absence of PITR is a blocker again, and this
section is not the answer to it.

#### The backup this decision rests on

**Latest completed scheduled backup: `2026-09-04 09:54:45 UTC`.**

A read-only production review on 2026-09-04 (see "Backup gap review" below)
found **no detectable writes after that backup**. The latest detectable write
was `2026-09-03 22:30:53 UTC` — roughly **11h24m *before*** it. So the backup
currently predates every detectable production write, and the gap it would fail
to cover is, as measured, empty.

#### Backup gap review — 2026-09-04, read-only

Timestamp fields were derived from `information_schema`, not assumed. Every
write-recording column across all 22 public base tables returned **zero rows**
after the cutoff:

```
admission_grants.created_at        newest 2026-09-03 22:30:53Z   after cutoff: 0
event_supporters.created_at        newest 2026-09-03 22:30:53Z   after cutoff: 0
squares.claimed_at                 newest 2026-09-03 22:30:53Z   after cutoff: 0
signup_sheets.created_at           newest 2026-09-01 15:50:02Z   after cutoff: 0
squares.confirmation_emailed_at    newest 2026-09-01 13:35:27Z   after cutoff: 0
payment_references.timestamp       newest 2026-09-01 13:31:01Z   after cutoff: 0
admission_passes.created_at        newest 2026-09-01 13:31:01Z   after cutoff: 0
boards.created_at / activated_at   newest 2026-08-31 22:41:38Z   after cutoff: 0
check_in_logs.at                   newest 2026-08-31 17:04:05Z   after cutoff: 0
...and every remaining table, all 0
```

The only columns holding values after the cutoff were **future-dated scheduling
fields** — `boards.campaign_ends_at` / `early_bird_ends_at`, `events.starts_at`,
`signup_slots.starts_at` / `ends_at`. Deadlines and event dates in the future
are what they should be; none of those rows was *written* in the gap. Their
`created_at` values are all Aug 28 – Sep 1.

#### ⚠ LIMITATION — this is a limitation, not a blocker

**There is no `updated_at` anywhere in `public`.** Queried explicitly; zero
columns matching `updated|modified|changed` across every table. So a bare
in-place `UPDATE` that touches no other timestamp **cannot be ruled out** by any
time-based check, including the one above.

What narrows it in practice, and what does not:

- Most state changes do write *a* timestamp — `claimed_at`, `activated_at`,
  `checked_in_at`, `revoked_at`, `confirmation_emailed_at`, `sent_at` — and all
  of those are clean.
- A payment status change would normally also write a `PaymentReference`, and
  the newest of those is 2026-09-01, three days before the cutoff.
- The four production crons run on schedule and can `UPDATE` without a
  timestamp, but `squares.hold_expires_at` maxes at 2026-08-28, so
  `release-expired` has had nothing to act on.
- `helper_signup_positions` has **no timestamp column at all** (6 rows). Its
  parent `helper_signups` was last written 2026-09-01 02:38:39Z, so the rows are
  near-certainly from then — inference, not measurement.

This is recorded so the ruling is made with the gap in evidence visible, not so
the apply waits on it. The general fix is a separate backlog item: the schema
has no way to answer "what changed and when."

#### What "restore" costs now

Everywhere this runbook or `a1_rollback.sql.pending` says *restore*, read it as:

> **return the database to the latest completed scheduled backup.**

Without PITR there is no restoring to a moment of your choosing. **Every write
between the backup timestamp and the moment of restore is lost.** Today that
window is measurably empty, which is the whole basis of this ruling — but it
grows with every hour production is in use, and it is not visible from inside a
`RAISE` message that says "or restore the database."

So: **restore is a last resort with a measurable data-loss cost, not a free
undo.** Before invoking it, measure the current gap the same way the review
above did, and know what you are giving up.

### Environment gates — switching to production, and switching back

The guard (`scripts/guard-env.mjs`, wired through `predb:deploy`) **refuses**
`npm run db:deploy` against production. That refusal is the E3 invariant, and it
is the reason a production apply cannot happen as a side effect of a local
command. Getting past it deliberately requires **both**:

1. `.env` fully repointed to production — `DATABASE_URL`, `DIRECT_URL`, **and
   all three Supabase API variables**. The guard cross-checks the API refs
   against the database ref and refuses a split, which is the failure that
   showed up on 2026-09-04 (auth on production, database on dev).
2. `ALLOW_PROD_DB=i-understand` in the environment for that one command.

**The override lifts E3 only.** E2 still applies: a production database paired
with an `sk_test_` key still refuses, and so does a non-production database
paired with a live key. Do not weaken either check to get a command to run.

**Switch-back is part of the procedure, not cleanup.** The apply window ends
when `.env` is back on daali-dev with all five variables consistent, verified by:

```
npm run guard:migrate        # must PASS, naming iujjlgfrwavfhqatpqdy
```

An `.env` left pointing at production is the state in which the *next*,
unrelated command does the damage. Note that `.env.bak` / `.env.local.bak` sit
outside the guard's reach entirely — separate open item in this file.

### Apply sequence — eight steps, and **the session is not complete until step 8 passes**

Step 8 is not cleanup. An `.env` left pointing at production is the state in
which the *next*, unrelated command does the damage, so the migration session
stays open until the environment is back on daali-dev and the guard says so.

```
1. ATOMIC ENVIRONMENT SWITCH to production.
   All five surfaces together, never partially: DATABASE_URL, DIRECT_URL,
   NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY,
   SUPABASE_SERVICE_ROLE_KEY. A live Stripe key comes with them (E2).
   A half-switched environment is the failure that showed up on 2026-09-04:
   auth on production, database on dev.

2. IMMEDIATELY run:
     npm run guard:env
   Require it to name PRODUCTION on all five surfaces with a LIVE Stripe key.
   If it reports a split, STOP and fix the switch before anything else.

3. RECONSTRUCTION-SOURCE CAPTURE -- mandatory, read-only, before preflight.
   See "Reconstruction-source capture" below. Save to a local, NON-REPO file.
   Never commit it.

4. FRESH PRODUCTION PREFLIGHT -- recompute, do not reuse the numbers below.
   See "Fresh preflight consistency" below. If it does not reconcile, STOP.
   DO NOT APPLY.

5. GUARDED A1 APPLY:
     ALLOW_PROD_DB=i-understand npm run db:deploy
   Never a bare `npx prisma migrate deploy`. The override lifts E3 only.

6. POST-APPLY VERIFICATION -- the recreated ledger against the capture from
   step 3: contribution count, square links, grant relink, confirmedAt
   derivation, finalized money unchanged, Game Day untouched.

7. CONTAINMENT. A1 creates a table in `public`, so this is mandatory:
     VERIFY_SITE_URL=https://beta.daali.app \
       node --experimental-strip-types scripts/verify-containment.mts
   Expect exit 0, and one relation more than the last recorded run.

8. RESTORE THE ENVIRONMENT to daali-dev -- all five surfaces, atomically --
   and run:
     npm run guard:env
   REQUIRE it to report the dev project ref AND a TEST Stripe key.
   The migration session is NOT COMPLETE until this passes.
```

### Reconstruction-source capture — step 3, mandatory

**Purpose is forensic.** It lets the backfill result be recomputed from the
exact inputs that existed immediately before A1 ran. Without it, a
post-apply discrepancy cannot be attributed: you cannot tell a backfill bug from
an input you never recorded. It is also what makes the "reconstruction-complete"
half of the PITR ruling checkable rather than asserted.

Read-only `SELECT`s over `DIRECT_URL`, written to a **local file outside this
repository**. Cover, at minimum:

- **Fundraiser squares carrying `batch_id`** — `board_id`, `batch_id`,
  `position`, `payment_status`, `price_paid_cents`, `claimed_at`.
- **Admission grants carrying `square_batch_id`** — `id`, `event_id`,
  `event_supporter_id`, `square_batch_id`, `source`, `declared_at_purchase`.
- **PaymentReferences used for `confirmedAt`** — per batch, the full set plus
  `MIN(timestamp)`, since that MIN is exactly what the backfill writes.
- **Finalized-board money fields** — `final_raised_cents`,
  `final_prize_pool_cents`, `prize_pool_percent`, and
  `final_prize_basis_cents` (expected NULL everywhere pre-A1).

**No secrets in the capture** — no keys, tokens, connection strings.
**Do not commit it.** It holds production contributor data; `.gitignore` already
ignores `*.sql` at repo root, but the file belongs outside the repo entirely.

### Fresh preflight consistency — step 4, recompute every number

**Recompute at apply time. Do not reuse the numbers below.** They are a snapshot
taken 2026-09-04 for reconciliation, not inputs to trust.

Expected snapshot as of **2026-09-04**:

```
expected_attached       = 38
expected_contributions  = 12
expected_grants         = 13
```

Two independent views must agree, and both must resolve to the same 12 batches:

```
status split :  18 paid  +  20 reserved_cash  =  38
method split :  33 cash  +   5 stripe         =  38
                                   both -> 12 eligible batches
```

The status split was confirmed by the read-only production review on
2026-09-04. The two splits cut the same 38 squares along different axes, which
is the point: a backfill that satisfies one but not the other has miscounted
something, and the disagreement surfaces it before any DDL runs.

**If the fresh preflight does not reconcile — the totals disagree, either split
fails to resolve to 12 batches, or a number moved without a known cause — STOP.
DO NOT APPLY.** A moved number means production changed since this was written,
and the correct response is to understand the change, not to update the
constant.

### Prisma bookkeeping — two cases, TWO DIFFERENT PROCEDURES

These were documented as one procedure until the daali-dev rehearsal on
2026-09-04 executed it and found the Case A half wrong. Full step-by-step in
`migrations/a1_rollback.sql.pending`; the summary here exists so nobody reaches
for the wrong command from this file.

| | Case A | Case B |
|---|---|---|
| **What happened** | A1 applied successfully, then was manually reversed with the rollback SQL | A1 failed during apply; nothing was ever created |
| **`_prisma_migrations`** | finished row, `rolled_back_at = NULL` | failed row, `finished_at = NULL`, `logs` set |
| **Symptom** | `migrate status` says **"Database schema is up to date!"** while the objects are gone | every `migrate deploy` **refuses with P3009** |
| **`resolve --rolled-back`** | **REFUSES — P3012**, "not in a failed state" | **correct**, supported, this is what it is for |
| **Recovery** | capture the row → **explicit approval** → `DELETE` that one row → `migrate status` must show it pending | `resolve --rolled-back`, fix the cause, retry via `npm run db:deploy` |
| **Approval gate** | **YES on production — mandatory** | no |

**Case A is bookkeeping surgery on Prisma's own table.** Prisma has no
supported command for "successfully applied, then manually reversed." The
`DELETE` is the only mechanism, and it is never a casual step in a sequence:
capture `migration_name`, `checksum`, `started_at`, `finished_at`,
`rolled_back_at`, `applied_steps_count` and `logs` first, get explicit human
approval before deleting anything from `_prisma_migrations` on production,
delete **only** the row for `20260904140000_a1_contribution_ledger`, then run
`migrate status` and require it to report A1 as not yet applied. **Do not
proceed if status still claims the schema is up to date** — a mistaken
bookkeeping delete makes Prisma attempt a migration against a schema that still
contains its objects.

The Case A failure mode is worse than an error, which is why it is called out
here and not left to the artifact: nothing warns you. On daali-dev, with
`contributions`, both link columns and `boards.final_prize_basis_cents` all
dropped, `prisma migrate status` reported `5 migrations found` and `Database
schema is up to date!`.

### Case B — what happens when the apply fails mid-flight

**Proven empirically on 2026-09-04**, on a throwaway Docker Postgres database
built for the purpose and since dropped. Measured behaviour, not an inference
from documentation:

- A1's DDL, its backfill and its seven gate assertions are **one transaction**.
  When a gate raises, *everything* rolls back — the table, both columns, the
  enum, the Board column. Verified by looking afterwards: nothing existed.
- **But `_prisma_migrations` keeps a failed row** — `steps = 0`,
  `finished_at = NULL`, `rolled_back_at = NULL`, `logs` holding the error.
- The next `migrate deploy` then **refuses with P3009**, and keeps refusing.
- Recovery, verified end to end:

```
npx prisma migrate resolve --rolled-back 20260904140000_a1_contribution_ledger
```

  after which `migrate deploy` succeeds normally.

So a failed apply needs the `resolve`, **not** the rollback file. Running
`a1_rollback.sql.pending` in that situation is wrong, and its preflight says so
by raising on the missing table. The rollback file is for Case A: A1 applied
successfully and you have decided to undo it. Verify the objects are actually
gone before concluding you are in Case B — the error text is not proof.

Also worth knowing: `migrate deploy` and `migrate status` do **not** verify
checksums of already-applied migrations. Only `migrate dev` detects an edited
applied migration, and its remedy is a database reset. Never edit an applied
migration file.

### The point of no return

`a1_rollback.sql.pending` is safe only while `contributions` holds nothing but
A1's own backfill — because every such row is reconstructable from `squares` and
`admission_grants`, neither of which A1 modifies. The moment post-A1 code writes
state with no source outside the ledger, mechanical reversal destroys real data.

The preflight refuses on any of:

```
donation_amount_cents > 0         a donation has no square to rebuild it from
checkout_session_id  IS NOT NULL  a Stripe session recorded only here
recorded_by_host_id  IS NOT NULL  host attribution recorded only here
confirmed_by_host_id IS NOT NULL  host attribution recorded only here
voided_at            IS NOT NULL  a void is a decision, not a derivation
status = 'released'               written by the resolution path, not the backfill
a contribution owning no squares  a donation-only row — the feature, not A1
boards.final_prize_basis_cents IS NOT NULL    A1 always leaves this NULL
```

**Past that line the answer is reconciliation or a restore.** Do not edit the
preflight to make it pass. If a refusal is wrong, the reasoning above is what
has to change first, in writing.

And weigh the two honestly: with PITR declined, **restore means going back to
the latest completed scheduled backup, losing every write since it** — see
"What 'restore' costs now" above. Reconciliation by hand is usually the cheaper
of the two, and the refusal messages saying "or restore the database" do not
convey that price.

### `delete-expired` — corrected wording

An earlier reading of this cron implied A1 introduced a new deletion hazard.
**It did not, and the correction matters because the original wording would send
someone looking for a regression that is not there.**

`delete-expired` runs
`prisma.board.deleteMany({ status: 'expired', expiredAt < 30d })`.
`Contribution.board` is `onDelete: Restrict`, so a board owning contributions
cannot be deleted — but **`Square.board` has been `onDelete: Restrict` since
`0_init`**, and every board has squares. Board deletion was *already* blocked
before A1 existed.

A1 therefore adds **a second restriction to an already-restricted path**. The
observable behaviour of the cron is unchanged. Risk: **LOW, and pre-existing.**
The real `delete-expired` item — that it fails on an aged board still holding
squares — is item 5 in this file and stands on its own, unrelated to A1.

### Deployment rollback is not database rollback

Reverting the Vercel production deployment restores application code and leaves
the schema exactly where it is. While nothing reads `contributions`, that is
harmless. It is not a substitute for `a1_rollback.sql.pending`, and the two must
not be confused during an incident.

### Rollback rehearsal — executed on daali-dev, 2026-09-04

`a1_rollback.sql.pending` is no longer only reviewed. It was **run**, against
daali-dev (`iujjlgfrwavfhqatpqdy`), from the real post-A1 state: 3 backfilled
contributions, 12 linked squares, 1 linked admission grant, 135 squares across
one Game Day and two fundraiser boards. Production and Squares-staging were not
contacted at any point; the guard was re-run before every write and reported
`db: dev (iujjlgfrwavfhqatpqdy), supabase-api: iujjlgfrwavfhqatpqdy,
stripe: test` each time.

**Guards refuse, and refuse without damage.** Both hazards were introduced
deliberately, one at a time, and removed afterwards:

- Hard-null guard: with `final_prize_basis_cents = 4242` on one fixture board,
  the rollback aborted naming the column and reporting `1 board(s)`.
- Point-of-no-return guard: with `donation_amount_cents = 1500` on one
  contribution, it aborted reporting all seven counts, `donation_amount_cents
  > 0 : 1` among them.
- After each refusal: table, both columns, enum, 3 contributions, 12 square
  links, 1 grant link and all 9 A1 constraints still present. The synthetic
  hazard value itself was still in place, proving nothing had executed. Both
  fields were then restored and the full baseline re-read matched exactly.

*(Setting a non-zero donation also required updating `total_paid_cents` —
`contributions_total_is_sum` rejects the row otherwise. That CHECK doing its
job is a small independent confirmation.)*

**The real rollback removed everything A1 adds**, and nothing else: table,
enum, `squares.contribution_id`, `admission_grants.contribution_id`,
`boards.final_prize_basis_cents`, all 9 constraints, all 5 indexes. Public base
tables 23 → 22.

**Every legacy reconstruction source survived** — 135 squares, all four
`batch_id` values with their exact membership (4 paid / 5 paid / 3
reserved_cash / 1 open), the admission grant with its `square_batch_id`,
`source` and `declared_at_purchase`, both PaymentReferences, and all finalized
money (`final_prize_pool_cents = 1000`, `prize_pool_percent = 20` on the closed
board; squares open 123 / reserved_cash 3 @6000¢ / paid 9 @15000¢).

**A1 then re-applied cleanly through the guarded path** (`npm run db:deploy`),
all seven gates passing, and rebuilt the ledger with identical semantics —
UUIDs differ, nothing else does:

- exactly **3** contributions; **12** linked squares; **1** linked grant
- each batch owned by exactly one contribution; the stale-open batch owned by
  **none**, its square still `contribution_id = NULL`
- the admission grant relinked to the contribution that owns its batch
- `reserved_cash` batch → **pending**; both paid batches → **confirmed**
- `confirmedAt` reproduced exactly: `2026-09-04T15:30:36.674Z`, equal to
  `MIN(payment_references.timestamp)` over that batch's 2 rows
- the two contributions with no PaymentReference kept `confirmed_at = NULL`
- finalized legacy money unchanged; `final_prize_basis_cents` NULL everywhere
- **Game Day untouched** — 100 squares, 0 with a batch, 0 with a contribution

**Containment PASS** (`--catalog-only`, since the production site probe would
have reported on the wrong environment): 23 relations, 0 failures, 0
inconclusive; `contributions` RLS enabled; zero `anon` / `authenticated` /
`PUBLIC` table grants anywhere in `public`. **Drift empty** — `migrate diff`
returned `-- This is an empty migration.` and `migrate status` reported the
history clean.

**Both defects the rehearsal found were found by executing it, not by reading
it.** The file had been reviewed twice and neither survived contact with a
database:

1. **The E-string parse defect.** Every fragment of both `RAISE EXCEPTION`
   messages carried an `E` prefix. Postgres allows `E` only on the *first*
   fragment of an implicitly concatenated string constant, so the file failed
   to parse — `syntax error at or near "E'  donation_amount_cents > 0 : %\n'"`.
   Not destructive, but it would have failed at parse during an incident with
   the schema fully in place: useless at the exact moment it was needed. Fixed
   by collapsing each message to one `E'…'` literal.
2. **The Case A bookkeeping procedure was wrong.** The file prescribed
   `migrate resolve --rolled-back` for the case it is written for; that command
   returns **P3012** and refuses, because the migration is not in a failed
   state. Corrected above and in the artifact.

The first defect was introduced by a "correction" made after the file was
written, on reasoning that was itself wrong — the original single-`E` form
parses *and* processes the escapes throughout. Worth remembering when a tidy-up
edit to unexecuted SQL looks obviously safe.

### Removal condition

Delete this section once: A1 is applied to production, the
containment run after it exited 0, and the first release that actually reads
`contributions` has been in production long enough that reverting the schema is
no longer a live option. At that point move `a1_rollback.sql.pending` out or
mark it spent — a rollback script that can no longer legally run is a trap.

---

## The schema cannot answer "what changed, and when"

**Added:** 2026-09-04
**Status:** open. **Surfaced by the A1 no-PITR ruling, not by a bug.**
**Trigger to fix:** before the first migration that mutates or drops existing
production data — or sooner, if PITR stays declined.

**There is no `updated_at` anywhere in `public`.** Queried directly against
production on 2026-09-04: zero columns across all 22 base tables match
`updated|modified|changed`. There is also no audit table, no trigger-written
history, and no logical-decoding consumer.

The consequence is narrow but sharp: **a bare in-place `UPDATE` that touches no
other timestamp leaves no trace at all.** Row creation is well covered —
`created_at`, `claimed_at`, `activated_at`, `checked_in_at`, `revoked_at`,
`confirmation_emailed_at`, `sent_at` — but those record *events*, and only the
events someone thought to timestamp. Nothing records "this row was modified."

Two places where that already bites:

- **`squares` has no creation timestamp at all** — squares are bulk-created with
  their board. Its only write markers are `claimed_at` and
  `confirmation_emailed_at`, so a `payment_status` change is invisible unless it
  also wrote a `PaymentReference`.
- **`helper_signup_positions` has no timestamp column whatsoever** (6 rows in
  production). It cannot be time-filtered by any means. `SignupSlot` having no
  `updatedAt` is a related, already-open item in this file.

**Why it matters now.** With PITR declined, the recovery floor is the latest
scheduled backup, and deciding whether a restore is safe means answering "what
changed since then." On 2026-09-04 that question was answerable *only* because
production had been idle for eleven hours — the check found zero rows after the
cutoff on every write-recording column, so the uncovered gap was empty by
observation. **That was luck of timing, not a property of the schema.** On a
busy day the same check would return "nothing detectable," which is a much
weaker statement than "nothing changed," and the difference is exactly the
uncertainty a restore decision cannot absorb.

**Options, cheapest first — this is a ticket, not a decision:**

1. `updated_at TIMESTAMPTZ NOT NULL DEFAULT now()` plus a `BEFORE UPDATE`
   trigger on the tables holding contributor/payment/grant state. Prisma's
   `@updatedAt` covers only writes that go through Prisma, so the trigger is the
   part that actually holds.
2. An append-only audit table for the money-bearing tables, which answers *what*
   changed rather than only *when*.
3. Buy PITR and make the question moot for recovery purposes — though it still
   would not answer "what changed" for anything but a restore.

Not urgent while A1 is the migration in flight: A1 is additive and
reconstruction-complete, which is the whole basis of the ruling that let it
proceed. It stops being deferrable the moment a migration mutates or drops
something.

---

## Follow-ups from the cash-ledger fix (2026-09-05)

Three items logged rather than built, so a money fix did not carry unrelated
risk. Classification is the ruling from the proposal, not a guess.

### 1. `releaseFundraiserSquare` helper — deliberately NOT extracted

Six places return a fundraiser square to `open`, and the four launch-blocking
ones were fixed **literally, with repeated code**, on an explicit ruling:
consolidating shared release logic touches Game Day, which was out of scope,
and a Game Day regression must not land inside a money fix.

The repetition is real and should be collapsed later — but only in a change
whose blast radius is release semantics, with Game Day coverage of its own.

### 2. "Back to open" means six different things

Found while auditing the release paths. What each one clears:

```
resume, action=release   playerName/Email/Phone, stripePaymentId,
                         checkoutSessionId, checkoutExpiresAt, holdExpiresAt,
                         batchId, pricePaidCents, claimedAt, contributionId
webhook expired          playerName/Email, stripePaymentId, checkoutExpiresAt,
                         contributionId
release-expired cron     same as webhook expired
cleanup cron             same, plus paymentMethod -> stripe
host manual release      same as cleanup cron
close-board step 2       playerName/Email/Phone, batchId, pricePaidCents,
                         claimedAt
```

Only the `resume` release branch clears `batchId`, `pricePaidCents` and
`claimedAt`. So on five of six paths a released square keeps a stale
`batchId` and the price it was claimed at. `contributionId` is now cleared on
five of six — `close-board` step 2 is the exception, and is safe because it
runs at close, after which no new claim is possible.

Nothing depends on the difference today. It is the same class of defect the
`contributionId` bug was: a field nobody cleared, inherited by whoever claimed
the square next.

**Classified: follow-up.** Fix alongside item 1.

### 3. `PaymentReference.amount` ignores the price actually paid

`confirm-cash` writes `amount: board.squarePrice` rather than the square's own
`pricePaidCents`, so an early-bird cash square records the regular price.

Cosmetic today: nothing reads `PaymentReference.amount` for any total — raised,
the prize basis and the final total all come from `Contribution` or `Square`.
It becomes real the moment anything reconciles against it.

**Classified: follow-up.**

### 4. Confirmation grouping is inconsistent between the two sources

Logged 2026-09-06, not fixed in that batch by ruling.

```
donation confirmations   one email per Contribution. Two donations from one
                         address at different times are two purchases and get
                         two receipts.
ticket confirmations     byRecipient() groups by lowercased email WITHIN one
                         sweep, so a contributor whose squares span two
                         batches gets one email covering both.
```

The donation rule is the stricter of the two and matches "one email per
purchase" literally. The ticket rule predates it, is load-bearing for the cash
path - a host confirming three squares one at a time produces three events that
the sweep deliberately coalesces - and changing it is a behaviour change to a
working money path.

Not a defect on either side today. Recorded so the divergence is a decision
rather than a discovery.

### 5. `notify-winner` interpolates into email HTML

Found while fixing the confirmation-email escaping. `notify-winner/route.ts`
also calls `sendEmail` with a hand-built HTML string. Not audited - it is Game
Day, which has been out of scope, and the escaping fix was scoped to
`confirmation-email.ts`. Worth the same pass.

### 6. A pending Stripe donation can sit in IN CHECKOUT indefinitely

Logged 2026-09-06 with the counter change that made it visible.

A donation holds no inventory, so `holdExpiresAt` is null by design (invariant
64) and `resolveExpiredHolds` never touches it. The ONLY thing that moves a
donation-only `pending` / `stripe` row out of that state is
`checkout.session.expired` -> `releaseContributionBySession`. If that webhook
never arrives, the row stays `pending` forever and stays in the IN CHECKOUT box
forever.

It never reaches any money figure: `raised`, the prize basis and the final
total all read `confirmed AND voidedAt IS NULL`. **This is a display defect,
not a money one.**

Ticket checkouts do not have this problem - they carry `holdExpiresAt` and the
cron sweeps them.

Fix would be a sweep over donation-only pending rows older than some age, or a
`checkoutSessionId` reconciliation against Stripe. Deliberately NOT invented for
the counter: the state is real and countable as it stands, and inventing
persistence to make a box tidy is how the counter starts lying about something
else.

Production at the time of logging: one pending donation-only row, 25 hours old,
`cash` not `stripe`, so correctly in AWAITING PAYMENT. Zero stale card ones.

### 7. AWAITING PAYMENT mixes two host actions

Same pass. The box now counts reserved cash SQUARES and pending donation-only
CASH contributions together. Both are "somebody said they would send money and
has not", which is why they share a box - but they are cleared in two different
places: squares from the cash panel on the board page, donations from
`/host/boards/[id]/donations`.

One number, two places to go and clear it. Ruled not to justify splitting the
counter now. Recorded so the next person to notice it finds a decision rather
than a surprise.
