# Fundraiser Sign-Up Sheets — Addendum

**Status:** Approved for implementation
**Version:** 1.6 — S0 corrected against production reality. Application-level rename, no physical migration
**Companion to:** `fundraiser-money-state-machine.md` (authority on money) · `fundraiser-board-v2.md` (authority on flows) · `fundraiser-admission-addendum.md` (authority on admission)

Adds organizer-created sign-up sheets — shifts and item commitments — to fundraiser events. Contains a required rename of the existing gate role, which must land before A10 is implemented.

---

## Rule of this document

Adds **helper sign-ups** to fundraiser events. Does not change how money works, and does not change how admission works.

This document adds invariants 34–47 and amends invariant 32. If it disagrees with the money doc, the money doc wins and this document is wrong. If it disagrees with the admission addendum on passes, the admission addendum wins.

---

## 1. The rule

```
1 confirmed contribution  =  eligibility to claim slots
```

Sign-up is a **post-contribution experience for supporters**, not a standalone volunteer tool. The only way to help is to give first.

That single decision is what keeps this from becoming a second product. Daali is not competing with SignUpGenius for church potlucks. It is doing one thing SignUpGenius does not do: **turning confirmed financial supporters into the people who deliver the event**, in the same session, without a second tool and a second link.

**On the competitive claim.** SignUpGenius could add payments tomorrow. The unified roster is a wedge, not a moat. What is defensible is that the whole workflow — contribute, get in, help — is one flow for one kind of event, rather than three products bolted together.

### Eligibility is derived, never stored

```
eligible  ⟺  EventSupporter.status = active
```

The status latch already exists and already flips in the confirmation transaction, for card and cash alike (admission addendum §5, invariant 31). No eligibility column. No flag that can drift out of sync with the money.

This also means a supporter who donated their admissions is still eligible. They aren't attending, but they may still drop supplies. See §12.

---

## 2. Vocabulary, and a rename

| Concept | Product term | Internal term |
|---|---|---|
| Organizer-created collection | Sign-Up Sheet | `SignupSheet` |
| A work period or a needed item | Slot | `SignupSlot` |
| A supporter's claim on a slot | Helper | `HelperSignup` |
| Authority to scan at the gate | Check-in Staff | `CheckinStaffAccess` |
| Entitlement to enter | Pass | `AdmissionPass` |

### Why the gate role is being renamed

Two things were both called "volunteer" and they are close to opposites. The person bringing water is a volunteer. The person authorized to scan admissions is **staff** — that is a permission, not a contribution.

**Correction, v1.6.** Versions 1.0–1.5 asserted that nothing had been written to these tables yet and that S0 was therefore a free physical rename. **That premise was false.** Production holds issued access records and check-in logs referencing them. S0 is still worth doing — sign-up work is about to double the surface using this name — but it is now an application-level rename with no physical migration.

### S0 is a Prisma mapping, not a database migration

**No physical table, column, or row changes.** A physical rename is not safe here, and "ship schema and code in the same commit" is not a fix: a rolling deploy leaves old instances querying objects that no longer exist, and the failure surfaces at the gate, at an event, in front of a line.

Rename the Prisma model, relations, fields, TypeScript symbols, filenames, and copy. Pin every one to its existing physical identifier.

```prisma
model CheckinStaffAccess {
  // application-level names only
  @@map("volunteer_access")
}

// AdmissionPass
checkedInByCheckinStaffId String? @map("checked_in_by_volunteer_access_id")

// CheckInLog
byCheckinStaffId String? @map("by_volunteer_access_id")
```

| Layer | Old | New |
|---|---|---|
| Prisma model | `VolunteerAccess` | `CheckinStaffAccess`, mapped to `volunteer_access` |
| Field | `AdmissionPass.checkedInByVolunteerAccessId` | `checkedInByCheckinStaffId`, mapped |
| Field | `CheckInLog.byVolunteerAccessId` | `byCheckinStaffId`, mapped |
| File | `src/lib/volunteer-access.ts` | `src/lib/check-in-staff.ts` |
| Host API route | `/api/host/boards/[id]/volunteer-access` | `/check-in-staff`, **old path retained as an alias** |
| Host copy | "Volunteer links" | "Check-in staff links" |
| Doc language | "Volunteer surface" (`fundraiser-board-v2.md` §6B) | "Check-in surface" |

**Route `/gate/[token]` does not change.** "Gate" is the place, not the role, and it is already correct. No issued check-in link breaks, because no token and no URL a host has ever received is altered.

**The host API alias is temporary and needs a removal ticket.** A dashboard loaded before the deploy will still call `/volunteer-access` afterward. Both paths call one shared implementation; the old one is deleted in a later release. An alias with no removal ticket is permanent.

