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
| `Fundraiser Test` | `jtuyrtvu` | **The populated fixture.** Sheet, 6/6 ITEM, empty SHIFT. Do not consume |
| `Demo` | `jv9rwyn` | **The no-sheet fixture for S3b Phase One.** 0 supporters, 0 paid squares |
| `Homecoming` | `ah80sph` | Spare no-sheet fixture. 0 supporters, 0 paid squares |
| `Homecoming` | `5mbxrpbp` | No-sheet, but carries 1 supporter / 2 paid squares |
| `test` | `umt9dpqq` | No-sheet — **EXCLUDED from throwaway use.** Carries real supporter and paid-square data |
| `Homecoming Fundraising` | `rpffdlbf` | No-sheet — **EXCLUDED.** Board is `closed` |
| `Fundraiser Test1` | `67ri0sk7` | Has a sheet. Created on the wrong board during the S3 session |

**Creating a sheet is one-way.** There is no delete-sheet path anywhere in the
codebase — S2 ruling 2 is no-delete, and `SignupSheet` has no removal route. A
board spent as a no-sheet fixture cannot be restored to that state.

**When Phase One creates the sheet on `Demo` / `jv9rwyn`, mark it CONSUMED here**
and update the remaining list. The next clean spare is `Homecoming` / `ah80sph`.
After that, no untouched no-sheet fundraiser fixture remains, and creating one
needs approval.

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

The fourth cannot be exercised at all right now: **no zero-position
`HelperSignup` exists**, so the defensive `volunteers:` `console.warn` has no
input. **A clean `/volunteers` render is not evidence that the warning works** —
it is evidence that the corrupt state it guards against is absent. The path stays
unverified until either such a row appears in production or it is exercised
against a disposable database.
