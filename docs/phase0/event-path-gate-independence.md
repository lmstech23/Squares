> **Current.** A governing spec for the Event path, listed in AUTHORITY.md. Moved here from the Sep 10 build unchanged below this line.

# Event Path — Gate Independence Spec

**Status:** Proposed. No code written. No permissions changed.
**Depends on:** Phase 0A (Event foundation), 0B (RSVP), 0C (sign-ups)
**Companion:** `SYSTEM-FLOW.md` (Game Day authority), `daali-phase-0a-0d-plan.md`

Per SYSTEM-FLOW Rule 7 and STATUS Rule 2, this document lands before any code.

---

## 1. The requirement

A user creating a free Event + RSVP + Volunteer experience must reach a
published event and a working public page **without** a Stripe account, a
`paymentPreference` value, a board credit, or any fundraiser entitlement.

Restated as a test: a brand-new signup whose `hosts` row does not exist at all
must be able to complete the entire Event flow.

---

## 2. What is already independent

The Phase 0 domain needs no changes. This is worth stating precisely so nobody
"fixes" it.

| Property | Evidence |
|---|---|
| `Event` has no board linkage | Plan §2: "**`Event` has no `boardId`.** This is the clean break." |
| `Event` has no host linkage | Owner is `organizerUserId` (String), not a `Host` FK |
| No money concept anywhere in 0A–0C | Stripe appears once across all three phases, in 0A–0D "deliberately not here" |
| Volunteering does not depend on payment | 0C removed donor eligibility outright: "a person does not have to RSVP to volunteer or bring an item" |
| RSVP does not depend on payment | 0B capacity is derived from `SUM(partySize)` over CONFIRMED rows. No payment state participates |

**The domain layer is not the problem and must not be touched by this work.**
`src/domain/` imports nothing from Prisma, Next, or the session, and that
boundary is load-bearing for Phase 2.

---

## 3. Where independence can actually be lost

Three places, all above the domain.

### 3.1 The auth integration point — the primary risk

`src/lib/currentOrganizer.ts` is, per README-0A, the only integration point in
0A. It throws until pointed at the Supabase session lookup.

The failure mode is a one-line implementation:

```ts
// WRONG — inherits the entire Board gate chain
export async function currentOrganizer() {
  return await getHost()   // redirects on paymentPreference / Stripe state
}
```

`getHost()` (or any wrapper around the `/host/boards` guard) carries gates 1
through 4 with it. Every Event route silently acquires four Stripe redirects
that nobody wrote and nobody will find by reading the Event code.

**Rule E1 — `currentOrganizer()` resolves identity and nothing else.** It
returns a `userId` from the Supabase session, or null. It performs no database
read of `hosts`, no redirect, and no policy evaluation. Identity and eligibility
are separate concerns and this function owns only the first.

**Rule E2 — no file under `src/app/events/`, `src/app/e/`,
`src/app/api/events/`, `src/app/api/registrations/`, `src/app/api/slots/`, or
`src/app/api/signups/` may import `getHost`, read the `hosts` table, or
reference `paymentPreference`, `boardCredits`, `stripeAccountId`,
`stripeChargesEnabled`, or `stripePayoutsEnabled`.**

E2 is mechanically checkable. See §6.

### 3.2 Layout and middleware inheritance

A guard in a shared `layout.tsx` or in `middleware.ts` matching a broad path
pattern applies to routes that never opted in. This is the version of the bug
that survives a careful code review of the Event files themselves, because the
gate is not in any of them.

**Rule E3 — the Event routes do not sit under any layout that performs a
payment, credit, or Stripe check, and no middleware matcher covers them.**
If `/events` currently renders inside a host layout, it moves. Verify the
matcher config explicitly rather than reasoning about which paths it "should"
match.

### 3.3 Entry points — the reachability trap

This one is not a code-correctness issue and is easy to miss.

A perfectly clean `/events` stack is still unreachable if the only link to it
lives on `/host/boards`. A Stripe-blocked host is redirected away from that
dashboard before they can click anything on it. The path would be independent
in code and unusable in practice.

**Rule E4 — Event creation has an entry point that does not pass through
`/host/boards`.** At minimum: `/events` is directly addressable and is the
post-login destination for a user with no boards. A link from the host
dashboard is additive, never the only route in.

---

## 4. Organizer eligibility — the whole policy

```
A signed-in Supabase user may create an Event.
```

That is the complete rule. No Host record required, no `paymentPreference`
required, no credit consumed, no Stripe state consulted.

**A `hosts` row is not a prerequisite.** `Event.organizerUserId` is a String
holding the Supabase user id — not a foreign key into `hosts`. A user who signs
up and goes straight to events never creates a Host row, and nothing should
create one on their behalf. If a later capability needs the join, it adds it
then, with a migration and a reason.

