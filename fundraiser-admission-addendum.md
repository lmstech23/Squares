# Fundraiser Admission — Addendum

**Status:** Frozen for Phase A
**Version:** 2.0 — declaration model removed
**Companion to:** `fundraiser-money-state-machine.md` (authority on money) · `fundraiser-board-v2.md` (authority on flows)

**Changed in 2.0.** The declaration model is gone. There is no attendance picker, no per-supporter ceiling, no Manage attendance screen, and no token auth. **One square equals one admission.** A supporter who isn't attending checks a box and donates theirs. Invariants 23–41 are replaced by 23–33. This removes roughly a third of the admission surface and most of what made Slice 2 large.

---

## Rule of this document

Adds **event admission** to fundraiser boards. Does not change how money works.

Money, square states, and drawing eligibility stay defined in `fundraiser-money-state-machine.md`. This document adds invariants 23–33. If the two disagree, the money doc wins and this document is wrong.

---

## 1. The rule

```
1 confirmed square  =  1 admission pass
```

Buy 4 squares, 4 people get in. Buy 20, 20 get in. No cap, no picker, no math.

**Unless the purchaser opts out.** One checkbox at checkout:

```
[ ] I'm not attending — donate my admissions
```

Default unchecked. Checked, the purchase mints no passes and the supporter is excluded from the headcount. That case is real and expected — people buy squares purely to support the cause — and a checkbox is the entire cost of handling it.

### Why not a declared attendance number

An earlier version asked "how many people are attending?" with a host-set ceiling, so that pass count could differ from square count. It bought a more precise headcount for remote supporters and cost a picker, a ceiling, a management screen, a token auth path, and eight invariants.

Not worth it. Most buyers at a school tailgate are local parents bringing the people the squares are for. The checkbox covers the rest.

---

## 2. Vocabulary

| Term | Meaning |
|---|---|
| **Event** | A dated gathering attached to a fundraiser board. Optional. One per board |
| **Supporter** | One person's identity on one event, across all their purchases. The roster unit |
| **Admission Pass** | Entitlement for one person to enter. One per confirmed square |
| **Grant** | One purchase's contribution to a supporter. Carries the donate flag |

UI naming is fixed:

```
Square #23
Entry #23      the drawing entry, derived from the Square — no table
4 Tickets      event admission
```

**Reversed from v1.x and v2.0, deliberately.** Those drafts used *Drawing Ticket* and *Admission Pass*, on the theory that "ticket" was already taken by the drawing.

Contributors do not talk that way. People say **tickets** for getting into an event and **entries** for a drawing. Same disambiguation, words a parent would actually use. See v2 §6C.

**Never call a drawing entry a ticket** anywhere a human can read it.

Internal model names are unchanged: `AdmissionPass`, `AdmissionGrant`, `EventSupporter`, `passSequenceCursor`. Display strings only — renaming models for a copy decision is churn.

---

## 3. Schema

```
Board ──optional──▶ Event
   │                  │
   │            EventSupporter ──▶ AdmissionPass × N
   │                  ▲
Square ──confirms──▶ AdmissionGrant
```

No admission column lands on `Board` or `Square`.

### Event

| Field | Type | Notes |
|---|---|---|
| `id`, `boardId` | | `boardId` unique — one event per board |
| `name` | String? | Defaults to campaign title |
| `startsAt` | DateTime | |
| `endsAt` | DateTime? | |
| `timezone` | String | Reads from `Board.timezone` |
| `venue` | String? | |
| `maxAttendeesPerSupporter` | Int? | **Unused, and made nullable in migration 3.** It was `NOT NULL` with no default, and the form no longer collects it |

### EventSupporter

| Field | Type | Notes |
|---|---|---|
| `id`, `eventId` | | |
| `identityKey` | String | Normalized email, lowercased and trimmed. **Unique with `eventId`** |
| `name`, `email`, `phone` | String | What the roster searches |
| `passSequenceCursor` | Int | Default 0. Monotonic. Never decremented |
| `status` | enum | `pending` → `active`. One-way latch |
| `activatedAt` | DateTime? | |
| `declaredCount` | Int? | **Unused and harmless.** `NOT NULL DEFAULT 0`, so it stays 0 forever. No migration needed |

### AdmissionGrant