### What this costs

`schema.prisma` will say `CheckinStaffAccess` while psql says `volunteer_access`. The naming divergence S0 exists to eliminate now lives at the map boundary instead — narrowed to one file, but real.

That is the right trade against a deploy window that breaks the gate, and it buys something a physical rename would have cost: any raw SQL or Supabase RPC still referencing `volunteer_access` keeps working untouched.

**Open a follow-up ticket for the physical rename.** It happens in a planned window with no event nearby, or it is consciously never done. Either is fine. Drifting into it by accident is not.

**Invariant 32 is amended** to read: *Check-in staff consume entitlement and never create it. No check-in action increases the number of passes on an event.* The rule is unchanged; only the noun moves.

**User-facing copy may still say "Volunteer Sign-Up."** That is what a parent understands. The code does not have to call every person a volunteer to be readable by a human.

---

## 3. Schema

```
Event ──optional──▶ SignupSheet ──▶ SignupSlot × N
                                        │
                    EventSupporter ──▶ HelperSignup
```

No sign-up column lands on `Board`, `Square`, `AdmissionGrant`, or `AdmissionPass`.

**No sign-up or token record is written inside the confirmation transaction.** The one exception is the `NotificationDelivery` row, which may be enqueued there because it is a local insert — see §5b. No provider call of any kind happens inside that transaction.

### SignupSheet

| Field | Type | Notes |
|---|---|---|
| `id`, `eventId` | | `eventId` unique — one sheet per event |
| `title` | String? | Defaults to "Volunteer Sign-Up" |
| `instructions` | String? | Two lines at most, host-written |
| `isOpen` | Boolean | Default true. Host closes sign-ups independently of board close |

### SignupSlot

| Field | Type | Notes |
|---|---|---|
| `id`, `sheetId` | | |
| `slotType` | enum | `SHIFT` · `ITEM` |
| `name` | String | "Main gate", "Cases of water" |
| `startsAt`, `endsAt` | DateTime? | `SHIFT` only. Null on `ITEM` |
| `capacity` | Int | Number of claimable positions. Minimum 1 |
| `unitLabel` | String? | `ITEM` only. "case of water", "dozen cookies" |
| `notes` | String? | "Meet at the north tent" |
| `sortOrder` | Int | Host-ordered. Not derived from time |

**One table for both kinds.** A shift and an item are the same shape: a named thing with N openings. `capacity` carries both — six people on the gate and six cases of water are both `capacity = 6`. A second table would duplicate every claim, cancel, and concurrency path for no gain.

### HelperSignup

One commitment per supporter per slot. This is the row a human thinks about.

| Field | Type | Notes |
|---|---|---|
| `id`, `slotId`, `eventSupporterId` | | **Unique together.** `(id, slotId)` also unique — see below |
| `note` | String? | Supporter's own note. "Bringing a wagon" |
| `createdAt` | DateTime | |

**There is no `quantity` column.** Quantity is `count(HelperSignupPosition)` on the commitment. Storing it would state the same fact twice, and the drift case is real: a partial failure leaves `quantity = 4` against three positions, and now the host's roster and the slot's remaining count disagree with each other. A stored quantity is the mutable counter this document spent §6 refusing to have.

The API still accepts `quantity: 4` as input. The database just doesn't keep a second copy of the answer.

### HelperSignupPosition

One row per claimed capacity position. This is the row the database thinks about.

| Field | Type | Notes |
|---|---|---|
| `id`, `helperSignupId` | | |
| `slotId` | String | **Denormalized on purpose.** The uniqueness rule has to live on one table |
| `position` | Int | 1…`capacity`. **Unique with `slotId`** |

**The denormalized `slotId` needs a composite foreign key, not a plain one.** Two independent FKs would let a coding error attach positions from the setup shift to Daaliyah's water commitment — the capacity index would still be satisfied, and the roster would be quietly wrong.

```
HelperSignup            unique (id, slotId)

HelperSignupPosition
  (helperSignupId, slotId) references HelperSignup (id, slotId)
  ON DELETE CASCADE
```

The parent's `(id, slotId)` unique index exists only to be the target of that reference. It costs nothing and it is what makes the denormalized column structurally trustworthy rather than trustworthy by convention. Prisma expresses this with a compound `@relation` against a `@@unique([id, slotId])` on the parent.

**Why two tables.** An earlier draft put `position` directly on `HelperSignup` and tried to keep one-per-person-per-shift with a partial unique index conditioned on `slot.slotType`. **Postgres cannot do that** — a partial index predicate can only reference columns on its own table, and `slotType` lives on `SignupSlot`. That draft would not have migrated.

