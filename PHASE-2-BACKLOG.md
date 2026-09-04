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
