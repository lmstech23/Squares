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

Closing these gaps needs a second `active` supporter, which requires a real
confirmed contribution under a different email. Deferred by standing ruling.