Splitting commitment from position fixes it without a trick. "Daaliyah is bringing four cases of water" is one `HelperSignup` with four `HelperSignupPosition` rows. Both uniqueness rules are single-table, and cancellation is one delete that cascades.

### SignupLog

| Field | Type | Notes |
|---|---|---|
| `id`, `slotId`, `eventSupporterId` | | |
| `action` | enum | `CLAIMED` · `CANCELLED` · `HOST_REMOVED` |
| `actorType` | enum | `SUPPORTER` · `HOST` |
| `createdAt` | DateTime | |

A helper cancelling at 6am the day of an event is exactly the thing a host will want to see and the thing nobody will remember. The log is small and it is the difference between "nobody showed up" and "three people cancelled overnight."

### AttendanceAccessToken → SupporterAccessToken

The admission addendum left `AttendanceAccessToken` in place as *"the right table if a self-service path ever returns."* It has returned. The emailed sign-up link is exactly a supporter-scoped, opaque, revocable token.

Rename it, rescope it to `eventSupporterId`, and use it here. Do not create a second token table.

### Constraints

```
SignupSheet.eventId                              unique
HelperSignup (slotId, eventSupporterId)          unique
HelperSignup (id, slotId)                        unique   — FK target only
HelperSignupPosition (slotId, position)          unique
HelperSignupPosition (helperSignupId, slotId) → HelperSignup (id, slotId)  cascade
SupporterAccessToken.tokenHash                   unique
```

The second gives one commitment per person per slot. The third is what makes capacity safe under concurrency. Both are plain single-table unique indexes.

**A `SHIFT` commitment is valid only with exactly one position, and that is enforced in code.** A check constraint would need to read `slot.slotType` and hits the same cross-table limit as the original partial index did. `src/lib/signups.ts` is the sole owner of claims (§14) and the only place that can enforce it. Nothing else may insert a `HelperSignup` or a `HelperSignupPosition`.

**`Event.boardId` stays required and unique.** No migration. There is no standalone sheet (invariant 43). If standalone ever ships it is a deliberate schema decision made then, with a real onboarding flow behind it, not an accident preserved now.

---

## 4. The checkbox

One line at checkout, below the donate checkbox:

```
[ ] I'd like to help with the event
```

**It records intent and nothing else.** It does not claim a slot, reserve a slot, hold a slot, or guarantee one will be available. A supporter who checks it and takes forty minutes to open the email may find the gate shift gone. That is correct and it is the only behavior that survives contact with a shared sheet.

Stored as `AdmissionGrant.wantsToHelp`, default false, alongside `donateAdmissions`.

**Intent is a one-way OR across grants, never a revoke.** A supporter who checks it on their first purchase and leaves it unchecked on the second is still interested. This mirrors the supporter status latch. Interest is `EXISTS (grant WHERE wantsToHelp)` — a derived read, not a column on the supporter.

---

## 5. The handoff

Access follows confirmation, not intent. The two payment paths reach the same place by different routes because their timing is different.

### Card

```
select squares → check the box → Stripe → webhook confirms
    → return page already polls for paid (STATUS.md)
    → poll sees paid → issue token → automatic redirect
```

```
Payment received!
Taking you to the Volunteer Sign-Up…
```

**The redirect is driven by the poll, not by the return.** The existing post-checkout page already carries the session and already polls every 2s while squares are pending. Redirecting on arrival would race the webhook and land the supporter on a sheet they aren't eligible for yet. Redirecting on the tick that sees `paid` gets the same experience with none of the race — a supporter who checked the box does not tap anything.

Server-side, that tick calls `getOrCreateSupporterAccessToken(supporterId)` and returns its URL. The token is minted at confirmation, never before, so the redirect target cannot exist for an unconfirmed contribution.

**One idempotent owner for tokens.** The return-page poll and the confirmation email both need a link, and they can fire within milliseconds of each other. `getOrCreateSupporterAccessToken()` is the only function that issues one, and it returns the existing live token when there is one. Two callers must never produce two competing links to the same supporter — the parent who clicks the older one out of her inbox at 6am has to land somewhere that works.

### Fallbacks

An earlier version of this table was wrong in two ways: it offered a CTA to supporters who weren't yet eligible for it to work, and it offered a CTA into a sheet with nothing left in it. **The CTA is reserved for one case — a confirmed supporter whose automatic redirect failed.** Everything else is a message.

