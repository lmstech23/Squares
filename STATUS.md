# Status

Factual records of what has been exercised by hand, and what has not.

**Keep this current — it is canonical, not a snapshot.** Update it whenever
project verification or build state changes. At minimum: when a manual
verification gap closes, when a preserved fixture is consumed or materially
changed, and when a build step lands. A status file that is only ever accurate
on the day it was written is worse than none, because it is believed.

**This is not a defect list.** Nothing here is a bug. Design decisions go to the
governing document for the area — for sign-up sheets that is
`fundraiser-signup-addendum.md`. Open engineering questions go to
`PHASE-2-BACKLOG.md`.

---

## Environment findings — 2026-09-03

Established by read-only inspection during the spec-freeze preflight. Cross-
referenced to **E1–E5** in `invariant-registry.md`.

### Stripe

| | |
|---|---|
| Vercel **Production** `STRIPE_SECRET_KEY` | **`sk_live_`** |
| Local `.env` and `.env.local` | **`sk_test_`** |
| Publishable key | **none — anywhere** |
| Browser-side Stripe | **none.** No `@stripe/stripe-js`, no `loadStripe(`, no Elements |
| `apiVersion` pin | **none** in `src/lib/stripe.ts` |
| Test/live switch | **none. A single key pair**, mode decided by the environment |

Payment flow is **redirect Checkout**, which needs no publishable key, so its
absence is correct rather than a gap.

**Connect accounts are created in LIVE mode.** `src/app/api/stripe/connect/route.ts`
creates `type: "express"` accounts through the shared client, which reads
`STRIPE_SECRET_KEY`. This **confirms** the earlier record of Express onboarding
with `card_payments` verified in live mode.

**Correction.** A prior backlog note said `STRIPE_PLATFORM_WEBHOOK_SECRET` was
absent and asked whether it existed in Vercel. **It exists, on Development,
Preview and Production, added 192 days ago.** The missing webhook *destination*
was the real defect; the secret was never the problem. That note is wrong and
should be read as superseded by this line.

### Database

**Local `DATABASE_URL` currently points at production.** `.env` and `.env.local`
hold byte-identical values, both resolving to the production Supabase pooler.

**This is PROHIBITED for migration development and for payment testing.** It
violates **E1** (local development never points at the production database) and
**E2** (Stripe mode and database must agree — today local pairs `sk_test_` with
the *live* database, so a test-mode payment would write production rows).

### Card acceptance tests — REQUIRED, ENVIRONMENT BLOCKED, NOT EXECUTED

| Document | Tests |
|---|---|
| `fundraiser-donations-addendum.md` | **12, 13, 14, 17, 19, 20** |
| `fundraiser-launch-readiness-addendum.md` | **28** |

These exercise the card path, which cannot be reached safely: production runs
`sk_live_`, so a card checkout is a real charge against a real connected account
and writes real `paid` squares to the same database holding the preserved S3b
fixture. Local holds `sk_test_` but points at the production database, so it
fails **E2**.

**Their status is ENVIRONMENT BLOCKED — NOT EXECUTED.** Per **E5** they are
**never skipped, never marked green, never dropped from the suite.** They gate
**release**, not merge: code may land with them blocked, but nothing ships to a
paying host until they have run somewhere they can actually run.

### Proposals — NOT IMPLEMENTED

**Environment guard, `scripts/guard-env.mjs`. PROPOSAL ONLY.** Would refuse to
run when `DATABASE_URL` resolves to the production host while a test-mode Stripe
key is present, and refuse `prisma migrate` against production outright. Enforces
E1–E3 mechanically rather than by memory. **Not written, not wired.**

**Stripe `apiVersion` pin in `src/lib/stripe.ts`. PROPOSAL ONLY.** The client
currently pins nothing, so the account's dashboard default applies and Stripe can
move it under a deployed app. **Requires verifying the account's current default
version first.** If the account has already moved past `2026-01-28.clover`,
pinning to clover is a **revert**, not a stabilisation — it would silently change
response shapes the deployed code has been receiving. Verify, then pin to what is
actually in force.

---

## S3 — supporter sign-up sheet, manual acceptance

**Date:** 2026-09-01
**Board:** Fundraiser Test · `jtuyrtvu` · `8aecc880-f8a8-4ea8-9498-c0b8ce04b446`
**Supporter:** Daaliyah · `3a27494f-74a2-43a6-9154-8069adc54ff2` · status `active`
**Environment:** production, `beta.daali.app`, commit `359f6f7`

A single `supporter_access_tokens` row was minted by hand through
`getOrCreateSupporterAccessToken()`, used for the session, and **deleted
afterwards** — token row `3420555d-ba1a-4bcb-bd3b-8ae02243a790`. A fresh token
must be minted for any further manual pass.

