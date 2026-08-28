# Fundraiser Admission — Addendum

**Status:** FROZEN — Aug 27, 2026. Slice 1 released to build.
**Version:** 1.5
**Companion to:** `fundraiser-money-state-machine.md` (authority on money) · `fundraiser-board-v2.md` (authority on product)
**Depends on:** Fundraiser boards, cash reserve/confirm, batch claim flow

**Changed in 1.5:** activation corrected — a drawing ticket is a derived property of a Square, not a row, so confirmation performs **two** writes on a no-prize board and three on a prize board, not four. Phase A context added.

**Changed in 1.4:** `sequenceNumber` made monotonic and never reused, fixing a collision on decrease-then-increase; `void` made terminal so a shared screenshot can never become valid again; display ordinal separated from sequence; decrease floored at the used count; check-in audit changed from bearer token to `VolunteerAccess` foreign key; invariant ranges corrected to 23–41.

**Changed in 1.3:** added the claim-time preparation step that creates the pending supporter and grant; activation made concurrency-safe at the database level via `sequenceNumber` and compare-and-swap; explicit uniqueness constraints stated; `VolunteerAccess` token stored hashed; host-square provenance specified; §10 corrected. Flow, screen, and auth specifications moved into `fundraiser-board-v2.md` §5, §6, §6A, §6B, §9 — this document is now model and invariants only.

**Changed in 1.2:** passes are minted at activation, never before — a pending supporter holds a declaration and zero pass records; invariant 27 rewritten accordingly; attendance declaration removed from repeat-purchase checkout in favor of Manage attendance.

**Changed in 1.1:** attendance ceiling moved from per-purchase to per-supporter; roster unit changed from purchase to supporter; host squares and free entries resolved from assumptions to rules; invariant 16 wording corrected; authentication changed from email match to secure token.

---

## Rule of this document

This document adds **event admission** to fundraiser boards. It does not change how money works.

Everything about dollars, square states, drawing eligibility, close, and draw mechanics remains defined in `fundraiser-money-state-machine.md`. This addendum adds invariants 23–41 and amends invariant 16. It changes nothing else in that document.

The drawing ticket is **untouched**. Its meaning, numbering, and lifecycle are unchanged. This document introduces a separate object.

**It is a derived concept, not a table.** There is no `Ticket` model and none should be built — money doc §5.

If this document appears to contradict the money doc, the money doc wins and this document is wrong.

---

## 1. Vocabulary

| Term | Meaning |
|---|---|
| **Event** | A dated gathering associated with a fundraiser board. Optional. At most one per board. |
| **Supporter** | One person's identity on one event, across all their purchases. The roster unit. |
| **Admission Pass** | Entitlement for one person to enter the event. Uniquely tokenized. |
| **Declared attendance** | How many people a supporter says are coming. Declared, not purchased. |
| **Grant** | The record of one purchase contributing to a supporter's declared attendance. |
| **Roster** | The volunteer-facing check-in list for an event. |

**UI naming is fixed:**

```
Square #23
Drawing Ticket #23
3 Admission Passes
```

"Drawing Ticket" is a display string over a derived value — there is no `Ticket` model behind it. **Never call an admission pass a ticket anywhere a human can read it.**

---

## 2. What gets added now

### The core separation

A fundraiser is a campaign that ends. An event is a thing that happens. They have different lifecycles and are modeled separately.

```
Board (fundraiser)  ──optional──▶  Event
      │                              │
      │                         EventSupporter ──▶ AdmissionPass × N
      │                              ▲
   Square ──confirms──┬──▶ Ticket    │
                      │   (drawing)  │
                      │   unchanged  │
                      └──▶ AdmissionGrant ───────┘
```

Admission is **not** a field on `Square` and **not** a field on `Board`.

### The ceiling is per supporter, not per purchase

The host sets how many people **one supporter** may bring to the event. Not how many per transaction.

Otherwise a second square bought on Thursday mints a second full family allowance, and 4 becomes 8 by shopping twice.

**Identity key is the normalized purchaser email** (lowercased, trimmed) scoped to the event. Two purchases with the same email are the same supporter. Two emails are two supporters, and that is a known, accepted weakness — this is a headcount control for a school tailgate, not a security boundary. It stops the accident, not the determined.

