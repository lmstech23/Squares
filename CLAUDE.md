# Daali — Working Agreement

Read this before touching anything. It applies to every session, not just the current task.

---

## What Daali is

Board management infrastructure for hosted social competitions. Two board types:

- **Game Day** — the original squares product. Football grids, scores, winners by digit match.
- **Fundraiser** — squares as contributions to a cause, with an optional prize drawing. No scores, no axis math, no digit assignment.

A host runs a board. Contributors claim squares. Daali never moves prize money — the host pays winners externally.

## Where we're going

Fundraiser boards are gaining **optional event admission**. A contribution can also grant admission passes to an associated event, so the host stops running check-in off a printed spreadsheet at a folding table.

The through-line: **Daali handles the seam between money collected and people admitted.** Everything else is deferred.

**Phase A** is a no-prize fundraiser plus admission — the Hampton configuration. Prize boards, the draw, and free entry are **deferred to Phase B** by decision, not configuration. A host cannot switch prizes on in Phase A, and the prize fields do not render on the form. Build order is v2 §16.

Admission itself is three slices: schema and activation, then contributor and host UI, then the check-in gate.

**Check-in staff, not volunteers.** Authority to scan at the gate is a permission,
not a contribution. The Prisma model is `CheckinStaffAccess`; the physical table is
still `volunteer_access` and is pinned with `@@map`, because it holds issued records
and a physical rename during a rolling deploy would break the gate mid-event.
Sign-up addendum §2.

---

## Build state

**Verify build state by reading `prisma/schema.prisma`. Never infer it from a document.**

The fundraiser spec was written long before any of it was built, and a brief was once written against a schema nobody had checked. That is the failure this section exists to prevent.

Done: **A1**, **A1b**, **A2**, **A3** — both migrations written, board type picker, fundraiser form and API branch.
Next: **A4** — fundraiser grid and contributor board (v2 §6, §7).

Board dates are stored in UTC and entered as wall clock in `Board.timezone`
(one zone per board, covering early bird, close, draw, and event). Convert with
`src/lib/zoned-time.ts` — never `new Date(localString)`, which reads as UTC on
Vercel and silently moves a deadline. `npm test` covers the DST boundaries.

Concurrency guarantees are covered by real-database tests, not mocks:

```
npm run test:db:up        disposable Postgres in Docker, schema built by db push
npm run test:integration  the 8 confirmation/minting cases
npm run test:db:down
```

`npm test` alone reports **1 skipped** when that database is absent — the skip
is the signal that concurrency went unverified, not noise.

**No gate on fundraiser creation.** An allowlist was built and removed — it
protected a population that does not exist, since there are no Game Day
customers. Bring it back only if Daali has hosts who are not the person
building it *and* A9 plus a ticket email still do not exist. v2 §14.

**One email per purchase, both board types.** Confirmation email is a shared
path in `src/lib/confirmation-email.ts` — never a per-square loop. This is a
deliberate exception to "Game Day is untouched": two email paths would drift,
and the one that drifts is whichever gets tested less. Decided Aug 28, 2026.

**`prisma/migrations/0_init` is this repo's first reproducible database history — it is not a consolidation of an existing one.** There was never a replayable base. Replaying the eleven hand-applied files against a clean database fails on the very first one: `add_monetization.sql` expects `hosts` to exist, and nothing in version control ever created `hosts`, `boards`, or `squares`. They were made by `db push` or by hand and never recorded. Eleven files patched an undocumented state. `0_init` is built from the physical catalog and is the first thing in this project that can rebuild the database from nothing.

Those eleven files stay at repo-root `migrations/` as **provenance**. They must never move into `prisma/migrations/` — Prisma reads only that directory, so their *location* is what keeps them out of the replay chain. A header comment would not.

Migration SQL lives in `migrations/`, applied by hand. Note `.gitignore` ignores `*.sql` with a `!migrations/*.sql` exception — without it a new migration silently never commits. A `.sql.pending` file is **not** runnable — it is kept for reference and its precondition is in `PHASE-2-BACKLOG.md`.

**RLS and role grants are invisible to `prisma/schema.prisma`.** `migrate diff` reports zero drift whether or not the database is exposed, `db pull` never introspects them, and `migrate` never restores them. On Aug 30, 2026 every table in `public` was found granting `anon` and `authenticated` full DML — 1,300 contributor rows readable and writable over the Data API — caused by `pg_default_acl`, which grants those roles on every **new** table automatically. Closed by `migrations/secure_data_api.sql`.

So after any migration that creates anything in `public`:

```
VERIFY_SITE_URL=https://beta.daali.app node --experimental-strip-types scripts/verify-containment.mts
```

It reports two independent conclusions — **DATABASE CONTAINMENT** and **PRODUCTION SITE SMOKE**. Without `VERIFY_SITE_URL` the second reads `LOCAL ONLY / PRODUCTION UNVERIFIED` and exits 2, because `NEXT_PUBLIC_URL` is `localhost:3000` and a healthy database says nothing about the deployed app. Exit 0 means both passed; 1 means something failed.

It is catalog-driven and fails closed, so a new table is checked without anyone adding it to a list. A table that genuinely should be client-readable goes in its `CLIENT_ACCESSIBLE` map with a reason, still requiring RLS and a policy — never a silent pass.

---

## Document authority

