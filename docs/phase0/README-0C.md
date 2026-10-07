# Phase 0C — Volunteer shifts and item sign-ups

Scope: sign-up sheet, SHIFT and ITEM slots, positional claims, cancellation,
organizer management. Plus `RegistrationLog`, which closes the 0B audit gap.
No money, no notifications, no AI.

## Install

1. Append `prisma/schema.additions.0c.prisma`; add the three back-relations at the
   bottom of that file to the earlier models.
2. Copy `prisma/migrations/0003_signups/`, then migrate.
3. Copy `src/`. No new env vars.

## The test you asked for — run against real Postgres 16

```
10 parallel claims on the FINAL available position (capacity 1)
  PASS  exactly one claimant wins — 1 won, 9 rejected
  PASS  slot holds exactly one position

8 parallel claims against a 3-person shift
  PASS  exactly 3 claimed — 3 won
  PASS  positions are 1,2,3 with no gaps or dupes — [1,2,3]

4 parallel claims of 2 cases against a 6-case item
  PASS  exactly 3 claimants fit — 3 won
  PASS  no claimant was partially filled — 6 positions

composite FK integrity
  PASS  cross-slot position is rejected by the composite FK

cancellation frees positions for reuse
  PASS  third is blocked while full
  PASS  positions cascaded away
  PASS  freed position is reclaimable — got position 1

adding to an existing commitment
  PASS  still ONE commitment row — 1 rows
  PASS  quantity is derived from 3 positions — 3 positions
```

```bash
node tests/signup-concurrency.mjs     # 13 assertions, real contention
node tests/concurrency.mjs            # 0B, still green
npm run test                          # 29 unit tests, no database
```

## One defect the test caught, and the fix

The spec says: on a unique violation, *"roll back, re-read, retry once, then
report what is actually left."*

**Retry-once is wrong when claimants take multiple positions.** With four
concurrent claims of 2 against a 6-case item, a claimant can lose twice and give
up — the first run of this suite produced `2 won, 4 positions` when three should
have fit. Two cases sat unclaimed while a helper was told the slot was full.

The bug is the terminal condition. Giving up on *attempt count* reports "full"
when the truth is "unlucky."

```
retry up to 5 times; the terminal condition is a FRESH READ showing
insufficient free positions — never "I have tried N times"
```

`allocatePositions` returning `null` is what means full. Attempt exhaustion now
returns a distinct `CONTENTION` outcome with different copy ("Several people
signed up at once. Try again."), because they are different facts and a helper
deserves to know which one happened. Five consecutive suite runs: 13/13.

## Carried from the spec, unchanged

- **No `quantity` column.** Quantity is `count(HelperSignupPosition)`. The API
  accepts `quantity: 4`; the database does not keep a second copy of the answer.
- **Capacity by unique index** on `(slotId, position)` — no lock, no counter,
  nothing that can drift.
- **The composite FK** `(helperSignupId, slotId) → HelperSignup(id, slotId)`,
  proved by test: attaching one slot's position to another slot's commitment is
  rejected with `23503`. Two independent FKs would have accepted it and the
  roster would be quietly wrong.
- **One table for both kinds.** Six people on the gate and six cases of water are
  both `capacity = 6`.
- **SHIFT = exactly one position, enforced in code.** A check constraint would
  need `slot.slotType` from another table; Postgres won't allow it. `src/db/signups.ts`
  is the sole owner of claims and the only place that can enforce it.
- **Positions are reusable** after cancellation — a seat, not a credential. This
  is the deliberate divergence from `AdmissionPass.sequenceNumber`.
- **All or nothing.** Never silently give a helper fewer than they asked for.

## Removed from the spec

Donor eligibility. Volunteering does not depend on money, and **a person does not
have to RSVP to volunteer or bring an item** — `claimSlot` resolves identity
itself. The parent who can't attend but is dropping off two cases of water never
touches the RSVP form. Requiring an RSVP first would reintroduce the shape of the
donor gate with a different name.

## The 0B audit gap, closed

`RegistrationLog` records `CREATED`, `PARTY_SIZE_CHANGED`, `CANCELLED`,
`ORGANIZER_REMOVED` with `fromPartySize`/`toPartySize` and the full actor stamp.
*"Who changed this RSVP from 2 to 6?"* is now answerable, and it will be
answerable about Daali too.

It mirrors `SignupLog` deliberately — same shape, same stamp, same reason. Cheap
because 0C was building the pattern anyway; the alternative was a permanent hole.

`RsvpForm` now says **"Your RSVP has been updated."** on a repeat submission
rather than implying a second registration.

## Surfaces

| | |
|---|---|
| `/e/[slug]` | Sign-up sheet below the RSVP form, independent of it |
| `/events/[id]/signups` | Add shifts and items, roster per slot, open/close |
| `POST /api/slots/[id]/claim` | Public, no session, no RSVP required |
| `POST /api/signups/[id]/cancel` | Token or organizer |
| `POST /api/events/[id]/slots` | Organizer: add slot, or `action: 'setOpen'` |

## Next

0D.0 — `NotificationDelivery`, enqueue inside the transaction, drain after commit,
one RSVP confirmation template. No lease, no cron; those are 0D.1.