### Event — new table

| Field | Type | Notes |
|---|---|---|
| `id`, `boardId` | | `boardId` unique — at most one event per board |
| `name` | String? | Defaults to board title |
| `startsAt` | DateTime | |
| `endsAt` | DateTime? | |
| `timezone` | String | IANA |
| `venue` | String? | |
| `maxAttendeesPerSupporter` | Int | Host-set ceiling **per supporter, per event**. Hampton: 4 |
| `gateAllowanceTotal` | Int | Default 0. **Reserved — not surfaced.** See §5 |

An event may start before, on, or after the board's `drawDate`. No constraint between them.

### EventSupporter — new table

The roster unit, and the owner of passes.

| Field | Type | Notes |
|---|---|---|
| `id`, `eventId` | | |
| `identityKey` | String | Normalized email. **Unique with `eventId`** |
| `name`, `email`, `phone` | String | What the roster searches |
| `declaredCount` | Int | `0 … maxAttendeesPerSupporter`. An **intention** while pending; an entitlement once active |
| `passSequenceCursor` | Int | Default 0. Monotonic. Never decremented, never reset |
| `status` | enum | `pending` → `active`. One-way. Never returns to `pending` |
| `activatedAt` | DateTime? | |

**A pending supporter owns zero passes.** See §4.

Status is a latch, not a running state. Once any square of any purchase confirms, the supporter is active permanently. A later pending purchase from the same person does not un-activate them.

### AdmissionGrant — new table

Provenance. One row per purchase that touched admission.

| Field | Type | Notes |
|---|---|---|
| `id`, `eventId`, `eventSupporterId` | | |
| `squareBatchId` | String? | Links to `Square.batchId`. Null for non-fundraiser sources |
| `source` | enum | `FUNDRAISER` · `STANDALONE` · `GATE_ALLOWANCE` · `HOST_APPROVED` |
| `declaredAtPurchase` | Int | What this purchase declared. Audit only |
| `createdAt` | DateTime | |

**Only `FUNDRAISER` is populated now.** The other three exist so adding them later is a code path, not a migration.

A grant is written even when it declares 0, so the host's headcount is auditable rather than inferred from absence.

**Unique on `squareBatchId` where it is not null.** One fundraiser grant per purchase. This is what makes the claim-time preparation step (§4) safely idempotent under retry.

### AdmissionPass — new table

| Field | Type | Notes |
|---|---|---|
| `id`, `eventSupporterId` | | Passes hang off the **supporter**, not the purchase |
| `sequenceNumber` | Int | **Monotonic, never reused.** Drawn from `passSequenceCursor`. Unique with `eventSupporterId` |
| `token` | String | **Unique.** Unguessable, opaque. Never a URL |
| `label` | String? | **Optional.** A name, if the purchaser bothered |
| `status` | enum | `active` · `used` · `void` |
| `checkedInAt` | DateTime? | |
| `checkedInByVolunteerAccessId` | String? | **Foreign key** to `VolunteerAccess.id`. Never a bearer token |

Every pass gets its own token whether or not it is ever named. A shared, unidentified QR is one screenshot away from admitting six people.

### sequenceNumber is internal

It exists for concurrency safety (§4) and audit. **It is not the displayed ordinal.**

Minting draws from `EventSupporter.passSequenceCursor`: assign `cursor+1 … cursor+N`, then advance the cursor. The cursor never decrements and values are never reused.

This matters because voided passes are retained. Declare 4 → passes 1–4. Lower to 2 → 3 and 4 are voided and kept. Raise back to 4 → the new passes are **5 and 6**, not 3 and 4.

Reusing 3 and 4 would collide with the unique constraint. Reactivating the old rows would be worse: a screenshot of pass 4 shared into a group chat last week would silently become a working gate credential again. **`void` is terminal.** A voided pass and its token never return to `active` under any path.

The passes screen enumerates current usable passes independently — "Pass 1 of 4" counts `active` and `used` passes in sequence order and ignores the underlying numbers entirely. The supporter never sees a gap.

**Pass records exist only for active supporters.** There is no `pending` pass state and none should be added.

For an active supporter, `active + used` passes always equal `declaredCount`. `void` passes are excluded from that count and retained for audit.