### What was actually executed

The planned sequence was `0 → 1 → 4 → replay → 2 → 0 → 1`. **It was not
completed.** The human-executed ITEM sequence was:

```
0 → 4 → 5 → 6
```

Observed `SignupLog`, ordered by `createdAt`:

```
CLAIMED / 4 / SUPPORTER
CLAIMED / 5 / SUPPORTER
CLAIMED / 6 / SUPPORTER
```

Three committed changes, three rows. No unexpected rows, no row of any other
actorType.

### Current fixture — preserved deliberately

```
Case of Water — ITEM — 6/6 (full)
  Daaliyah — quantity 6, positions 1–6
Checkin — SHIFT — 0/2
```

### Manually confirmed

- supporter token route end-to-end
- ITEM increase path end-to-end
- `quantityAfter` matches live state
- actorType mapping
- capacity/ceiling growth to 6

### Not manually exercised

- observed `4 → 4` replay returning `changed: false`
- partial reduction
- `CANCELLED` mapping on decrease
- cancel to zero
- highest-first release
- post-cancel reclaim

**These remain database-suite verified only** — the eight integration cases under
`npm run test:integration`, plus the pure-rule tests in `npm test`. They are not
unverified; they are unverified *by hand*.

On the replay specifically: the absence of a `SignupLog` row is consistent both
with the replay running and correctly writing nothing, and with it never being
run. The log cannot distinguish the two. The only positive evidence is
`changed: false` in the HTTP response, which was not captured.

### Intended next manual verification — do not consume the fixture early

The 6/6 `Case of Water` commitment is **the only real sign-up fixture in the
database**, and it is exactly what S3b needs for per-slot supporter visibility.
**Build S3b against the current state first.**

### S3b acceptance — phase one, NO TOKEN

Runs against the preserved fixture before any new token exists.

**On `Fundraiser Test` / `jtuyrtvu`:**

1. Load `/host/boards/[id]/volunteers` **cold, from the URL** — not by navigating
   through the board page. Verify the route loading state appears.
2. Verify `Case of Water — 6/6` with `Daaliyah — 6`, and `Checkin — 0/2`
   (empty SHIFT presentation).
3. Verify the main board reads `Volunteer sign-up · Open`, `6 of 8 filled`, and
   that **Manage** works.
4. Close sign-ups.
5. Verify the main board reads **Closed** with `6 of 8` intact.
6. Verify **Manage is still enterable while closed**.
7. Verify host slot editing still works while closed.
8. **Capacity-downward refusal on the full ITEM slot.** Attempt `Case of Water`
   `6 → 5`. Expect: refused; the filled count shown in the copy; capacity stays
   6; `Daaliyah — 6` unchanged; positions still 1–6. **Deliberately
   non-destructive** — it manually exercises the already-shipped atomic guard
   without consuming the fixture.
9. Reopen.
10. **Self-gating.** Verify `/host/boards/[id]/volunteers` refuses a Game Day
    board and a board with no `Event`.

**Revalidation — run the same probe twice, once per return path.** Change the
empty `Checkin` SHIFT capacity `2 → 3`, verify `6 of 9` on the main board,
restore `3 → 2`, verify `6 of 8`:

- **A — in-app return**, via the intended navigation link
- **B — browser Back button**

Both must show current server truth. If one is stale, record **which**, apply the
smallest correction, and re-run that exact path. **Add no speculative cache fix
before this runtime test.**

**Do not create a throwaway slot to test revalidation.** The empty SHIFT slot
exists and does the job without touching a real commitment.

**On the no-sheet fixture — `Demo` / `jv9rwyn`:**

11. Cold-load `/host/boards/[id]/volunteers` and verify it renders correctly with
    `sheet === null`.
12. Verify the main board shows the no-sheet compact entry point,
    `Set up volunteer sign-up`.
13. Follow it, and **create the sheet from the dedicated `/volunteers` surface**.
14. Verify the main board subsequently reflects the new sheet state.

Note the display order is `sortOrder`, so the surface lists **Checkin first, then
Case of Water** — verified against the live data 2026-09-01.

### Fixture registry — do not re-run the hunt

Verified 2026-09-01. Seven fundraiser boards exist; five had an `Event` and no
`SignupSheet`.

