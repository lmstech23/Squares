> **Correction note (added Oct 7, 2026, at the port).** The wording below says
> access tokens are "derived, not stored". The *plaintext* token is never stored:
> it is `HMAC(ACCESS_TOKEN_SECRET, eventPersonId:version)`, recomputed on demand.
> But a row **is** stored per person: `EventPersonAccessToken` (now
> `DaaliEventPersonAccessToken`, table `daali_event_person_access_tokens`) holds
> `version` (bumped to revoke), `tokenHash` (sha256 of the derived token) and
> `revokedAt`. `getOrCreateAccessToken` in `src/lib/accessToken.ts` reads and
> upserts that row. The README text below is the original, unchanged.

# Phase 0B — Registration / RSVP

Scope: Registration, free RSVP, capacity + concurrency, self-service cancellation,
organizer roster. No volunteers, no money, no waitlist, no AI.

## Install

1. Append `prisma/schema.additions.0b.prisma` to `prisma/schema.prisma`, and add
   the three back-relations listed at the bottom of that file to the 0A models.
2. Copy `prisma/migrations/0002_registration/`, then `prisma/migrate deploy`.
3. Copy `src/` over the app root.
4. **New env var:** `ACCESS_TOKEN_SECRET` — 32+ random characters. This is the only
   new configuration in 0B.

## The critical test — actually run, actually passing

```
20 concurrent RSVPs against 10 seats
  PASS  exactly 10 confirmed — 10 confirmed, 10 rejected
  PASS  seats never exceed capacity — seatsTaken=10

10 concurrent parties of 3 against 10 seats
  PASS  3 parties fit, 1 seat left unsold — confirmed=3 seats=9
  PASS  no party was partially admitted — seatsTaken=9

cancellation frees seats
  PASS  third is rejected while full
  PASS  third gets in after a cancellation — seatsTaken=2

one live registration per person
  PASS  first RSVP succeeds
  PASS  duplicate live RSVP is blocked by the index — code=23505
  PASS  re-RSVP after cancelling is allowed

uncapped event
  PASS  all 15 admitted — seatsTaken=30
```

Run it against a real Postgres:

```bash
npm i -D pg          # the harness's only dependency
createdb daali
psql -d daali -f prisma/migrations/0001_event_foundation/migration.sql
psql -d daali -f prisma/migrations/0002_registration/migration.sql
node tests/concurrency.mjs
```

`tests/concurrency.mjs` issues the **same SQL** `registerForEvent` does — lock the
Event row, derive `SUM(partySize)` over CONFIRMED rows, all-or-nothing — through a
30-connection pool. It is a proof of the strategy, not a mock.

`npm run test` covers the pure layer: 22 unit tests, no database.

## Design notes

**Capacity is derived, never stored.** `src/db/capacity.ts`. Every writer that can
change seat occupancy takes `SELECT … FOR UPDATE` on the Event row first, which is
what serializes them. There is no counter to drift. Cancellation frees seats with
no decrement anywhere, because the count is a `SUM` over CONFIRMED rows.

This serializes RSVPs per event. Free at a hundred people; not free at a ticket
on-sale with thousands of simultaneous buyers. Revisit there, with load evidence.

**One live registration per person** is the partial unique index
`Registration_live_key … WHERE status = 'CONFIRMED'`. Prisma cannot express partial
indexes, so it lives in the migration by hand — do not "fix" this by adding
`@@unique`, which would forbid re-RSVP after a cancellation.

A second RSVP from the same email is therefore a **change of party size**, not a
duplicate. The command computes the delta and checks capacity against that.

**Access tokens are derived, not stored.** `src/lib/accessToken.ts` deviates from
the addendum, on purpose. The old `getOrCreate…` had to return the existing live
token, which is impossible when only `tokenHash` is persisted — implying the
plaintext was stored, putting every live magic link in the database in readable
form. Deriving it instead —

```
token = HMAC(ACCESS_TOKEN_SECRET, `${eventPersonId}:${version}`)
```

— gives idempotent reissue with no secret at rest. Two callers milliseconds apart
cannot mint competing links, which is the property the addendum actually wanted.
Revocation bumps `version`.

**The token never enters `CommandExecution.result`.** `registerForEvent` returns
`eventPersonId`; the route derives the link afterwards. Command results are
persisted verbatim for replay, and a magic link does not belong in a durable row.

**`EventState` gained `registrationCount`**, exactly as the plan predicted, and it
broke every caller until each supplied it. `timezone` is now immutable once anyone
has RSVPed, with the reason surfaced in the organizer form.

**`capacity` stays field-mutable; the floor is a command rule.** `updateEvent`
locks the event, derives seats taken, and rejects a capacity below it. Field
mutability answers *may this change*; the command answers *is this value legal*.

**One cancel command, two callers.** The participant proves identity with the
emailed token, the organizer with a session. Same domain operation; the actor
stamp records which one it was, and the roster surfaces `added by Daali` for
`AGENT` rows.

## Surfaces

| | |
|---|---|
| `/e/[slug]` | Public page, now with the RSVP form and live seat count |
| `/e/[slug]/rsvp/[token]` | Manage or cancel, no login |
| `/events/[id]/registrations` | Organizer roster with search and seat total |
| `POST /api/events/[id]/registrations` | Public RSVP |
| `POST /api/registrations/[id]/cancel` | Token or organizer |

## Deliberately not here

Volunteers · items · notifications · waitlist · reminders · money · `CANCELLED`
event status · organizer name editing · any LLM call.