| Field | Type | Notes |
|---|---|---|
| `id`, `eventId`, `eventSupporterId` | | |
| `squareBatchId` | String? | Unique where not null. Makes preparation idempotent |
| `source` | enum | `FUNDRAISER` · `STANDALONE` · `GATE_ALLOWANCE` · `HOST_APPROVED` |
| `donateAdmissions` | Boolean | **NEW.** Default false. True mints no passes |
| `declaredAtPurchase` | Int? | **Unused, and made nullable in migration 3.** Was `NOT NULL` with no default |
| `createdAt` | DateTime | |

### Retiring a column: two different jobs

Migration 3 adds `donateAdmissions` and `AdmissionPass.squareId`, and drops `NOT NULL` from two columns the model no longer supplies.

**Leaving a column unused is not the same as making it safe to ignore.** A `NOT NULL` column with no default still has to be written on every insert. Three columns went out of use in v2.0 and they needed three different treatments:

| Column | State | Action |
|---|---|---|
| `EventSupporter.declaredCount` | `NOT NULL DEFAULT 0` | Nothing. Stays 0 |
| `Event.maxAttendeesPerSupporter` | `NOT NULL`, no default | **Drop NOT NULL.** Would fail the next board insert |
| `AdmissionGrant.declaredAtPurchase` | `NOT NULL`, no default | **Drop NOT NULL.** Would fail `createGrant` |

Before assuming a retired column is harmless, check `is_nullable` and `column_default`, not just whether anything reads it.

### AdmissionPass

| Field | Type | Notes |
|---|---|---|
| `id`, `eventSupporterId` | | Passes hang off the supporter, not the purchase |
| `squareId` | String? | The square that minted it. Audit only |
| `sequenceNumber` | Int | Monotonic, never reused. Unique with `eventSupporterId` |
| `token` | String | **Unique.** Opaque, unguessable. Never a URL |
| `label` | String? | Optional name, if the purchaser bothered |
| `status` | enum | `active` · `used` · `void` |
| `checkedInAt` | DateTime? | |
| `checkedInByCheckinStaffId` | String? | FK to `CheckinStaffAccess.id`. Never a bearer token. Mapped to the physical column `checked_in_by_volunteer_access_id` |

`sequenceNumber` is internal. The passes screen shows "Pass 2 of 4" by counting current usable passes in order, never the raw number.

### CheckInLog · CheckinStaffAccess

Unchanged from v1.x. `CheckinStaffAccess.tokenHash` is hashed at rest.

**Renamed at the application layer only** — sign-up addendum §2. The Prisma model is
`CheckinStaffAccess`; the physical table is still `volunteer_access` and holds issued
records, so `@@map` pins it. `CheckInLog.byCheckinStaffId` maps to
`by_volunteer_access_id` the same way. A physical rename is a separate ticket for a
planned window with no event nearby.

### AttendanceAccessToken

**Unused in Phase A.** The table exists from the applied migration. Manage attendance is gone, so nothing writes it. Left in place — dropping it is a migration for no benefit, and it's the right table if a self-service path ever returns.

### Constraints

```
Event.boardId                                     unique
EventSupporter (eventId, identityKey)             unique
AdmissionGrant.squareBatchId                      unique where not null
AdmissionPass (eventSupporterId, sequenceNumber)  unique
AdmissionPass.token                               unique
```

The fourth is what makes concurrent minting safe. See §5.

---

## 4. At claim time

In the same transaction that creates the `pending` or `reserved_cash` squares, on boards with an event:

```
resolveSupporter(eventId, email, name, phone)
    -> find by normalized identityKey, or create with status = pending

createGrant(supporterId, squareBatchId, source = FUNDRAISER,
            donateAdmissions = the checkbox)
```

**No passes yet.** A pending supporter owns zero pass records.

Idempotent by constraint: `squareBatchId` is unique, so a retried claim can't write a second grant.

### Orphaned grants

A grant with no live squares must be deleted, along with its supporter if that supporter is `pending` and has no grants left. Active supporters are never touched. Without this, dead grants inflate the host's unpaid forecast permanently.

**Key the cleanup on "the grant has no live squares," not on "a batch was released."** Two different paths produce an orphan and only one of them is a release:

| Path | What happens |
|---|---|
| Abandoned claim | Hold expires, cron releases the batch, its grant is left with nothing |
| **Merged checkout** | Earlier squares are re-batched onto a new `batchId`, leaving the older grant holding zero squares. **Nothing was released** |

A release-keyed cleanup never reaches the second one. It is the same failure this section exists to prevent, arrived at from a direction the release event cannot see.

---

## 5. At confirmation

**One pass per square, minted in the same transaction that flips that square to `paid`.**