| Board | Slug | Role |
|---|---|---|
| `Fundraiser Test` | `jtuyrtvu` | **The populated fixture.** Sheet, 6/6 ITEM, empty SHIFT. **Restored to baseline with zero drift** after acceptance — `Checkin` capacity was deliberately changed and restored, so not untouched. **DO NOT CONSUME** |
| `Demo` | `jv9rwyn` | **CONSUMED 2026-09-01** — sheet `18f993c2-…` created, but against the pre-S3b build. **Produced no S3b manual coverage.** See below |
| `Homecoming` | `ah80sph` | **UNTOUCHED** — never opened, no sheet, no writes of any kind. The remaining clean no-sheet fixture, and the one the real S3b no-sheet test must use. Do not spend it |
| `Homecoming` | `5mbxrpbp` | No-sheet, but carries 1 supporter / 2 paid squares |
| `test` | `umt9dpqq` | No-sheet — **EXCLUDED from throwaway use.** Carries real supporter and paid-square data |
| `Homecoming Fundraising` | `rpffdlbf` | No-sheet — **EXCLUDED.** Board is `closed` |
| `Fundraiser Test1` | `67ri0sk7` | Has a sheet. Created on the wrong board during the S3 session |

**Creating a sheet is one-way.** There is no delete-sheet path anywhere in the
codebase — S2 ruling 2 is no-delete, and `SignupSheet` has no removal route. A
board spent as a no-sheet fixture cannot be restored to that state.

`Demo` was spent on 2026-09-01. **`Homecoming` / `ah80sph` is now the only clean
no-sheet fixture left.** After it, none remains and creating one needs approval.

### Demo was consumed without producing S3b coverage

**2026-09-01.** The sheet was created on `Demo` through the browser at
`beta.daali.app`, which was still serving the **pre-S3b build**. What rendered was
the old S2 inline panel on the main host board — `Volunteer Sign-Up · open`,
`Add your first volunteer need`, `Add a shift`, `Add something to bring`.

**Verified in the database:**

- Demo has exactly one `SignupSheet`, id `18f993c2-4ffb-490a-8cc7-1c61845032d1`
- title `Volunteer Sign-Up` — exactly `DEFAULT_SHEET_TITLE`, which `POST`
  hardcodes and cannot be set at creation
- `isOpen = true`, slots `0`
- no supporter, contribution or payment change on that board

**NOT observed, and therefore NOT covered:**

- the no-sheet compact entry point
- `/volunteers` rendering with `sheet === null`
- the S3b create-sheet flow from the dedicated route
- the post-create compact main-board state

**The fixture is spent; the coverage was not obtained.** These four remain open
and must be run against `Homecoming` / `ah80sph` on a build that actually
contains S3b. Group B onward must not be run against `beta.daali.app` until S3b
is deployed there — doing so would exercise pre-S3b UI and prove nothing.

### S3b Phase One — RESULT, 2026-09-02

**Environment — read this before trusting any line below.**

- S3b is **implemented but UNCOMMITTED** in the working tree.
- Browser acceptance ran against the **LOCAL DEV SERVER**, `npm run dev`, using
  the **shared production database**. Every write below is a real production row.
- **`beta.daali.app` served `359f6f7` at the time and did not contain S3b.**
  Nothing in this section was observed on the deployed build.

> **Correction, 2026-09-02.** This line originally said beta served `1cff66c`.
> That was never true — `1cff66c` was a docs-only commit that had not reached
> `origin/main`, and beta was serving `359f6f7`, confirmed from the Vercel
> dashboard. The claim was repeated from the framing of a request without being
> checked, and reached this file that way.

Work was split: the browser observations are the host's, the database
verification is Claude's. Neither is reported as the other.

#### PASS

- the dedicated `/volunteers` surface renders
- per-slot helper visibility renders **inside the matching slot row**
- `Checkin` first, `Case of Water` second
- `Daaliyah — 6` stays attached to `Case of Water`
- compact main-board **Open** state
- compact main-board **Closed** state
- **Manage** available in both states
- a closed sheet remains **fully host-manageable** — add, edit, reorder, reopen
  all stay enabled, and supporter detail stays visible
- reopen works
- capacity refusal `6 → 5` works, with the corrected neutral copy
- reorder works and restores to **baseline values and order**, not merely
  equivalent ordering — `Checkin = 0`, `Case of Water = 1`
- *(revalidation arms — see below; these are **not** a PASS)*

#### Revalidation under local dev — **UNMEASURED, not passed**

Compact-card strings were reported — `6 of 9` after `2 → 3`, `6 of 8` after
`3 → 2`, on both the in-app and browser-Back arms. **But no before-refresh /
after-refresh moment was recorded for any of them.**

That moment is the whole measurement. Staleness lives in the client cache, and
a value observed after a refresh cannot exhibit it. Without knowing which side
of a refresh each reading came from, the arms establish nothing either way —
they are **unmeasured**, not a weaker pass.