**Raising** the declaration mints new passes at the next cursor values.
**Lowering** voids `active` passes, highest sequence first, so the passes shared earliest stay valid.
A `used` pass is never voidable.

**A decrease can never go below the number of `used` passes.** Three people already walked through the gate; there is no coherent meaning to "we're now attending with 2." Such a request is **rejected**, not clamped, and returns the used count so the UI can say why.

### CheckInLog — new table

| Field | Type |
|---|---|
| `id`, `passId`, `eventId` | |
| `action` | `check_in` · `undo` |
| `at` | DateTime |
| `byVolunteerAccessId` | FK to `VolunteerAccess.id` |

Undo has to be auditable or the host stops trusting the count.

### VolunteerAccess — new table

| Field | Type | Notes |
|---|---|---|
| `id`, `eventId` | | |
| `label` | String | "Renee — main gate" |
| `tokenHash` | String | **Hashed at rest.** The raw link is shown once at creation and never stored |
| `revokedAt` | DateTime? | |

Scoped to one event. Revocable individually. Grants roster read and check-in only.

A volunteer link is a bearer credential that will sit in a text thread on five phones for a week. Same handling as `AttendanceAccessToken` below: hashed at rest, so a database read never yields a working gate credential.

### AttendanceAccessToken — new table

| Field | Type | Notes |
|---|---|---|
| `id`, `eventSupporterId` | | |
| `tokenHash` | String | Hashed. The raw value exists only in the email |
| `expiresAt` | DateTime | 20 minutes |
| `usedAt` | DateTime? | Single use |
| `createdAt` | DateTime | |

Flow and rules: v2 §6A.

### Uniqueness constraints — stated explicitly

| Constraint | Guards |
|---|---|
| `Event.boardId` unique | One event per board |
| `EventSupporter (eventId, identityKey)` unique | One family, one row, one allowance |
| `AdmissionGrant.squareBatchId` unique where not null | Preparation step idempotent under retry |
| `AdmissionPass (eventSupporterId, sequenceNumber)` unique | **Concurrent activation cannot double-mint.** Safe because the cursor never reuses a value |
| `AdmissionPass.token` unique | No token collision across the whole system |

The fourth is the important one and it is not decorative. See §4.

### Changed elsewhere

Nothing. No column is added to `Board` or `Square`, and nothing changes about how a drawing ticket is derived from a square.

---

## 3. Declaring attendance

### At checkout

```
How many people are attending?
0 · 1 · 2 · 3 · 4
```

One number. **No guest names at checkout.**

Zero is a real answer. A grandmother in Charlotte buying a square to support the school is not driving down, and if the picker starts at 1 the host's headcount is inflated by every remote supporter — which is the one number this whole feature exists to produce.

**Asked once, on a supporter's first purchase only.**

### On a repeat purchase

**The question is not asked again.** A repeat purchase shows state, not a picker:

```
You're attending with 2 people.
Your event limit is 4.
[ Manage attendance ]
```

Attendance can already be raised to the ceiling for free at any time through Manage attendance, so asking at checkout would offer nothing a supporter can't already do on a Tuesday afternoon. It would also imply that buying more squares is how you get more admissions, which is the exact model this document rejected.

A second purchase means one thing: **another square, another drawing chance.** Admission is untouched by it.

**Sequencing:** whether a supporter is new or returning is resolved by `identityKey` lookup on the email field, so the attendance step renders after contact details are entered. Existence of an `EventSupporter` row is the test, not its status — someone whose first purchase is still an unconfirmed Zelle reservation is a returning supporter and sees the status line, not a second picker.

A different email is a different supporter with a fresh allowance. Accepted weakness, per §2.

### Later adjustment, before the event

- **Decrease:** free, any time before `startsAt`. Voids unused passes only.
- **Increase:** free up to `maxAttendeesPerSupporter`, before `startsAt`. This is claiming entitlement already granted, not creating new entitlement.
- **Above the ceiling:** deferred. See §7.

Lowering `maxAttendeesPerSupporter` later never invalidates passes already issued.

**Authentication: a secure single-use token, emailed on request.** Not an email match.