| Condition | What the page shows |
|---|---|
| Confirmation exceeds 20s | "Payment is still confirming. We'll email your volunteer sign-up link." Polling continues in the background |
| Sheet is closed | "Volunteer sign-up is currently closed." No CTA |
| Every slot is full | "Thank you! All volunteer opportunities are currently filled." No CTA |
| Other squares still pending | Finish resolving the purchase, then redirect automatically if anything is still open |
| Token issuance or redirect fails after confirmation | The "Help with the event" CTA. This is the only case it appears |

The 20s message is a promise, so the email path must not depend on the browser still being open. It doesn't — the email is sent from the webhook, not the page, and carries the same token for everyone who checked the box. §5b is what makes that promise keepable, and it ships first (§13).

### Cash and direct payment

There is no browser to redirect. The host confirms receipt hours later, possibly at the gate.

```
reserve squares → check the box → pay the organizer directly
    → reservation stays unconfirmed, no access
    → host taps Confirm Cash → supporter goes active
    → email with SupporterAccessToken link
```

**A `reserved_cash` square grants nothing** (invariant 37). This is the same rule the passes already follow, and it has to be the same rule here or the sheet fills with people who never paid.

---

## 5b. Delivery

**There is no existing transactional email pipeline to reuse.** Check before accepting that sentence — but as of this writing, `STATUS.md`'s shipped list contains no outbound email, and `fundraiser-board-v2.md` build order still carries "email notifications" as an unbuilt step. Supabase sends host auth OTPs; that is auth infrastructure, not a transactional sender.

So S4 is not "add a link to the existing email." **S4 builds the pipeline**, and the fundraiser confirmation email specified in `fundraiser-board-v2.md` §12 should be built in the same step against the same table. Do not build a second, sign-up-only email path — one sender, one delivery record, two message types.

### NotificationDelivery

| Field | Type | Notes |
|---|---|---|
| `id` | | |
| `notificationType` | enum | `CONTRIBUTION_CONFIRMED` · `SIGNUP_LINK` |
| `dedupeKey` | String | **Unique with `notificationType`.** Scope varies by type — see below |
| `eventSupporterId` | String | For querying and the host panel. **Not part of any uniqueness rule** |
| `status` | enum | `pending` · `sent` · `failed` |
| `attempts` | Int | Default 0. Incremented when an attempt *begins* |
| `lockedAt` | DateTime? | Lease held by a worker. Null when unclaimed |
| `lockToken` | String? | **Fencing token.** New UUID on every claim. Null when unclaimed |
| `nextAttemptAt` | DateTime | Default now. Backoff target |
| `providerMessageId` | String? | |
| `lastError` | String? | |
| `sentAt` | DateTime? | |

```
NotificationDelivery (notificationType, dedupeKey)   unique
```

### The dedupe key is per-thing-being-communicated, not per-supporter

| Type | Key | Scope |
|---|---|---|
| `SIGNUP_LINK` | `supporter:{eventSupporterId}` | One per supporter, ever |
| `CONTRIBUTION_CONFIRMED` | `grant:{admissionGrantId}` | One per contribution |

An earlier draft made the key `(eventSupporterId, notificationType)` for both. That is right for the sign-up link — the token is supporter-scoped and reusable, so a second contribution should not mail a second copy of a link she already has. **It is wrong for confirmations.** A parent who buys four squares in September and two more in October deserves two receipts, and the supporter-scoped key would silently suppress the second one. The row already exists and reads `sent`, so nothing would ever look further.

The rule to hold onto: the key names the thing being communicated. A link belongs to a person. A receipt belongs to a purchase.

(A supporter who leaves the help box unchecked on her first contribution and checks it on her second has no `SIGNUP_LINK` row yet, so it enqueues then. The supporter-scoped key handles that correctly.)

### Why status, and not just existence

The SMS spec's pattern is an atomic lock written before the Twilio call — the row's existence *is* the guard, and the send is fire-and-forget. That is right for winner SMS, because a lost message has a human retry path: the host taps the button again.

**The sign-up link has no such path.** A supporter whose email silently failed is simply never told, and neither is the host. Existence alone would also strand her permanently: a worker that dies between inserting the row and settling it leaves `pending` forever, and every future attempt sees the row and backs away. A guard that can be left holding a lock nobody owns is a leak, not a guard.

So the record carries a **recoverable lease**.

| Step | |
|---|---|
| Enqueue | Insert `pending`, `nextAttemptAt = now`, `lockedAt = null`. `ON CONFLICT DO NOTHING` |
| Claim | **One atomic conditional update, never a read followed by a write.** Set `lockedAt = now()`, `lockToken = <new uuid>`, `attempts = attempts + 1`, where `status ≠ sent` **and** `attempts < MAX_ATTEMPTS` **and** `nextAttemptAt ≤ now()` **and** (`lockedAt` is null **or** older than the lease). Zero rows updated means another worker holds it, or it is spent. The worker keeps the uuid it just wrote |
| Send | Call the provider with the idempotency key |
| Settle | Conditional on `id = :id AND lockToken = :myToken`. `sent` with `sentAt` and `providerMessageId`, or `failed` with `lastError` and a backed-off `nextAttemptAt`. Either way, `lockedAt = null` and `lockToken = null`. **Zero rows updated means this worker lost the lease — discard the result and write nothing** |