Superseded by the production run below, which recorded all four moments.

#### Final state — verified read-only against the pre-flight baseline

All 24 checks PASS. The fixture is **restored to baseline**:

```
Checkin        SHIFT  capacity 2  sortOrder 0  0 positions
Case of Water  ITEM   capacity 6  sortOrder 1  6 positions
Daaliyah       one HelperSignup, quantity 6, positions 1-6, no gaps
               all six on the same HelperSignup and the same slotId
SignupSheet.isOpen = true
SignupLog      exactly 3 rows, same ids as baseline
globals        all ten unchanged
Homecoming / ah80sph still has NO SignupSheet
```

Phase One wrote only what it was meant to: one sheet on `Demo`, and a
`Checkin` capacity round trip that ended where it started. No signup, position,
log, supporter, square or grant row changed.

#### NOT manually verified — these stay open

| Gap | Why it could not be closed |
|---|---|
| loading skeleton | `loading.tsx` **is implemented** — the skeleton was not manually observed rendering during browser acceptance |
| true S3b no-sheet flow | needs `Homecoming` / `ah80sph`, deliberately untouched |
| SHIFT supporter-name rendering with a real signup | needs a second active supporter |
| alphabetical ordering with 2+ supporters | needs a second active supporter |
| multi-supporter ITEM rendering | needs a second active supporter |
| zero-position invariant-39 warning path | **needs a unit test against the display filter** — not a second supporter, not a production row. The filter is pure: given a slot whose signups include one holding zero positions, assert it is excluded. A clean render does not verify it |

A second `active` supporter requires a real confirmed contribution under a
different email. Deferred by standing ruling.

### S3b PRODUCTION acceptance — PASSED, 2026-09-02

**Deployed.** `origin/main` is `a9dac3d`; `beta.daali.app` aliases
`dpl_83Jzm7aM3ptUtCRqvQvVRYCknry6` (`squares-prtxg9hzi`), built 2026-09-02
14:54:51 -0400.

**Rollback target:** `dpl_9g9x3fh2aWUvHhbEBrMQdPeN1GCE` (`squares-5cvlbkcuo`),
built from `359f6f7`, dashboard-confirmed.

**"Deploy to beta" has always meant deploy to production.** This project has no
preview environment — every deployment is production, and `beta.daali.app` plus
three `vercel.app` hostnames alias the same target. The name implied a staging
tier that does not exist. Every run described as "against beta", here and in
earlier sections, was against production on the production database.

#### PASS

- smoke gate on the correct board — `Fundraiser Test` / `jtuyrtvu`, board id
  ending `c0b8ce04b446`
- `Checkin` renders first, `Case of Water` second
- `Case of Water` 6/6, `Daaliyah - 6` rendering without tapping
- the per-slot correction shipped as intended on a real production build

#### Revalidation — both arms, all four moments recorded

Compact card on `/host/boards/[id]`, read on return:

| | Arm A — in-app link | Arm B — browser Back |
|---|---|---|
| **before refresh** | `6 of 9 filled` | `6 of 8 filled` |
| **after refresh**  | `6 of 9 filled` | `6 of 8 filled` |

Arm A changed `Checkin` `2 -> 3`; Arm B restored `3 -> 2`.

**The before-refresh reading is the measurement** — the card was already correct
on return, so there was no client or router cache staleness on either path. The
after-refresh reading is the **control**: identical values rule out an upstream
stale response masking a client-side one. Had before been right and after wrong,
that would have pointed upstream instead.

Database corroborates independently: `Checkin` 0/2, `Case of Water` 6/6, so the
card should read `6 of 8 filled` — which it does.

**No cache or revalidation correction is justified, and none was added.** This
conclusion rests on a measurement that could have failed.

#### Final state — verified read-only against the pre-flight baseline

```
Checkin        SHIFT  capacity 2  sortOrder 0  0 positions
Case of Water  ITEM   capacity 6  sortOrder 1  6 positions
Daaliyah       one HelperSignup, quantity 6, positions 1-6, no gaps
SignupSheet.isOpen = true
SignupLog      exactly 3 rows, same ids as baseline
globals        all ten unchanged, zero drift
```

`Fundraiser Test` / `jtuyrtvu` is **restored to baseline with zero drift**.
`Checkin` capacity was deliberately changed and restored during acceptance, so
it was not untouched — it ended where it started.

`Homecoming` / `ah80sph` is **untouched**: never opened, no sheet, no writes of
any kind.

### Quantity fix — deployed, UI smoke NOT performed

**2026-09-03.** Separate from S3b; recorded here because it is deployed and
unverified.