The shipped Player Resume Checkout flow matches on email alone, and that is acceptable there because the only thing it unlocks is the right to pay for your own abandoned square. It is **not** acceptable here. Knowing someone's address must not let a stranger void their family's passes or mint new ones. This is a new auth path, not a reuse of the existing one, and the doc previously described it wrongly.

---

## 4. Activation

### At claim time — the preparation step

Activation needs something to activate. That relationship is created when the claim is made, **before** any money moves.

Server-side, in the same transaction that creates the `pending` or `reserved_cash` squares, on boards with an event:

```
resolveSupporter(eventId, email, name, phone)
    -> find by normalized identityKey, or create with status = pending

declaredAttendance (optional int on the claim payload)
    -> accepted ONLY when the supporter row was just created
    -> clamped to maxAttendeesPerSupporter
    -> ignored, and logged, for an existing supporter (invariant 28)

createGrant(supporterId, squareBatchId, source = FUNDRAISER,
            declaredAtPurchase = the number above)
```

The parameter is optional because Slice 1 ships with no UI to supply it. Absent, a new supporter gets `declaredCount = 0`, which is correct: no declaration, no admission. Slice 2 wires the picker to the same parameter and nothing server-side changes.

**Idempotent by constraint, not by check.** `AdmissionGrant.squareBatchId` is unique, so a retried claim cannot produce a second grant.

### Abandoned claims

A pending supporter whose squares were never paid would otherwise sit in the host's "declared but unpaid" forecast forever, quietly inflating a number she uses to order food.

The existing release cron gains one step. When a batch is released, if its grant has no remaining live squares, delete the grant; if the supporter is `pending` and has no grants left, delete the supporter. Active supporters are never touched.

### Before payment confirms

A declaration is not a pass. Between checkout and confirmation:

```
EventSupporter
  declaredCount   4
  status          pending
  passes          none — zero AdmissionPass records exist
```

**Passes are minted at activation, never before.** There is deliberately no pending pass state, because a pass that cannot open a gate is not a pass, and a gate that has to distinguish two kinds of QR is a gate that lets someone through by mistake.

This is the same rule the money doc already applies to drawing tickets: a reserved square holds no ticket (invariant 3), and eligibility activates only on confirmation (invariant 9). Admission now behaves identically. **Reservation alone grants nothing.**

At the gate this collapses to one distinction:

```
pending  →  not on the active roster, cannot enter
active   →  passes exist, can enter
```

### At confirmation

**Passes are minted inside the same transaction that flips a square to `paid`.**

```
card:  Stripe webhook  ──┐                      square → paid
                         ├──▶ one transaction   supporter → active
Zelle / Cash App:        │                      mint N admission passes
  host taps confirm  ────┘                      roster row appears
```

**Two writes, not four.** An earlier draft listed "drawing ticket → active" as a separate effect. It is not. Money doc §5: a paid drawing ticket is a derived property of a Square — `paymentStatus = paid AND NOT isHostEntry AND prizePoolPercent > 0` — so eligibility is a *consequence* of the first write, not an additional one. There is no `Ticket` table.

On a Phase A no-prize board, `prizePoolPercent = 0`, so no ticket exists at all and the question does not arise.

Card and Zelle/Cash App **end at the same state by the same path**. The trigger differs; nothing downstream does.

A reservation that is never paid releases under the existing rules, and the cron above cleans up its grant.

### Concurrent confirmation

Cash squares resolve independently (money doc invariant 7), so two squares in the same reserved batch can be confirmed concurrently — a host double-tapping, or two tabs. Both transactions read `status = pending`, both mint, and the family walks away with **twice** their passes.

Application-level status checking does not prevent this. Two guarantees, both required:

**1. Compare-and-swap on the supporter row.**

```sql
SELECT ... FROM EventSupporter WHERE id = ? FOR UPDATE;

UPDATE EventSupporter
   SET status = 'active', activatedAt = now()
 WHERE id = ? AND status = 'pending';
```

Only the transaction whose `UPDATE` affects a row proceeds to mint. The loser sees zero rows affected, mints nothing, and commits its square normally.

**2. A database constraint behind it.**

Passes are minted with explicit `sequenceNumber` values drawn from `passSequenceCursor` under the same row lock, unique with `eventSupporterId`. If a second mint somehow runs, it reads the same cursor, collides, and its transaction rolls back. The square rolls back with it and can be retried cleanly.