**The lease needs a fencing token, not just a timestamp.** Worker A claims a delivery, its provider call hangs past the lease, Worker B reclaims and settles it `sent`, and then Worker A wakes up and writes its own stale result over the top. Provider idempotency prevents the duplicate *email*; it does nothing for the database row. The `lockToken` closes it: a worker may only settle the claim it still holds, and a worker that lost its lease discards its result silently.

**`attempts < MAX_ATTEMPTS` belongs in the claim predicate, not only in the cron's selection.** The cron is not the only caller — a webhook retry reaches the same claim path, and a ceiling enforced only in the sweep query would let a spent row be picked up anyway. The predicate is the enforcement; the cron's query is an optimization on top of it.

**`attempts` increments at claim, not at failure.** A crashed attempt that never reached the settle step still consumed a real try, and counting only failures lets a crash loop retry forever without ever reaching the ceiling.

**The cron reclaims two populations, not one:**

| | |
|---|---|
| `failed`, `nextAttemptAt` arrived | Ordinary retry |
| `pending`, `lockedAt` older than the lease | **Worker died holding it.** Same claim path, no special case |

Both go through the identical conditional claim, which is the point of writing the predicate that way — there is no separate "unstick" routine to forget to run, and the ceiling applies to both without being restated.

At the ceiling, the row stays `failed` and stops being swept. It surfaces in the host panel rather than disappearing; a supporter who never got her link is a fact the host needs.

### Provider idempotency

If the provider supports idempotency keys, pass `{notificationType}:{dedupeKey}` — **stable across attempts, and never including `attempts`.** The case it protects is a send that timed out but actually delivered; a key that changes per attempt would mail her twice.

### The guard is never the payment

**"Has this been sent," never "has this payment been processed."** Stripe retries webhooks, and a retry against an already-confirmed contribution must still re-attempt an email that failed the first time. Gating on payment idempotency is exactly how a permanently failed email becomes invisible — the payment looks handled, so nothing tries again.

**Enqueue may join the confirmation transaction; the send never does.** Inserting the row is a local write with no network call, so putting it in the transaction costs nothing and removes the window where a confirmation commits with nothing queued behind it. The provider call happens after commit, and confirmation never blocks on it or rolls back for it — admission invariant 33 applied to sign-ups.

---

## 6. Claiming a slot

The sheet shows every slot, its capacity, and what remains. Claiming takes one tap.

```
Main gate · 2:00–4:00 PM        2 of 4 open     [ Sign up ]
Setup crew · 8:00–10:00 AM      FULL
Cases of water                  3 of 6 needed   [ − 2 + ]  [ Sign up ]
```

**Capacity is enforced by the unique constraint, not by a counter.** One transaction: insert or find the `HelperSignup`, read the taken positions, insert N `HelperSignupPosition` rows at the lowest free numbers. On unique violation anywhere, roll back, re-read, retry once, then report what is actually left. Two parents tapping the last gate opening at the same moment is the double-booking problem from the grid, and it gets the proven answer rather than a `filledCount` column that drifts.

**All or nothing.** A supporter who asked for 3 cases and can only get 2 is told what remains and re-confirms. Never silently give them fewer — a host reading "3 cases" who receives 2 has a real problem at 8am.

Adding to an existing commitment inserts more position rows against the same `HelperSignup`. There is no counter to update and no second commitment to create — the unique constraint makes that the only possible shape, which is the point.

### Cancellation frees the positions

This is where sign-ups deliberately **diverge from passes**. `AdmissionPass.sequenceNumber` is monotonic and never reused, because a pass is an entitlement and reuse would be a security question. A slot position is a seat, not a credential. Cancelling deletes the commitment, cascades its positions, and those numbers become claimable again.

Partial cancellation on an `ITEM` — dropping from 4 cases to 2 — deletes 2 position rows and leaves the commitment standing. The displayed quantity follows automatically because it was never stored. On a `SHIFT` there is nothing partial to do; dropping the one position drops the commitment.

Cancel writes a `SignupLog` row. Nothing else is retained.

### Managing a sign-up without an account

Same as everywhere else in Daali: the emailed `SupporterAccessToken` link opens the sheet with the supporter's own claims marked and cancellable. No login, no password, no account.

---