`06ebe46` — *fix(fundraiser): donor-entered quantity, and unscope the Game Day
cap*. Deployed to `dpl_HwKrgDa95kpzHKBGNvkrovTccDZG`
(`squares-ddpqxdacp`), production, Ready, 2026-09-03 17:55:05 -0400.

Last deployment before it: `dpl_4r6mGQjV2AQQpk6mnqijSKAuPzdj` — the rollback
target if the modal misbehaves.

**No UI smoke has been performed on this deployment.** Six checks are
outstanding, all read-only:

1. presets absent
2. the quantity field can be fully cleared and stays empty
3. the summary reads `0 tickets — $0` at empty
4. Continue is disabled at zero
5. a normal donor-entered quantity works
6. an above-inventory entry caps the summary while editing and clamps to the
   ceiling on blur

**The 11+ card path is blocked and was not tested.** The changed guard in
`checkout/route.ts` is card-path only, and Stripe mode on this deployment is
unverified — if the keys are live, an 11-ticket checkout is a real charge and
real `paid` squares. `cash-reserve` never had the limit, so it cannot exercise
the changed line. See `PHASE-2-BACKLOG.md`, "Stripe test mode is unverified".

So the single line that most needed production verification is the one that
could not be verified. The change is deployed on the strength of tsc, lint, the
test suite, a clean build, and code reading — not on a production observation.

### S3b acceptance — phase two, FRESH TOKEN REQUIRED

**A fresh approved production mint is required first.** The hand-minted token
was deleted at the end of this session, and Daaliyah currently holds **no live
supporter token** — so the planned pass cannot begin until one is issued. That
mint uses the same constrained process as this one:

- existing supporter only — no new supporter, no seeded commitments
- issued through `getOrCreateSupporterAccessToken()`, never a hand-inserted row
- the `supporter_access_tokens` row and nothing else
- capture the raw token immediately; only its SHA-256 hash is stored, so a lost
  URL means deleting the row and re-issuing
- no S4 issuance or email wiring
- delete the hand-minted token again when testing finishes

Once S3b is implemented and visible, and a token has been minted, the next
manual pass is:

```
6 → 4 → 0 → 1
```

performed while watching **both** surfaces at once:

- the supporter sign-up page, `/signup/[token]`
- the host surface, `/host/boards/[id]/volunteers`

Expected `SignupLog` rows **appended to the existing three**, for six total:

```
CANCELLED / 4 / SUPPORTER
CANCELLED / 0 / SUPPORTER
CLAIMED   / 1 / SUPPORTER
```

Host-surface expectations at each step:

- at **4** — `Case of Water 4/6`, `Daaliyah — 4`
- at **0** — the supporter entry disappears cleanly; slot shows `0/6`
- at **1** — `Daaliyah — 1` returns

Delete the fresh hand-minted token afterwards, and nothing else.

The point is to see the host-side slot count and supporter quantity move in real
time while exercising:

- partial reduction
- `CANCELLED` / `quantityAfter`
- cancel to zero
- commitment deletion
- reclaim after zero
- highest-first release, indirectly, through server state and log verification

### Fixture limits — manual-verification gaps for S3b

The preserved fixture is one supporter holding one ITEM slot. Against S3b's
per-slot visibility rules it can prove only:

- ITEM slot rendering
- supporter name
- supporter quantity

It **cannot** manually verify, and these remain gaps after S3b ships:

- **SHIFT supporter-name rendering** — `Checkin` is empty, so the name list has
  no data to render
- **alphabetical ordering within a slot** — ordering is unobservable with one name
- **multiple supporters sharing an ITEM slot** — `Case of Water` is held entirely
  by one person

**Do not read a successful S3b build against this fixture as manual verification
of all per-slot visibility rules.** It verifies the ITEM single-supporter case
and nothing more.

**These three gaps stay open even after the phase-two decrease pass**, and must
not be marked closed here without a second `active` supporter:

- SHIFT supporter-name rendering
- alphabetical ordering within a slot
- multiple supporters sharing an ITEM slot
- **the zero-position invariant-39 warning path**

The first three need a second `active` supporter, which requires a real confirmed
contribution under a different email. Deferred by standing ruling.

The fourth is different, and **needs neither a supporter nor a production row**.
No zero-position `HelperSignup` exists, so a clean `/volunteers` render is
evidence that the corrupt state is absent — not that the filter works.

**It needs a unit test against the display filter.** The filter is pure:
construct a slot whose signups include one holding zero positions, and assert it
is excluded from the rendered list. That is the cheapest of the six gaps and the
only one not blocked on a fixture. Reclassified 2026-09-03.