The cursor is advanced inside the locked transaction, which is what makes the constraint a real guarantee rather than a coincidence of ordering.

The first guarantee is the mechanism. The second is what makes the guarantee true rather than merely likely — this is exactly the class of bug that passes every test on a developer machine and fires once, at a tailgate, on the one board that matters.

### Email is not activation

The confirmation email carrying the QRs is a convenience artifact, sent after the transaction commits. It is never the record.

This matters operationally: a Zelle payer can be standing at the gate when the host confirms. Her passes are live and her name is searchable on the roster instantly, whether or not Gmail has delivered anything. A typo'd email address degrades the experience. It does not block entry.

### Partial cash confirmation

Cash batches resolve per square (money doc §4), but **declared attendance is per supporter, not per square.**

**The rule: at least one confirmed square in a purchase activates the full declared attendance.**

A supporter reserves 3 squares, declares 4 attendees, and only 1 square confirms. All 4 passes go live. There is no state where a fraction of a family is admissible.

Admission is deliberately **not proportional to contribution**. Money is counted per square. Admission is a declaration with a ceiling. They are different quantities and the system should never try to reconcile them.

### Phase A note

Admission ships in Phase A alongside a **no-prize** fundraiser (v2 §16). Everything in this document holds identically on a prize board — admission never touches money or eligibility — but on a Phase A board there are no tickets, so the only thing confirmation activates besides the square is admission.

### Host-funded squares

**Host and admin squares carry admission normally.** They are funded, they are drawing-ineligible under invariant 15, and the host is obviously attending her own tailgate. (On a Phase A board nothing is drawing-eligible, so this reduces to: her square funds the cause and admits her.)

**Where the host's supporter row comes from.** A host square is created already funded from the dashboard, so there is no separate confirmation step to activate on. Creating a host-entry square on a board with an event therefore does preparation and activation in one transaction:

```
resolveSupporter(eventId, host.email, host.name, host.phone)
createGrant(..., squareBatchId, source = FUNDRAISER)
activateSupporter(...)          -- immediately, same transaction
```

Her identity comes from the `Host` record, so the host is a supporter like anyone else, keyed on the same normalized email. `declaredCount` starts at 0 and she sets it from the event panel, where she is already authenticated and needs no token.

She is subject to `maxAttendeesPerSupporter` like everyone else. If she needs more than her own ceiling, that is the deferred approval path (§8), not an exemption — an exemption would be a second set of rules for the one person who can already edit the first set.

This is the cleanest proof that drawing eligibility and event admission are separate concepts: the same square grants one and not the other.

### Free entries

**Free entries carry no admission.** `FreeEntry` occupies no square, moves no money, and creates no `AdmissionGrant`.

Free entry exists to preserve an alternate route into the **drawing**. It is not a route into the event.

```
FreeEntry                     → drawing only
Confirmed contribution        → drawing ticket + declared admission
Host / admin square           → admission only
```

### Passes outlive the campaign

`OPEN → CLOSING → CLOSED → DRAWN` has no effect on admission. A board that closed October 12 and drew October 15 still has passes that scan on October 18.

---

## 5. Roster and check-in

**The roster's unit is the supporter, not the purchase.** One family is one row no matter how many times they bought in. Two purchases producing two rows would put the volunteer in exactly the position this feature exists to eliminate.

The purchaser's name is the only one reliably known. A cousin arriving alone says "it's under Daaliyah Tate," and that has to work.

```
Daaliyah Tate
daaliyah@example.com · (770) 555-0142
3 passes · 2 used · 1 remaining
```

**Search matches** supporter name, email, and phone. If a pass carries a `label`, that becomes an additional search entry. The roster works correctly with zero labels entered, which is the realistic case.

**Scanning** any pass decrements that supporter's row. The volunteer never needs to know which pass it was. The system does, so the same one cannot be consumed twice.

**Duplicate scan** returns a rejection naming when and by whom it was already used. It changes nothing.

**Undo** returns a pass to `active`, writes a `CheckInLog` row, and creates no new entitlement. Misscans are the most common gate error; without undo the counter drifts.

**Host view:**

```
Expected 126 · Checked in 74 · Remaining 52
```

Expected = sum of `declaredCount` across **active** supporters only.