## 7. Permissions

| | Host | Check-in Staff | Helper |
|---|---|---|---|
| See money, confirm payment | ✅ | ❌ | ❌ |
| See the grid, squares | ✅ | ❌ | ❌ |
| Create and edit slots | ✅ | ❌ | ❌ |
| See the full sign-up roster | ✅ | ❌ | ❌ |
| Remove a helper, close sign-ups | ✅ | ❌ | ❌ |
| Claim and cancel own slots | ⚠️ | — | ✅ |
| Scan, search, check in, undo | ✅ | ✅ | ❌ |

**Claiming a gate shift grants no scanning authority** (invariant 41). A supporter can sign up for "Main gate 2–4 PM" and still not be able to check anyone in. The host issues a `CheckinStaffAccess` link deliberately, to a named person, and can revoke it. These two things look adjacent in the host panel and must never be wired together.

### Donors-only is absolute

**There is no host-added helper.** No `source` column, no `HOST_ADDED`, no back door. Every row on the sheet belongs to a supporter who contributed and whose contribution confirmed.

The ⚠️ above is the whole exception, and it isn't one: a host who has made a confirmed contribution is an `active` supporter like anyone else and may claim a slot on those terms. A host who hasn't, can't. The rule reads the same for everybody, which is what makes it explainable.

**The host manages the sheet without appearing on it.** Create slots, edit them, remove a helper, close sign-ups — all host powers, none of which put a name on the roster.

**Check-in staff are unaffected.** Scanning authority is a system permission the host grants deliberately, not a helper signup, so appointing a check-in person has never required a contribution and still doesn't. The two look adjacent in the host panel and are governed by different rules on purpose.

A non-contributing helper — the parent who always runs the grill — is outside this feature. If she should be on the roster, she contributes. That is the product rule, and building an exception for her would quietly make it false.

---

## 8. Host panel

Inside the existing event panel (`fundraiser-board-v2.md` §9), below the roster:

```
Sign-Up Sheet · open
14 of 22 slots filled · 3 cancellations

[ Edit slots ]   [ Roster ]   [ Close sign-ups ]
```

Editing a slot's capacity **downward below its filled count is refused**, with the count shown. Removing a person is a deliberate `HOST_REMOVED` action, not a side effect of typing a smaller number.

### The unified roster

This is the payoff, and it is one query because helpers key to `EventSupporter.identityKey`:

```
Daaliyah Tate
daaliyah@example.com · (770) 555-0142
Contributed $150 · confirmed
4 passes · 2 used
Helping: 2 cases of water · Setup 8–10 AM
```

One person, one row, across contributions, admissions, and sign-ups.

Larger nonprofit CRMs and event platforms can associate these facts too, given setup and budget. The claim here is narrower and more useful: **Daali renders the organizer's most important supporter facts on one event roster without requiring separate fundraising, ticketing, and volunteer tools.** A parent running a homecoming tailgate gets that line by default, not by integrating three products.

---

## 9. Cleanup amendment

The admission addendum deletes orphaned grants and, with them, `pending` supporters holding no grants.

**Amend: a supporter with any `HelperSignup` row is never deleted, regardless of status.**

With donors-only absolute, this guard is unreachable by design — every helper is `active`, and cleanup never touches active supporters. Add it anyway. It costs one clause, and it is the safety net for any future path that lets a non-`active` supporter hold a signup. Deleting a supporter out from under a live commitment is the kind of thing that gets discovered at 6am on event day.

---

## 10. Disputes

Fundraiser policy has no voluntary refunds (money doc invariant 5), so this is the chargeback path only.

| | |
|---|---|
| Future eligibility | Removed. Supporter is no longer `active`, so no new claims |
| Existing signups | **Kept, and flagged for host review.** Never auto-deleted |

Silently vanishing a helper the week of the event, over a bank dispute the host hasn't seen yet, replaces a money problem with a staffing problem. Show it to the host and let her decide.

---

## 11. Invariants

Appended to money doc §9 and admission addendum §10. **Invariant 32 is amended** — see §2.