**Free events consume no credits and create no `CreditTransaction`.** The credit
system is scoped to `boards` and stays there. Do not add an event-credit concept
in this work — an unused counter is a column that records nothing.

### Authorization inside commands

The plan's §1 already specifies this shape and it does not change:

- `createEvent`, `updateEvent`, `publishEvent`, `closeEvent` — organizer only,
  authorized by `actor.userId` matching `Event.organizerUserId`.
- RSVP, slot claim, and cancellation are public or token-authorized. 0B and 0C
  are explicit that `POST /api/slots/[id]/claim` takes no session and requires
  no RSVP.

Authorization asks *is this actor the owner of this event*. It never asks *has
this actor paid for anything*.

---

## 5. Changes required

Deliberately small. Most of the work is verification, not construction.

| # | Change | File |
|---|---|---|
| C1 | Implement `currentOrganizer()` as session-identity-only, per E1 | `src/lib/currentOrganizer.ts` |
| C2 | Confirm no Event route inherits a host layout; relocate if it does | route tree |
| C3 | Confirm no middleware matcher covers Event paths | `middleware.ts` |
| C4 | Post-login destination for a user with no boards → `/events` | login redirect |
| C5 | "New Event" link on `/host/boards`, additive only | `src/app/host/boards/page.tsx` |
| C6 | Add the §6 guard test to CI | test suite |

C5 is the only edit to an existing Board file, and it adds a link. It changes no
condition. Given the Feb 26 incident recorded in `squares-fix-log-v2.docx`, it
is a surgical edit — one insertion, verified output, no file rewrite.

### SYSTEM-FLOW

SYSTEM-FLOW is the Game Day authority and describes Board flows. Following the
precedent already set in `fundraiser-board-v2.md` §17 — where fundraiser work
became its own flow authority rather than backfilling SYSTEM-FLOW — **this
document is the flow authority for the Event path.**

SYSTEM-FLOW gets one edit: a pointer in the Quick Summary noting that Events are
a separate path documented here, gated only by session. Anyone following the
check-before-pushing rule who looks only at SYSTEM-FLOW finds a map without this
territory otherwise.

Cite the two rules by name — the document-first rule and the
check-before-pushing rule — never by number. SYSTEM-FLOW has gained rules over
time and numbered citations are stale by construction.

---

## 6. Acceptance tests

**T1 — no host record.** A Supabase user with no `hosts` row creates, publishes,
and closes an event. Public page renders. No `hosts` row is created at any point.

**T2 — null preference.** `paymentPreference IS NULL`. Full Event flow
completes. No redirect to `/host/payment-setup` occurs on any Event route.

**T3 — the exact failing case.** A host with `paymentPreference = 'stripe'`,
`stripe_charges_enabled = false`, `stripeAccountId` null. Full Event flow
completes with no redirect to `/host/stripe`. *This is the test account. It is
the reason this document exists.*

**T4 — zero credits.** `boardCredits = 0`. Event creation succeeds, consumes no
credit, and creates no `CreditTransaction` row.

**T5 — public surfaces.** RSVP at `/e/[slug]` and slot claim at
`/api/slots/[id]/claim` succeed with no session and no payment state, for an
organizer in the T3 state.

**T6 — reachability.** From a clean login in the T3 state, Event creation is
reachable by navigation without manually typing a URL. Guards against §3.3.

**T7 — static guard.** Grep the Event route tree for `getHost`, `paymentPreference`,
`boardCredits`, `stripeAccountId`, `stripeChargesEnabled`, `stripePayoutsEnabled`,
and `prisma.host`. Zero hits. Run in CI so E2 survives future work — this is the
rule most likely to be broken accidentally six months from now by someone adding
a feature in good faith.

T3 and T7 are the two that matter. T3 proves the bug is fixed; T7 proves it
stays fixed.

---

## 7. Explicitly out of scope

Changing any Board or Fundraiser gate · diagnosing which gate the test account
hits (separate, and a prerequisite) · paid events · ticketing · the credit
system · Stripe · `CANCELLED` status · notifications · any LLM call.

**This document does not remove a single Stripe check from the Board path.** If
gate #4 turns out to be the unconditional `!host.stripeChargesEnabled` version
from the older bundle rather than the `paymentPreference`-conditional version
described in SYSTEM-FLOW §3C, that is a live regression against Rule 1 (Stripe
is optional) and Rule 5 (board creation is never blocked). It is a real bug and
it is a **separate change** with its own document. Bundling it here would put a
money-path edit inside an additive feature, which is the shape of the Feb 26
incident.

---

*End of spec.*
