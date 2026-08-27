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

Admission is being built in three slices. Slice 1 is schema and the activation transaction, deliberately invisible to users. Slice 2 is contributor and host UI. Slice 3 is the volunteer gate.

---

## Build state — read this before planning any fundraiser work

**Game Day is shipped and live. Fundraiser is specced and at zero.**

Nothing in `fundraiser-board-v2.md` has been built. As of Aug 27, 2026 the schema has no `boardType`, no fundraiser columns on `Board`, no `batchId` / `isHostEntry` / `holdExpiresAt` / `checkoutSessionId` on `Square`, and no `FreeEntry` table. No admission tables either.

**Admission Slice 1 sits on top of v2 §16 steps 1–9, and those are unbuilt.** Slice 1 cannot start until they are. The Slice 1 handoff was originally written against a schema that was never checked; that error is recorded here so it is not repeated.

Verify build state by reading `prisma/schema.prisma`. Do not infer it from a document.

---

## Document authority

| Document | Authority over |
|---|---|
| `fundraiser-money-state-machine.md` | Money, drawing eligibility. Invariants 1–22. **Wins every conflict** |
| `fundraiser-admission-addendum.md` | Admission model and schema. Invariants 23–41 |
| `fundraiser-board-v2.md` | All fundraiser flows and screens. **Flow authority for fundraiser work** |
| `slice-1-handoff.md` | Admission Slice 1 build brief. Derives from the three above |
| `SYSTEM-FLOW.md` | Game Day only. Fundraiser backfill is deferred and blocks nothing |

All five live in the repo root. They are consistent as of admission addendum v1.4. There are no companion or delta files.

**If two documents disagree, that is a bug. Report it. Do not choose.**

---

## Rules

1. **Document first, code second.** Every change gets written down before it is built. For fundraiser work that means `fundraiser-board-v2.md`, not `SYSTEM-FLOW.md`.

2. **Check the flow docs before pushing.** Walk every section the change touches. If the change would break any documented flow, stop and fix the approach first. This rule exists because on Feb 26, 2026, working code was destroyed by changes that ignored the documented flow.

3. **Invariants are not suggestions.** If a test fails against an invariant, the model is right and the code is wrong. If you believe an invariant is wrong, say so and stop — do not work around it.

4. **Stay in scope.** Do not refactor adjacent code, rename things, upgrade dependencies, or improve unrelated files. A diff should contain only what the task asked for.

5. **Game Day is untouched.** Every fundraiser and admission change must leave Game Day behavior and tests exactly as they were.

6. **Ask rather than assume.** File paths, field names, and existing behavior are knowable — read the repo. Product decisions are not — ask.

7. **Cross-reference rules by name, not number.** "The document-first rule," not "Rule 7." Numbering shifts when a rule is inserted, and a stale number sends the reader to the wrong rule.

---

## Untouchable without explicit approval

- The drawing ticket — its meaning, numbering, and lifecycle. Admission never touches it.
- Invariants 1–22 in the money doc.
- Any Game Day flow, route, or test.
- Adding admission columns to `Board` or `Square`. The model deliberately puts none there. If the code seems to need one, the model is being misread.

---

## The drawing ticket is derived — there is no `Ticket` table

A paid drawing ticket **is** the square. There is no `Ticket` model, and none should be built.

```
paid drawing ticket  = Square where paymentStatus = paid
                       AND isHostEntry = false
                       AND board.prizePoolPercent > 0
free entry ticket    = FreeEntry row, F sequence, its own atomic counter
eligible draw pool   = a query over those two, not a table
```

Money doc §5 is the authority: "The paid ticket ID **is** the square position. There is no sequence generator for paid tickets and none should be built."

Two consequences that are easy to get wrong:

- **Confirmation does three writes, not four** — square to `paid`, supporter to `active`, mint passes. Drawing eligibility falls out of the first and needs no write of its own.
- **The only index this implies is `FreeEntry (boardId, sequenceNumber)`.** The money doc's `(boardId, ticketNumber)` uniqueness line describes a guarantee that already holds structurally via `Square (boardId, position)` — it is not an instruction to build an index.

---

## Vocabulary — enforced in code and UI

```
Square #23                 a spot on the board
Drawing Ticket #23         an entry in the prize drawing (derived from the square)
Admission Pass             entitlement for one person to enter the event
Supporter                  one person's identity on one event, across purchases
```

**Never call an admission pass a ticket** anywhere a human can read it.