34. A helper signup grants no square, no drawing entry, no admission pass, and no check-in authority. It is never entitlement.
35. Only a supporter with `status = active` may claim a slot. Eligibility is derived from supporter status and never stored.
36. The help checkbox records intent only. It never claims, reserves, or holds a slot.
37. A `pending` or `reserved_cash` contribution grants no sign-up access.
38. Slot capacity is enforced by unique `(slotId, position)` on `HelperSignupPosition`. Commitment uniqueness is enforced by unique `(slotId, eventSupporterId)` on `HelperSignup`. No mutable counter exists anywhere, and no constraint reaches across tables.
39. Quantity is never stored. A commitment's quantity is the count of its position rows, and a `SHIFT` commitment holds exactly one. Position rows are bound to their commitment's slot by composite foreign key and cascade on delete.
40. Cancellation deletes positions and frees those numbers for reuse. Every claim, addition, cancel, and host removal writes a `SignupLog` row.
41. Check-in authority originates only from a host-issued `CheckinStaffAccess` link. No sign-up action creates, implies, or extends it.
42. A supporter with at least one helper signup is never deleted by cleanup, at any status.
43. Sign-Up Sheets exist only on board-linked events. There is no standalone sheet and `Event.boardId` stays required.
44. A reversed or disputed contribution removes future claim eligibility and flags existing signups for host review. It never deletes them.
45. Email delivery is guarded by unique `(notificationType, dedupeKey)` and by send status, never by whether the payment was already processed. A webhook retry re-attempts a failed send. Delivery never blocks, delays, or rolls back a confirmation.
46. A delivery attempt holds an expiring lease identified by a per-claim fencing token. Claiming is one atomic conditional update, `attempts` increments when an attempt begins, and settlement is rejected for a worker that no longer holds the token. A row can never be stranded in a state no worker will reclaim, and a stale worker can never overwrite a newer result.
47. Every helper signup belongs to an `active` supporter. There is no host-added helper and no other path onto the sheet. A host appears only by contributing.

---

## 12. Deferred

The data model forbids none of these.

| Deferred | Preserved by |
|---|---|
| Standalone sign-up sheets | `SignupSheet` hangs off `Event`, not `Board` |
| Sign-up on Game Day boards | Same — nothing here is fundraiser-specific below the eligibility rule |
| Reminder emails before a shift | `SignupSlot.startsAt` exists |
| Recurring or multi-date sheets | One sheet per event. Relaxing it is a migration |
| Custom questions per slot | `HelperSignup.note` is the one-field version |
| Helper self-check-in at the gate | Explicitly out. Invariant 41 |
| Waitlists on full slots | Nothing depends on capacity being the ceiling |

---

## 13. Build order

**S3 onward depends on A8.** Eligibility reads `EventSupporter.status = active`, which is only written once activation lands in the confirmation transaction. Nothing from S3 onward can be tested before then. S0 through S2 have no such dependency — the rename, the schema, and the host slot builder all stand on their own.

**The rename should land before sign-up work begins.** A10 is further along than earlier versions of this document assumed, so the rename is no longer free — but every new file S1–S5 adds is another one written against whichever name is current, and the cost only grows.

**Nothing may promise a destination that doesn't exist yet.** An earlier ordering put the checkout redirect before the screen it redirects to and before the email it promises. That step could not have shipped on its own. The order below builds the destination first, then the delivery, then the entry point.

| # | Step | Note |
|---|---|---|
| S0 | **Application rename** — Prisma models, fields, symbols, filenames, copy, host route + alias, invariant 32 text. All `@@map`/`@map` to existing physical names | Do first. **No destructive SQL. No physical migration.** §2 |
| S1 | Schema — `SignupSheet`, `SignupSlot`, `HelperSignup` + composite unique, `HelperSignupPosition` + composite FK, `SignupLog`, `NotificationDelivery` + lease and fencing fields, `AdmissionGrant.wantsToHelp`, rename `AttendanceAccessToken` — plus `src/lib/signups.ts` | **Three preconditions before the first `CREATE TABLE` — see "S1 preconditions" below.** |
| S2 | Host slot builder — create, edit, reorder, close | Host-only. Nothing public yet |
| S3 | Sign-Up Sheet screen — token auth, claim, cancel, concurrency | The retry path and the all-or-nothing multi-position path are what to test |
| S4 | Confirmation emails carrying the link — card webhook and direct-payment confirm | §5b. The retry cron lands here |
| S5 | Checkout checkbox, poll-driven redirect, fallbacks, unified roster | Last, because everything it points at now exists |

S2 alone is useful — a host can build the sheet before anyone can claim from it. S3 is testable by pasting a token by hand. S4 makes the 20-second promise in §5 true, which is why it precedes the step that makes the promise.

---

## 14. Files

