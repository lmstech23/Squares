# Phase 0D.0 — Notification delivery (minimal)

Scope: `NotificationDelivery`, enqueue inside the RSVP transaction, send after
commit, one provider adapter, one confirmation template, visible status, manual
resend. **No lease, no fencing token, no cron, no backoff, no campaign messaging.**

## Install

1. Append `prisma/schema.additions.0d.prisma`; add the two back-relations at the
   bottom of that file.
2. Copy `prisma/migrations/0004_notifications/`, then migrate.
3. Copy `src/`.
4. **Env:** `RESEND_API_KEY`, `EMAIL_FROM`, `APP_URL`. With no `RESEND_API_KEY`
   the console provider runs, which prints the message and marks it `sent` — the
   full pipeline works in dev with zero configuration.

`APP_URL` must be an absolute origin (`https://daali.app`, `http://localhost:3000`).
It is validated before any send: a missing or malformed value settles the delivery
`failed` with the reason and mails nothing. See below.

## The invariant, proved against real Postgres 16

```
A failed email must never roll back or invalidate the RSVP
  PASS  RSVP is still CONFIRMED after a failed send — status=CONFIRMED
  PASS  party size untouched
  PASS  delivery is visibly failed with the error
  PASS  the failure is countable — attempts=1

Total provider outage across many RSVPs
  PASS  all 10 RSVPs survive a dead mail provider — 10/10

Manual resend after a failure
  PASS  delivery reaches sent
  PASS  error is cleared on success
  PASS  both attempts counted — attempts=2

The dedupe key names the thing being communicated
  PASS  a second registration gets its own delivery
  PASS  re-enqueue of the same registration is a no-op

Enqueue is a local insert inside the RSVP transaction
  PASS  a failed enqueue rolls back with the RSVP — no unconfirmable registration
```

```bash
node tests/notification.mjs        # 11 assertions
npm run test                       # 34 unit tests, no database
```

The invariant is **structural, not intentional**. Three independent reasons it
cannot break:

1. `deliverNotification` runs after the RSVP transaction has committed. It is
   never called from inside `runCommand`.
2. It never throws. Every path returns; the catch-all marks the row `failed`.
3. It writes only to `NotificationDelivery`. It cannot reach `Registration`.

## Enqueue joins the transaction; the send never does

Inserting the delivery row is a local write with no network call, so it costs
nothing and closes the window where an RSVP commits with nothing queued behind it.
The last test above proves the other direction too: a failed enqueue rolls the
RSVP back rather than leaving a registration nobody can ever confirm.

## The dedupe key

```
RSVP_CONFIRMED → registration:{registrationId}
```

Registration-scoped, not person-scoped. **The key names the thing being
communicated.** A confirmation belongs to a registration the way a receipt belongs
to a purchase — someone who RSVPs, cancels, and RSVPs again deserves the second
confirmation, and a person-scoped key would silently suppress it because the row
would already read `sent`.

A party-size **change** enqueues nothing. It is not a new confirmation.

## Awaited, not fire-and-forget

The route awaits `deliverNotification` with a 4s abort timeout. On Vercel, work
started after the response is not guaranteed to run, so fire-and-forget would
silently drop mail in production. A timeout leaves the row `pending` and the
organizer resends. On Next 15 this is a good candidate for `after()` instead.

## Recovery in 0D.0 is a human

`pending` and `failed` render on the organizer roster with the provider error in
the tooltip, next to a **Resend** button. That is the entire recovery story, and
it is bounded and honest: nothing disappears silently, and a supporter who never
got her confirmation is a fact the organizer can see.

0D.1 replaces the button with the lease, the fencing token, and the cron. Its
three columns are nullable and additive.

## A message that cannot be built correctly is never sent

`buildEmail` returns a reason rather than a bare null, and `deliverNotification`
settles the delivery `failed` with that exact string. The organizer sees it in the
roster tooltip.

| Condition | `lastError` |
|---|---|
| `APP_URL` unset or blank | `APP_URL is not set` |
| `APP_URL` has no scheme, e.g. `daali.app` | `APP_URL is not a valid URL: daali.app` |
| `APP_URL` is `ftp://…` | `APP_URL must be http or https, got ftp:` |
| Event was never published | `Event has no public link yet.` |
| RSVP cancelled before the send | `Registration is no longer confirmed.` |

**Why this is worth a guard rather than a fallback.** An unset `APP_URL` used to
fall back to `''`, which shipped every manage link as a relative path — dead in an
email client. It never errored. The guest got mail that did not work and nobody
found out. A visible failure is strictly better than a silent broken send.

`resolveAppUrl` also normalizes away a trailing slash and any path, so callers can
concatenate safely. Attempts are **not** incremented for a build failure: a
misconfigured origin was never a send.

## The token is derived at send time

`buildEmail` derives the manage link from `eventPersonId` when it builds the
message. That is why the token never had to be carried through a command result
or stored on the delivery row — the HMAC design from 0B pays for itself here.

## Provider

`EmailProvider` is a two-method interface. `resend.ts` is the one implementation,
`console.ts` is the dev default, and `providers/index.ts` is the only file that
chooses. The provider idempotency key is `{notificationType}:{dedupeKey}` —
**stable across attempts, never including the attempt number**, because the case
it protects is a send that timed out but actually delivered.

## Approved deviation to carry into the Phase 0 notes

From 0C, and worth restating because it corrects an approved spec:

> **Do not terminate slot claiming based solely on retry count.** Terminal "full"
> requires a fresh capacity read proving insufficient remaining positions. Retry
> exhaustion is a distinct contention outcome.

`SLOT_FULL` is a business-state answer. `CONTENTION` is a concurrency answer. They
must never be conflated.
