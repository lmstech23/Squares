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
`raised` is unaffected — it sums `Square.pricePaidCents` (invariant 43), not
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