The host dashboard may additionally show pending declarations as a soft forecast, the same way it distinguishes amber from green on the grid:

```
126 expected · 12 declared but unpaid
```

Twelve families who declared attendance and haven't paid is exactly the list she needs to chase before ordering food. It is a forecast, never a headcount, and it never reaches the volunteer roster.

---

## 6. Permissions

| | Host | Volunteer |
|---|---|---|
| See money, confirm payment | ✅ | ❌ |
| See the grid, squares, drawing | ✅ | ❌ |
| Configure the event | ✅ | ❌ |
| See the roster | ✅ | ✅ |
| Scan, search, check in, undo | ✅ | ✅ |
| Create entitlement | ✅ | ❌ |

**Volunteers consume entitlement. They never create it.** This is the boundary and nothing in this document crosses it.

The gate allowance in §2 is the mechanism that keeps it that way later: the host pre-authorizes a pool of guest admissions before the gate opens, and a volunteer drawing from it is spending entitlement the host created. Allowance of 20 is a free event; allowance of 0 with an approval path is a paid one. Same mechanism, different setting. **Neither is built now** — only `source` and `gateAllowanceTotal` exist, unsurfaced, so that building it later is a code path.

---

## 7. Demo scope — what we show

The demo runs the Hampton tailgate end to end: money in, gate open.

**Contributor**

1. Claim square #23 on the fundraiser board — unchanged flow
2. **"How many people are attending?"** `0 · 1 · 2 · 3 · 4` — ceiling is the host's per-supporter setting
3. Zero is a real answer, for supporters who aren't coming
4. Checkout stays one number. No guest names at checkout.
5. Success screen:

```
🎉 You're in!
Square #23
Drawing Ticket #23
3 Admission Passes
```

6. Passes screen — each pass separately keepable or shareable, naming optional

**Host**

7. Confirms a Zelle payment from her phone → roster count increments live
8. Card and Zelle land in the same `paid` / passes-active state

**Volunteer** — separate device, separate scoped link

9. Roster: expected / checked in / remaining
10. Scan a pass → ✓ ADMITTED
11. Scan the same pass again → rejected, with when and by whom
12. Search "Tate" → supporter row, 2 used, 1 remaining → tap → ✓ ADMITTED
13. Undo a mistaken check-in
14. No money, no grid, no drawing anywhere in this view

**Also demonstrated**

15. Supporter adjusts declared attendance before the event
16. Admission terms locked after the first confirmed contribution

**Optional beat, if the pitch has room:** the same supporter buys a second square and is never asked about attendance again — just "you're attending with 2, your limit is 4, manage attendance." Jordan buys once in the scripted flow, so this never surfaces on its own. But at a real Hampton tailgate somebody will buy again in week three, and showing that a second square is purely another drawing chance is the clearest possible statement that fundraising and admission are separate.

The beat worth not cutting is **#7 into #9** — host confirms Zelle, roster updates, gate admits. That is the seam closing, and it is the thing nobody has seen before.

---

## 8. Deliberately deferred

Out of demo scope. The data model does not forbid any of them.

| Deferred | Preserved by |
|---|---|
| Standalone admission sales without a square | `source = STANDALONE`, `squareBatchId` nullable |
| Whether standalone admission counts toward `raised` and the prize pool | Not decided. Nothing depends on it yet |
| Gate allowance for unpurchased guests | `gateAllowanceTotal`, `source = GATE_ALLOWANCE` |
| Host approval flow at the gate | `source = HOST_APPROVED` |
| Raising a single supporter above the ceiling | Same approval path as above |
| Refunds, cancellation, rain-out | Money doc §8 unchanged. Disclosure copy is a pre-launch item, not a build item |
| Offline scanning | Roster is server-authoritative. Search-by-name is the degraded path |
| Identity beyond normalized email | `identityKey` is a column, not a constraint on future logic |
| Multiple events per board, multi-day, sessions | `Event.boardId` unique today. Relaxing it is a migration, not a redesign |
| Transfer of a pass to another person's account | No accounts exist. Sharing a QR is the transfer mechanism |
| Waitlists, capacity caps on square sales | Venue capacity and board size stay unrelated |
| Pass revocation by the host | `status = void` exists; no UI |

---