```
card:  Stripe webhook  ──┐            square → paid
                         ├──▶ tx      supporter → active (if not already)
cash:  host confirms  ───┘            mint 1 pass, unless donateAdmissions
```

**One function, called from both.** As of A6 the Stripe webhook and the cash confirm path each flip squares to `paid` independently. A8 must not add minting to both — two implementations of the same transaction will drift, and the one that drifts is whichever gets tested less. Extract a single `confirmSquare(squareId, tx)` that both call, and put minting inside it.

The failure this prevents is specific and quiet: card contributors get passes and cash contributors don't, or the reverse, and nobody notices until a gate.

Two writes plus one pass. Drawing eligibility is a *derived property* of the square reaching `paid`, not a write — there is no `Ticket` table (money doc §5). On a Phase A no-prize board no ticket exists at all.

**Per square, not per batch.** Three squares reserved, one confirms → one pass. The old model activated a whole declared count off a single confirmation; that special case is gone. Passes accrue exactly as squares confirm.

### Squares confirmed before A8 need a backfill

Minting happens at confirmation. If the board goes live to real contributors before A8 ships — which is the plan, since squares are live weeks before the gate — then every square confirmed in that window is `paid`, carries a grant, and has **no pass**. Confirmation has already passed for them and will not run again.

**A8 must include a one-time backfill**, run inside the same deploy:

```
for each active supporter:
    expected = confirmed squares whose grant has donateAdmissions = false
    existing = active + used passes
    mint (expected - existing) passes at the next cursor values
```

Idempotent by construction — it mints the difference, so running it twice is a no-op. It must respect `donateAdmissions`, and it must never touch `void` passes, or a supporter who opted out gets passes anyway.

This is not an edge case. It is the expected state of the board on the day A8 ships, and discovering it then means writing a migration against live contributor money under time pressure.

**Until A9, the confirmation page says nothing about admission.**

Originally until A8, on the reasoning that the pass had to exist first. It does now — A8 mints it — but there is still no passes screen and no email, so the contributor cannot reach the thing being named. A count with nothing to click is a support question, not reassurance. The line appears at A9, with a working link behind it.

Original reasoning, unchanged: Not a promise of passes arriving later. Passes mint in the same transaction that confirms the square, so someone paying at 9pm has their QRs at 9pm — copy describing a wait would be describing a delay that is not supposed to exist, and it would still be there after A8 telling people to expect something they already have.

A receipt that names something the person cannot see or click is worse than one that stays quiet.

**The better answer is to ship A8 before the board goes live**, which is why v2 §16 moves it ahead of A7. Then the backfill is a no-op, the copy question never arises, and the first contributor gets passes the moment they pay.

### Email is not activation

The confirmation email carrying the QRs is a convenience artifact sent after commit. A cash payer can be confirmed while standing at the gate — her passes are live and her name is searchable instantly, whether or not the email has arrived. A typo'd address degrades the experience and never blocks entry.

### Concurrent confirmation

Cash squares resolve independently, so two squares in one batch can confirm concurrently. Two guarantees, both required:

**Compare-and-swap on the supporter row.**

```sql
SELECT ... FROM EventSupporter WHERE id = ? FOR UPDATE;
UPDATE EventSupporter SET status = 'active', activatedAt = now()
 WHERE id = ? AND status = 'pending';
```

Only the transaction that flips the row does the activation work. Both still mint their own square's pass.

**A constraint behind it.** Sequence numbers are drawn from `passSequenceCursor` under the same row lock. A double-mint collides on `(eventSupporterId, sequenceNumber)` and rolls back with its square, retryable.

Application-level status checking alone does not prevent this. It is the class of bug that passes every test on a developer machine and fires once, at a tailgate.

### Host-funded squares

**Not yet reachable.** Nothing in the product sets `isHostEntry = true` — host contributions are unbuilt, so there is no creation path to hook. This section specifies what must happen whenever that lands, not something A8 could have implemented.

A host-entry square is created already funded, so preparation and minting happen in one transaction at creation, keyed on the host's email from the `Host` record. Her square funds the cause and admits her. It is drawing-ineligible under invariant 15, which is the cleanest demonstration that eligibility and admission are separate.

### Free entries

`FreeEntry` occupies no square, moves no money, and mints no pass.

```
FreeEntry                → drawing only
Confirmed contribution   → drawing ticket + 1 admission pass
Host / admin square      → admission only
```

### Passes outlive the campaign

`OPEN → CLOSING → CLOSED` has no effect on admission. A campaign that closed October 9 still has passes that scan on October 24.

