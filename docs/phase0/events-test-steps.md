> **Historical.** Written Sep 10, 2026 for the Phase 0A-0C pages, which the port does not ship (they are rebuilt from Figma in Slices 3-4). Kept for reference; do not run it as an acceptance script.

# `/events` — Post-Deploy Test Steps

**Primary account:** the test account — cash host, `stripe_charges_enabled = false`,
2 board credits, currently blocked at `/host/boards/new`.
**Pass condition:** every step below completes on that account with no Stripe
connection, no credit spent, and no redirect to `/host/stripe`.

Confirmed pre-state, from the browser comparison:

| | Test account | Regular account |
|---|---|---|
| `/host/boards` | loads, optional Stripe banner | loads |
| credits | 2 | 0 |
| `/host/boards/new` | → `/host/stripe` | Game Day / Fundraiser picker |

The test account being *blocked from boards* is what makes it the right
acceptance case. If it can run a full Event, the paths are independent.

---

## Before you start

- [ ] `ACCESS_TOKEN_SECRET` is set in the deployed environment, 32+ random chars
      (0B's only new config). Section D fails confusingly without it — the magic
      link is derived from this secret, so a missing value produces links that
      never validate rather than an obvious error.
- [ ] Migrations `0001_event_foundation`, `0002_registration`, `0003_signups`
      applied to the database the **deployed app** uses. Given the seed-database
      confusion, confirm this against the Supabase project referenced by the
      Vercel env var for the environment serving `beta.daali.app` — not the one
      you happen to have open.
- [ ] **0D.0 integrated and pointed at a real email provider.** 0D.0 is built —
      `NotificationDelivery`, enqueue-inside-transaction, drain-after-commit, one
      RSVP confirmation template — but as of this writing it has not been
      integrated, deployed, or verified against a real provider. Section C-mail
      is **required** for acceptance and cannot be run against a console logger
      or a capture stub: the failures it exists to catch (unroutable sender,
      spam placement, a manage link that breaks in a mobile mail client) only
      appear with real delivery.
- [ ] A real inbox you can read for the RSVP addresses in Section C. Use
      plus-addressing on one real mailbox rather than invented domains, so
      bounces are visible.
- [ ] `./scripts/check-event-isolation.sh` exits 0.
- [ ] Two browsers, or one plus a private window. You need the organizer session
      and a logged-out public visitor at the same time.

Record the slug and any token URLs as you go — later sections need them.

---

## A. Gate independence — the acceptance case

Run this first. If A fails, stop; nothing after it is meaningful.

| # | Action | Expected |
|---|---|---|
| A1 | Log in as the test account. Go directly to `/events`. | Organizer event list renders. No redirect to `/host/stripe`, `/host/payment-setup`, or `/host/boards`. |
| A2 | Note the credit balance on `/host/boards` before continuing. | 2. |
| A3 | `/events/new` → create an event: title, start date/time, timezone. | Event created, status `DRAFT`. |
| A4 | Re-check `/host/boards`. | Still 2 credits. No credit consumed, no `CreditTransaction` row. |
| A5 | Throughout A1–A4, watch the network tab for any 3xx to a `/host/*` path. | None. |

**A6 — the no-host-record case.** Sign up a brand-new account that has never
visited `/host/boards`, and run A3 on it.

Expected: event creates normally, and `SELECT * FROM hosts WHERE supabase_user_id = '<new id>'`
returns **zero rows** afterward. `Event.organizerUserId` is a plain String, not a
Host FK. If a `hosts` row appears, something is calling `getHost()` or an upsert
on the Event path — E2 violation, even if the flow appeared to work.

**A7 — the stripe-incomplete case (T3b).** If you can reach an account with
`payment_preference = 'stripe'` and `stripe_charges_enabled = false`, run A3 on
it. This is a different state from the cash test account and a future change
could break it alone. Skip if no such account exists; note it as untested rather
than assuming it passes.

---

## B. Event lifecycle (0A)

| # | Action | Expected |
|---|---|---|
| B1 | While `DRAFT`, look for a public URL. | No slug exists. `Event.slug` is null. |
| B2 | Guess a plausible `/e/<something>` for it. | Not reachable. `DRAFT` is not publicly visible. |
| B3 | `/events/[id]/edit` — change the title. | Saves. |
| B4 | Publish the event. | Slug assigned, `publishedAt` set, status `PUBLISHED`. |
| B5 | Open `/e/[slug]` logged out. | Public page renders. |
| B6 | Return to `/events/[id]/edit`. | **Slug field disabled**, with the reason shown: the event is live and its link may already have been shared. This is the capability contract being read by a real consumer. |
| B7 | Publish again (re-submit / double-tap). | Same slug returned. No second event, no error. Idempotent replay via `CommandExecution`. |
| B8 | Close the event. | Status `CLOSED`. `/e/[slug]` still renders, showing that registration is closed — the address must keep working on Saturday morning. |

Re-open a fresh `PUBLISHED` event for sections C and D.

---

## C. RSVP and capacity (0B)

Create an event with **capacity 4** for this section.

| # | Action | Expected |
|---|---|---|
| C1 | Logged out at `/e/[slug]`, RSVP as `parent-a@example.com`, party of 2. | Confirmed. Seat count shows 2 of 4. |
| C2 | RSVP as `parent-b@example.com`, party of 3. | **Rejected** — 3 will not fit in the 2 remaining seats. |
| C3 | Confirm the seat count after C2. | Still 2. No partial admission. All-or-nothing. |
| C4 | RSVP as `parent-b@example.com`, party of 2. | Confirmed. 4 of 4. |
| C5 | RSVP as `parent-c@example.com`, party of 1. | Rejected, event full. |
| C6 | RSVP again as `parent-a@example.com`, party of 1. | Treated as a **change of party size**, not a duplicate. Copy reads "Your RSVP has been updated." Seats drop to 3. |
| C7 | Now retry C5. | Confirmed — the freed seat is available. |
| C8 | Re-RSVP as `Parent-A@Example.com ` (mixed case, trailing space). | Resolves to the **same** person. One `EventPerson` row, not two. |

**Identity and naming:**

| # | Action | Expected |
|---|---|---|
| C9 | RSVP as a new email using name "Dee", then re-RSVP with "Daaliyah Coleman". | One row, better name retained. Self-corrections are corrections, not losses. |

**C-mail — RSVP confirmation email (0D.0), required once integrated.**

The manage link is only useful if it arrives. Until this section passes, treat
the token flow as unverified even if C10–C13 pass using a link pulled from the
database.

| # | Action | Expected |
|---|---|---|
| M1 | RSVP as a fresh address. Check the inbox. | Confirmation email arrives. One message, not two. |
| M2 | Check where it landed. | Inbox, not spam. If it lands in spam, that is a **fail** — sender domain, SPF, and DKIM need fixing before an organizer sends this to 100 parents. |
| M3 | Read the sender and subject as a stranger would. | Recognizable as this event, from a sender a parent will not report. |
| M4 | Confirm the body reflects the actual RSVP. | Correct event title, date, and party size. |
| M5 | **Click the manage link from inside the email**, on a phone. | Opens `/e/[slug]/rsvp/[token]`, logged out, working. This is the step that catches a link mangled by URL-wrapping or line-wrapped in the plaintext part — neither is visible when you paste a token by hand. |
| M6 | Cancel from that emailed link. | Cancels. Seats freed, same as C11. |
| M7 | Re-RSVP with the same address (party-size change, as in C6). | Behaves per 0D.0's template rules. Record what arrives — a second confirmation, an update, or nothing. Whatever it is, it must not read as a duplicate registration. |
| M8 | Submit an RSVP that is **rejected** for capacity (as in C2). | **No email.** Nothing was registered, so nothing may confirm. Enqueue happens inside the transaction, so a rolled-back RSVP leaves no `NotificationDelivery` row — verify the table, not just the inbox. |
| M9 | While RSVPing, watch the response time and result. | Confirmation returns normally. Delivery drains after commit and must never block, delay, or roll back the registration. If the provider is slow and the RSVP is slow with it, the drain is inside the transaction and that is a defect. |

**Token self-service:**

| # | Action | Expected |
|---|---|---|
| C10 | Open the manage link `/e/[slug]/rsvp/[token]` from C1, logged out. | Loads with no login. |
| C11 | Cancel from that page. | Cancelled. Seats freed. |
| C12 | RSVP again with the same email after cancelling. | Allowed. The live-registration index is partial — `WHERE status = 'CONFIRMED'` — so it constrains live rows only. |
| C13 | Alter one character of the token in the URL. | Rejected. |

**Organizer roster:**

| # | Action | Expected |
|---|---|---|
| C14 | `/events/[id]/registrations`. | All registrations, searchable, with a seat total matching the public count. |
| C15 | Cancel a registration as organizer. | Cancelled. `RegistrationLog` records `ORGANIZER_REMOVED` with the actor stamp. |
| C16 | Query `RegistrationLog` for the C6 change. | `PARTY_SIZE_CHANGED` with `fromPartySize` 2 and `toPartySize` 1. "Who changed this RSVP?" is answerable. |

**Field mutability under load:**

| # | Action | Expected |
|---|---|---|
| C17 | With registrations present, try to change the event **timezone**. | Blocked, reason surfaced in the form. |
| C18 | Try to set capacity **below** current seats taken. | Rejected at the command layer, with a message naming the floor. Field mutability says *may this change*; the command says *is this value legal*. |
| C19 | Raise capacity above seats taken. | Allowed. |

---

## D. Volunteers and items (0C)

This section carries the sharpest regression risk, because the donor-eligibility
gate was **removed by decision** in 0C. If anything reintroduces "must RSVP
first," it reintroduces the shape of the donor gate under a different name.

Set up at `/events/[id]/signups`: one SHIFT slot "Gate" with capacity 3, one
ITEM slot "Cases of water" with capacity 6.

| # | Action | Expected |
|---|---|---|
| D1 | **Logged out, having never RSVPed**, claim a Gate position at `/e/[slug]`. | **Succeeds.** No session, no RSVP required. This is the headline test of the section. |
| D2 | Claim 2 cases of water as another never-RSVPed email. | Succeeds. Quantity is 2. |
| D3 | Same person claims 1 more case. | **One** commitment row, quantity now 3 — derived from position count, not a stored column. |
| D4 | Fill the Gate slot to 3, then attempt a 4th. | Rejected as full, with copy stating the slot is full. |
| D5 | Claim 4 cases when only 2 remain. | Rejected. Never silently partial. |
| D6 | Cancel one Gate claim, then claim again. | Succeeds — the freed position is reclaimable. Positions are seats, not credentials. |
| D7 | Close a slot from `/events/[id]/signups`, then try to claim it publicly. | Rejected. |
| D8 | Cancel via the emailed token link, logged out. | Succeeds. |
| D9 | Cancel a signup as organizer. | Succeeds. `SignupLog` carries the actor stamp. |
| D10 | `/events/[id]/signups` roster per slot. | Names and quantities correct, matching D1–D3. |

**Contention wording** — worth a deliberate look, because 0C found a real defect
here. Have several people claim the last positions simultaneously (D4/D5 area).
A rejected claimant should see *"Several people signed up at once. Try again."*
when the cause was contention, and a *slot is full* message when the slot is
genuinely full. These are different facts and a helper deserves to know which one
happened. If contention shows "full," the terminal condition has regressed to
counting attempts instead of taking a fresh read.

---

## E. Isolation re-check

Run after everything above, because the point is that a full Event lifecycle
changed nothing on the Board path.

| # | Action | Expected |
|---|---|---|
| E1 | `/host/boards` as the test account. | Still 2 credits. Still the optional Stripe banner. |
| E2 | `SELECT * FROM "CreditTransaction"` filtered to this host. | No rows from this session. |
| E3 | `/host/boards/new` as the test account. | Still redirects to `/host/stripe`. |

**E3 is expected to fail-as-before, and that is the correct outcome.** The Board
gate regression is out of scope here and stays broken until its own ticket. If
E3 suddenly passes, this work touched the Board path and needs review — that is
a scope violation, not a bonus.

---

## F. Known gaps, to note rather than test

- **`CANCELLED` does not exist.** An organizer who needs to say "this will not
  happen" can only close, which says "registration is over." Different sentence,
  different intent. Deliberate for slice 1.
- **Notification retry.** 0D.0 has no lease and no cron — those are 0D.1. A send
  that fails is not automatically retried, so a transient provider outage during
  the acceptance run drops that confirmation permanently. Note any failure
  rather than re-running the RSVP to "fix" it; the dropped row is the evidence
  0D.1 needs.
- **Household email.** Two parents sharing one address collapse to one
  `EventPerson` by design. Correct for slice 1; a real question once tickets are
  individually named.
- **Per-event RSVP serialization.** Capacity takes a row lock on the Event.
  Free at 100 people. Not free at a ticket on-sale with thousands of simultaneous
  buyers. Revisit there, with load evidence.
- **No organizer name editing.** `resolveEventPerson` overwrites names, which is
  safe only while no organizer-facing name edit exists. That surface ships with
  `nameSetByOrganizerAt` in the same change, never before.

---

## Sign-off

Section A is the gate. B through D are the feature. E proves nothing leaked.

- [ ] A1–A7 pass — the blocked cash host runs a full Event
- [ ] B1–B8 pass — lifecycle and the immutable slug
- [ ] C1–C19 pass — capacity, identity, audit, mutability
- [ ] M1–M9 pass against a **real** email provider — confirmation delivered to
      the inbox, manage link clicked from the message on a phone
- [ ] D1–D10 pass, **D1 especially** — no RSVP required to volunteer
- [ ] E1–E3 as expected, including E3 still failing
- [ ] `check-event-isolation.sh` exits 0 in CI, not just locally