## 9. Invariants

Appended to money doc §9.

**Amendment to invariant 16.** The locked-after-first-confirmed-contribution list gains: *event date, and attendance terms including the maximum attendee allowance per supporter.*

Deliberately **not** worded as "admissions per purchase." Admission is a declaration against a ceiling, never a fixed quantity multiplied by squares. That model was considered and rejected, and the wording should not leave a door open for someone to resurrect it.

23. An admission pass grants entry and never grants a drawing ticket. A drawing ticket grants a drawing entry and never grants admission.
24. Passes are minted in the same transaction that flips a square to `paid`. Never earlier. A pending supporter holds a declaration and **zero** pass records.
25. There is no pending pass state. A pass record exists only for an active supporter, and every pass that exists can admit someone unless already `used` or `void`.
26. At least one confirmed square in a purchase activates that supporter's full declared attendance. Admission is never proportional to contribution.
27. For an active supporter, `active + used` passes equal `declaredCount`. Lowering the declaration voids only `active` passes; a `used` pass is never voidable. Pending supporters are outside this equality.
28. Declared attendance is capped **per supporter per event**, not per purchase. Repeat purchases draw from the same allowance and never re-ask for it.
29. Supporter status is a one-way latch. Once active, a later unpaid purchase from the same identity never returns them to `pending`.
30. Every pass carries a unique unguessable token, whether or not it is labeled.
31. A pass is consumable once. A second scan is rejected and changes nothing.
32. Undo restores a pass to `active`, is logged, and creates no entitlement.
33. Volunteers consume entitlement. They never create it. There is no volunteer action that increases the number of passes on an event.
34. Email delivery is never a precondition for a pass being valid or a person being admissible. Modifying passes requires a secure single-use token, never a matched email address.
35. Host and admin squares carry admission. Free entries carry none.
36. Passes remain valid after the board reaches `CLOSED` and `DRAWN`. Event lifecycle is independent of campaign lifecycle.
37. A claim on a board with an event creates its `EventSupporter` and `AdmissionGrant` in the same transaction as the squares. Activation never has to create the relationship it activates.
38. Activation is guarded by a compare-and-swap on `EventSupporter.status` and enforced by a unique `(eventSupporterId, sequenceNumber)`. Concurrent confirmation of two squares in one batch mints `declaredCount` passes, never twice that.
39. A host-entry square prepares and activates its supporter in one transaction, keyed on the host's own email. The host is subject to the same allowance ceiling as any supporter. `declaredCount` starts at 0, so a host square mints no passes until she declares.
40. `sequenceNumber` is monotonic per supporter and never reused. `void` is terminal: a voided pass and its token never return to `active`, so a previously shared QR can never become valid again. The displayed ordinal is derived from current usable passes and is never the sequence number.
41. `declaredCount` may never be reduced below the number of `used` passes. Such a request is rejected, not clamped.

---

## 10. Before writing code

**Done.** The document-first rule is satisfied and the source documents now carry this, rather than a companion file contradicting them:

| Document | Contains |
|---|---|
| `fundraiser-money-state-machine.md` | Invariant 16 amended in place. Pointer to invariants 23–41 |
| `fundraiser-board-v2.md` | §2 files · §5 event block · §6 attendance step, confirmation, passes · §6A auth · §6B volunteer surface and QR · §9 event panel · §11 locked terms · §16 slices |
| `SYSTEM-FLOW.md` | Pointer, the four-effect confirm correction in §4, new tables in §7 |
| This document | Model, schema, invariants 23–41 |

An earlier draft of this section pointed at SYSTEM-FLOW sections 3, 4, 5, and 7. That was wrong: SYSTEM-FLOW documents the Game Day app and has never covered fundraisers. **v2 is the flow authority for fundraiser boards.**

The SYSTEM-FLOW fundraiser backfill remains outstanding, is logged in v2 §17, and is not a blocker.

---

## 11. Open questions

1. **What happens to an event on a board that closes with zero contributions?** Assumed: no supporters exist, roster is empty, event is a no-op.
2. **What does the picker show a supporter whose allowance is fully spent?** Assumed: the copy in §3, with a link to manage passes rather than a disabled control. Copy decision, not a model decision.

---

*End of addendum. Frozen at demo scope.*