---

## 6. Changing your mind

The donate checkbox is set at checkout, per purchase.

**Changing it afterward is a host action**, from the event panel. She is already authenticated, so no token flow and no self-service screen. Toggling to donate voids that grant's `active` passes; toggling back mints new ones at the next cursor values.

**`void` is terminal.** A voided pass never returns to `active`, so a screenshot shared into a group chat last week can't become a working credential again. New passes get new numbers and new tokens.

A `used` pass is never voidable. If three people already walked in, that grant can't be retroactively donated.

---

## 7. Roster and check-in

**The roster's unit is the supporter, not the purchase.** One family, one row, however many times they bought in.

```
Daaliyah Tate
daaliyah@example.com · (770) 555-0142
4 passes · 2 used · 2 remaining
```

Search matches supporter name, email, and phone. A pass label, when one exists, is an additional index. The roster works correctly with zero labels entered, which is the realistic case.

The purchaser's name is the only one reliably known — a cousin arriving alone says "it's under Daaliyah Tate," and that has to work.

**Scanning** any pass decrements that supporter's row. **Duplicate scan** is rejected, naming when and by whom it was used. **Undo** returns a pass to `active`, is logged, and creates no entitlement — misscans are the most common gate error and without undo the counter drifts until the host stops trusting it.

**Host view:**

```
Expected 84 · Checked in 51 · Remaining 33
```

Expected = count of `active` + `used` passes across active supporters. Donated purchases contribute zero, which is the entire point of the checkbox.

---

## 8. Permissions

| | Host | Volunteer |
|---|---|---|
| See money, confirm payment | ✅ | ❌ |
| See the grid, squares | ✅ | ❌ |
| Configure the event, toggle donate | ✅ | ❌ |
| See the roster | ✅ | ✅ |
| Scan, search, check in, undo | ✅ | ✅ |
| Create entitlement | ✅ | ❌ |

**Volunteers consume entitlement. They never create it.**

---

## 9. Deferred

The data model forbids none of these.

| Deferred | Preserved by |
|---|---|
| Standalone admission sales | `source = STANDALONE`, `squareBatchId` nullable |
| Gate allowance for unpurchased guests | `source = GATE_ALLOWANCE` |
| Host approval at the gate | `source = HOST_APPROVED` |
| Self-service attendance management | `AttendanceAccessToken` table, unused |
| Per-supporter attendance ceilings | `Event.maxAttendeesPerSupporter`, unused |
| Refunds, cancellation, rain-out | Money doc §8. Disclosure copy is a pre-launch item |
| Offline scanning | Roster is server-authoritative. Search is the degraded path |
| Multiple events per board | `Event.boardId` unique. Relaxing it is a migration |
| Pass transfer between accounts | No accounts exist. Sharing a QR is the transfer |

---

## 10. Invariants

Appended to money doc §9. **Invariant 16 amendment:** the locked-after-first-confirmed-contribution list gains *event date*.

23. An admission pass grants entry and never grants a drawing ticket. A drawing ticket grants a drawing entry and never grants admission.
24. One confirmed square mints exactly one admission pass, unless its grant has `donateAdmissions`, in which case it mints none.
25. Passes are minted in the same transaction that flips their square to `paid`. Never earlier. A pending supporter holds zero pass records.
26. There is no pending pass state. Every pass that exists can admit someone unless already `used` or `void`.
27. A claim on a board with an event creates its `EventSupporter` and `AdmissionGrant` in the same transaction as the squares.
28. `sequenceNumber` is monotonic per supporter and never reused. `void` is terminal — a voided pass and its token never return to `active`. The displayed ordinal is derived from current usable passes.
29. A pass is consumable once. A second scan is rejected and changes nothing. Undo restores it to `active`, is logged, and creates no entitlement.
30. Concurrent confirmation is guarded by compare-and-swap on `EventSupporter.status` and enforced by unique `(eventSupporterId, sequenceNumber)`.
31. Supporter status is a one-way latch. A later unpaid purchase never returns an active supporter to `pending`.
32. Check-in staff consume entitlement and never create it. No check-in action increases the number of passes on an event.
33. Email delivery is never a precondition for a pass being valid. Passes remain valid after the board reaches `CLOSED`.

---

## 11. Open questions

1. **A board that closes with zero contributions.** Assumed: no supporters, empty roster, event is a no-op.
2. **Copy for the donate checkbox.** "I'm not attending — donate my admissions" is a starting point, not a decision.