| Document | Authority over |
|---|---|
| `fundraiser-money-state-machine.md` | Money, drawing eligibility, pricing. Invariants 1–22 and 42–44. **Wins every conflict** |
| `fundraiser-admission-addendum.md` | Admission model and schema. Invariants 23–41 |
| `fundraiser-board-v2.md` | All fundraiser flows and screens. **Flow authority for fundraiser work** |
| `slice-1-handoff.md` | Admission Slice 1 (A8) build brief. Derives from the three above |
| `system-flow-port.md` | The three admission edits for SYSTEM-FLOW. **Already applied** |
| `SYSTEM-FLOW.md` | Game Day only. Fundraiser backfill is deferred and blocks nothing |

Consistent as of admission addendum v1.7.

**If two documents disagree, that is a bug. Report it. Do not choose.**

---

## Rules

1. **Document first, code second.** Every change gets written down before it is built. For fundraiser work that means `fundraiser-board-v2.md`, not `SYSTEM-FLOW.md`.

2. **Cite SYSTEM-FLOW rules by name, not number.** That file has gained rules over time, so numbers drift between copies. Say "the document-first rule," not "Rule 7."

3. **Check the flow docs before pushing.** Walk every section the change touches. If the change would break any documented flow, stop and fix the approach first. This rule exists because on Feb 26, 2026, working code was destroyed by changes that ignored the documented flow.

4. **Invariants are not suggestions.** If a test fails against an invariant, the model is right and the code is wrong. If you believe an invariant is wrong, say so and stop — do not work around it.

5. **Stay in scope.** Do not refactor adjacent code, rename things, upgrade dependencies, or improve unrelated files. A diff should contain only what the task asked for. This includes formatters — `prisma format` realigns the whole schema and buries a real change in 163 lines of noise.

6. **Game Day is untouched.** Every fundraiser and admission change must leave Game Day behavior and tests exactly as they were.

7. **Ask rather than assume.** File paths, field names, and existing behavior are knowable — read the repo. Product decisions are not — ask.

8. **Catalog first, tool output second.** A `prisma migrate diff` line is a
   proposal, not a fact about the database. Before acting on one — or calling it
   cosmetic — read `pg_index`, `pg_constraint`, `pg_policies`, `pg_trigger`.
   Three times in one session a summary was wrong where the catalog was right:
   "four missing indexes" were three existing *partial* ones, a category count
   hid six unexamined statements, and "26 cosmetic FK statements" were thirteen
   real changes to `ON DELETE`. Classify every statement individually and check
   the arithmetic.

8. **Never overwrite `SYSTEM-FLOW.md` from a circulating copy.** The repo's is newer than any zip or project-knowledge version and carries the double-grid feature. Port edits onto it by hand — `system-flow-port.md`.

---

## Untouchable without explicit approval

- The **drawing ticket concept**. There is no `Ticket` table and none should be built. Admission never touches it.
- Invariants 1–22 and 42–44 in the money doc.
- Any Game Day flow, route, or test.
- Adding admission columns to `Board` or `Square`. The model deliberately puts none there. If the code seems to need one, the model is being misread.

---

## The drawing ticket is derived — there is no `Ticket` table

```
paid drawing ticket  = Square where paymentStatus = paid
                       AND isHostEntry = false
                       AND board.prizePoolPercent > 0
free entry ticket    = FreeEntry row, F sequence, its own atomic counter
eligible draw pool   = a query over those two, not a table
```

Money doc §5 is the authority. Two consequences:

- **Confirmation does not write a ticket.** Drawing eligibility follows from the square reaching `paid`. On a Phase A no-prize board `prizePoolPercent = 0`, so no ticket exists at all.
- **The only index this implies is `FreeEntry (boardId, sequenceNumber)`.** The `(boardId, ticketNumber)` uniqueness line describes a guarantee already held by `Square (boardId, position)` — not an index to create.

---

## Pricing

`raised` is the **sum of `Square.pricePaidCents`** over confirmed squares. Never `count × price` — invariant 43.

Price is fixed the moment a square leaves `open`, at claim or at cash reservation, and never recomputed — invariant 42. A cash square reserved at the early-bird price and confirmed a week later is still owed the early price, and the host's cash panel must show the amount that square was reserved at.

---

## Vocabulary — enforced in code and UI

The purchase unit is named by what the buyer actually gets. One resolver,
`purchaseUnit()` in `src/lib/board-vocabulary.ts`, keyed on the same
`hasEvent` / `hasPrize` predicates that drive the CTA. **Never branch this copy
inside a component** — the point is that a screen written six months from now
cannot say "squares" on a fundraiser.

```
Square          a position on a Game Day board — and genuinely what it is
Ticket          the purchased unit on an event fundraiser
Entry           the purchased unit on a prize-only fundraiser
Contribution    the purchased unit on a standard fundraiser (no event, no prize)
Pass            event admission credential. ALWAYS "pass", never "ticket"
Supporter       one person's identity on one event, across purchases
```

**Reserve "pass" for admission.** A supporter buys fundraiser **tickets**; what
gets them through the gate is an admission **pass**. Both were briefly called
"ticket", which reads fine at one-to-one and falls apart the moment someone
ticks "I won't be attending" and holds 1 ticket and 0 tickets. That sentence
must not be constructible.

Precedence on a board that is both ticketed and prize-bearing: **`hasEvent`
wins.** Admission is something the buyer needs at a gate; a drawing is a chance.

Display only. `Square`, database columns, API fields, routes (`/tickets/[token]`,
`/api/tickets/[token]/qr`) and every schema concept are unchanged. Game Day
remains squares throughout.