| File | Change |
|---|---|
| `prisma/schema.prisma` | §3, plus the S0 rename |
| `src/lib/signups.ts` | **NEW** — sole owner of claim, cancel, position allocation, and `getOrCreateSupporterAccessToken()` |
| `src/lib/email.ts` | **NEW** — the sender. Built in S4, shared with the §12 confirmation email |
| `src/lib/cron/retry-notifications.ts` | **NEW** — sweeps eligible `failed` rows and stale `pending` leases |
| `src/app/host/boards/[id]/signup-panel.tsx` | **NEW** — slot builder and roster |
| `src/app/api/host/events/[id]/slots/route.ts` | **NEW** |
| `src/app/signup/[token]/page.tsx` | **NEW** — supporter sheet |
| `src/app/api/signup/[token]/claim/route.ts` | **NEW** — claim, cancel |
| `src/app/board/[slug]/claim-sheet.tsx` | Help checkbox |
| *card return page* | Issue token and redirect when the poll sees paid; CTA fallback. **Locate it; do not guess the path** |
| *cash confirm route* | Send token email. Same route admission activation uses |
| `src/lib/cron/release-expired.ts` | Cleanup guard — §9 |
| `src/app/gate/[token]/page.tsx` | Symbol and copy references only. Route unchanged |
| `src/lib/volunteer-access.ts` | **Renamed** to `src/lib/check-in-staff.ts` |
| `src/app/api/host/boards/[id]/volunteer-access/route.ts` | Shared handler moves to `/check-in-staff`; this path stays as an alias |
| `src/app/api/gate/[token]/checkin/route.ts` | Symbol references only |
| `src/app/host/boards/[id]/event-panel.tsx` | Copy + new route path |
| `src/lib/admission.ts` | Rename references only |

---

## 15. Before writing code

`fundraiser-board-v2.md` §17 Rule A makes that document the flow authority for fundraiser boards, including admission. **This document extends that authority to sign-ups.** The document-first rule is satisfied for sign-up work by writing here first.

The S0 rename touches `fundraiser-board-v2.md` §6B and §9, and `fundraiser-admission-addendum.md` §3, §8, and invariant 32. Those edits are part of S0, not a follow-up.

Cite rules by name, never by number.

---

## 16. Open questions

1. **Does a donate-flagged supporter see `SHIFT` slots?** They said they aren't attending. They may still drop supplies. Assumed: show everything, no filter. Filtering is a UI change later, not a data change.
2. **What happens to sign-ups when the board closes?** Assumed: nothing. The event is after the close, and `isOpen` is the host's separate control.
3. **Copy for the help checkbox.** "I'd like to help with the event" is a starting point, not a decision.
4. **Does the host need a printable roster?** She will be standing outside without signal. Not scoped here. Worth its own ticket.

**Closed since 1.0:** whether the host may add a non-contributing helper. Donors-only is absolute — §7, invariant 47.


---

## S1 preconditions

**Added 2026-08-31 during documentation reconciliation.** Not part of the
original v1.6 text. Recorded here because this is the document an S1
implementer reads; the full reasoning is in `PHASE-2-BACKLOG.md` under
"S1 checklist", and the short form is also in `CLAUDE.md`.

These come from the Data API containment and the `0_init` baseline. They are
not new scope — S1 creates six tables in `public`, and these are the conditions
under which creating a table there is safe.

**1. Assert the connecting role before creating anything.**

```sql
SELECT current_user;   -- over DIRECT_URL, must be `postgres`
```

The `ALTER DEFAULT PRIVILEGES` statements in `prisma/migrations/0_init` are
scoped `FOR ROLE postgres`. Default privileges govern only objects created **by
the named role**, so tables created over a connection authenticating as anything
else fall outside the revoke entirely and inherit whatever that role carries.
`scripts/verify-containment.mts` already asserts this, but over `DATABASE_URL`
(the transaction pooler). Migrations run over `DIRECT_URL`. The assertion
belongs on the connection that actually creates the tables.

**2. Make the RLS table-name-set diff repeatable across the six new tables.**

Derive both name sets — one from the migration files, one from the live catalog
— and fail on any name present in one and absent from the other, in either
direction. The three-way diff run on 2026-08-31 was a one-time proof for the
then-current 15 tables, not a standing check.

RLS is **per table**. There is no schema-wide `ENABLE ROW LEVEL SECURITY`, so
coverage drifts one table at a time and only a name-set diff catches it. Related
asymmetry worth knowing while doing this: `REVOKE ... ON ALL TABLES IN SCHEMA
public` is schema-wide only **at execution time** — it covers tables that exist
when it runs, never tables created later. Only the default-privilege lines cover
the future case.

**3. Do not count the sequence statements as coverage.**

No model uses `@default(autoincrement())` and production has zero sequences in
`public`, so the three `ALL SEQUENCES` statements in `0_init` act on an empty
set. If S1 introduces an autoincrement column, the **default-privilege** line is
what protects the resulting sequence; the two `ALL SEQUENCES` grant/revoke lines
operate at execution time and would not cover a sequence created afterwards.

Run `scripts/verify-containment.mts` immediately after S1's tables exist.
