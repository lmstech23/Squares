# Invariant Registry

**Status:** Authority for invariant numbering. **Created at freeze, 2026-09-03.**
**Rule:** every addendum appends to this file in the **same commit** that adds its invariants. A document that adds an invariant without a registry row is not merged.

---

## Why this exists

Three documents independently claimed numbers in the 42–47 range and meant different things by each. Nobody was careless — the money doc's §8B block and the signup addendum were written against different copies, and there was no place to check.

Board v2 §17 already warns *"cite rules by name, never by number"* about `SYSTEM-FLOW.md` rules. This is the same failure arriving in the invariant list. The registry is the fix, and it is cheaper than the convention it replaces.

**Numbers are identifiers, not sort keys.** A document's block need not be contiguous with its section order, and a gap is not a defect.

---

## Resolution applied

| Block | Owner | Change |
|---|---|---|
| 1–22 | `fundraiser-money-state-machine.md` §9 | none |
| 23–33 | `fundraiser-admission-addendum.md` §10 | none |
| 34–47 | `fundraiser-signup-addendum.md` §11 | **none** |
| 48–50 | `fundraiser-money-state-machine.md` §8B | **moved from 42–44** |
| 51–70 | `fundraiser-donations-addendum.md` §4 | was 48–66 |
| 71–90 | `fundraiser-launch-readiness-addendum.md` | was 67–85 |
| 91–109 | `board-collaborators-addendum.md` §10 | was 86–104 |

**The signup block stayed because moving it was fourteen edits against three.** The early bird block is cited twice, both in `fundraiser-board-v2.md` §7.

### Required citation corrections — same commit as this file

| File | Was | Becomes |
|---|---|---|
| `fundraiser-board-v2.md` §7 | "Money doc §8B and invariants 42–44" | invariants **48–50** |
| `fundraiser-board-v2.md` §7 | "sum of `pricePaidCents` on confirmed squares (invariant 43)" | invariant **49** |
| `fundraiser-money-state-machine.md` §8B | its three invariants numbered 42, 43, 44 | **48, 49, 50** |

---

## Registry

Statements are one-line summaries for lookup. **The owning document is authoritative for exact wording.**

### 1–22 · Money doc §9 — core

| # | Statement |
|---|---|
| 1 | `raised` counts confirmed contributions only — never claimed, reserved, or pending |
| 2 | **Amended (§51 block).** `prizePool = prizePoolPercent × prizeBasisCents`; donations never enter the basis |
| 3 | A reserved cash square contributes $0 and holds no ticket |
| 4 | `CONFIRMED` is terminal; a confirmed square never returns to `open` |
| 5 | No refund state, transition, or host action exists |
| 6 | A cash reservation expires at the earlier of the cash-hold window or campaign close |
| 7 | Card batches confirm atomically; cash batches resolve per square |
| 8 | Ticket number = square position for paid entries; free entries use the `F` sequence |
| 9 | Drawing eligibility activates in the same transaction as the flip to `paid` |
| 10 | `(boardId, ticketNumber)` is unique |
| 11 | The draw cannot run while any square is `reserved_cash` or `pending` |
| 12 | The draw is idempotent; a second call returns 409 |
| 13 | `finalPrizePoolCents` never changes once written, including for disputes |
| 14 | Prize tiers sum exactly to the finalized pool |
| 15 | **Extended (§100).** Host and admin squares count toward `raised` but never receive an active drawing ticket |
| 16 | **Amended (§72).** Terms lock after the first confirmed **square** contribution |
| 17 | Free entries never occupy a square or move the fundraising meter |
| 18 | A `pending` square carries a server-set `holdExpiresAt`; the Stripe session is resolved before any release |
| 19 | A `pending` square may be manually released only after `holdExpiresAt`, and only via the resolution sequence |
| 20 | Payment always wins before release and before finalization |
| 21 | **Amended (§64).** Finalization cannot occur while any square **or contribution** is unresolved |
| 22 | Paid ticket numbers may have gaps; contiguity is never asserted |

### 23–33 · Admission addendum §10

| # | Statement |
|---|---|
| 23 | An admission pass never grants a drawing ticket, and a drawing ticket never grants admission |
| 24 | One confirmed square mints exactly one pass, unless its grant has `donateAdmissions` |
| 25 | Passes are minted in the same transaction that flips their square to `paid` |
| 26 | There is no pending pass state |
| 27 | **Amended (§9, launch readiness).** A claim creates its `EventSupporter` and `AdmissionGrant` in the same transaction as the squares; the grant keys on `contributionId` |
| 28 | `sequenceNumber` is monotonic per supporter and never reused; `void` is terminal |
| 29 | A pass is consumable once; undo restores it and creates no entitlement |
| 30 | Concurrent confirmation is guarded by CAS on supporter status and unique `(eventSupporterId, sequenceNumber)` |
| 31 | Supporter status is a one-way latch |
| 32 | Check-in staff consume entitlement and never create it |
| 33 | Email delivery is never a precondition for a pass being valid |

### 34–47 · Signup addendum §11

| # | Statement |
|---|---|
| 34 | A helper signup grants no square, drawing entry, pass, or check-in authority |
| 35 | Only a supporter with `status = active` may claim a slot; eligibility is derived, never stored |
| 36 | **Amended (§3.7, launch readiness).** Volunteer interest records intent only and requires no sheet, slot, role, or token |
| 37 | A `pending` or `reserved_cash` contribution grants no sign-up access |
| 38 | Slot capacity and commitment uniqueness are enforced by single-table unique indexes |
| 39 | Quantity is never stored; it is the count of position rows |
| 40 | Cancellation deletes positions and frees the numbers; every action writes a `SignupLog` row |
| 41 | Check-in authority originates only from a host-issued `CheckinStaffAccess` link |
| 42 | A supporter with at least one helper signup is never deleted by cleanup |
| 43 | Sign-Up Sheets exist only on board-linked events; `Event.boardId` stays required |
| 44 | A reversed contribution removes future eligibility and flags existing signups; never deletes them |
| 45 | Email delivery is guarded by unique `(notificationType, dedupeKey)` and by send status |
| 46 | A delivery attempt holds an expiring lease identified by a per-claim fencing token |
| 47 | Every helper signup belongs to an `active` supporter; a host appears only by contributing |

### 48–50 · Money doc §8B — early bird *(renumbered from 42–44)*

| # | Statement |
|---|---|
| 48 | `Square.pricePaidCents` is written the moment a square leaves `open` — at claim or at cash reservation — and is **never recomputed**. Price is fixed when the square is taken, not when the money arrives. |
| 49 | **Amended (§51 block).** `prizeBasisCents` is the sum of `pricePaidCents` on confirmed squares, never a count × price |
| 50 | The price schedule is a boundary in **time**, evaluated once per claim. It is never a function of how many squares have sold, so no counter, lock, or ordering guarantee is required. |

> **48 and 50 were the only unfilled rows in this registry. They are now filled**, transcribed verbatim from `fundraiser-money-state-machine.md` §9, subsection *Pricing (invariants 48–50)*, on 2026-09-03.
>
> **The placeholder hints were transposed.** Row 48's hint read *"early bird changeover rule"* and row 50's read *"price fixed at claim, not at payment"* — but under the renumbering 42→48, 43→49, 44→50, invariant 48 is the price-fixed-at-claim rule and invariant 50 is the time-boundary rule. Row 49, which was already filled, corroborates the ordinal mapping. The verbatim text below follows the mapping; the hints did not survive it.

### 51–70 · Donations addendum §4

| # | Statement |
|---|---|
| 51 | `Contribution` is the money primitive; every counted dollar belongs to exactly one row |
| 52 | `totalPaidCents = squareAmountCents + donationAmountCents`, enforced by CHECK |
| 53 | On a confirmed contribution, `squareAmountCents` equals the sum of its squares' `pricePaidCents` |
| 54 | A confirmed contribution's amounts never change |
| 55 | A donation claims no square and never changes square availability |
| 56 | A donation never produces a drawing ticket or enters the eligible pool |
| 57 | `prizeBasisCents` counts confirmed square money only; prize math never reads `raisedCents` |
| 58 | Terms lock on the first confirmed square contribution; donations lock nothing |
| 59 | A mixed checkout is one Stripe session and one `Contribution`; both portions confirm together or not at all |
| 60 | An expired hold on a mixed checkout charges nothing; there is no split outcome |
| 61 | There is no partial-success payment state |
| 62 | Session `amount_total` must equal `totalPaidCents` at confirmation |
| 63 | Confirmation is idempotent by conditional update on `status = 'pending'` |
| 64 | A donation-only contribution has no hold, no `holdExpiresAt`, and no countdown |
| 65 | A cash donation has no reserved state; it is recorded confirmed in one host action |
| 66 | Donations stop when the board leaves `OPEN` |
| 67 | `CLOSING` resolves every pending contribution against Stripe before finalization |
| 68 | `finalRaisedCents`, `finalPrizeBasisCents`, `finalPrizePoolCents` are written together and are immutable |
| 69 | A donation-only contributor becomes an `active` `EventSupporter` with zero grants where an event exists |
| 70 | **Cash-donation void:** owner or manager, `OPEN` only, logged, terminal, never deleted. No other type has one |

### 71–90 · Launch readiness addendum

| # | Statement |
|---|---|
| 71 | A square may be claimed only when `effectivePrice(board, now)` returns a value |
| 72 | Effective price reads early bird or regular; no third source, inference, copy, or fallback |
| 73 | A null effective price pauses square sales; donations and existing claims are unaffected |
| 74 | Paused is derived at read time and never stored |
| 75 | `pricePaidCents` and `priceSource` are written together when a square leaves `open` |
| 76 | Early bird and regular prices lock independently, each at its first confirmed square |
| 77 | A regular price, once set, is strictly greater than the early bird price |
| 78 | Every pre-lock price change is recorded in `priceHistory` and shown in the public audit |
| 79 | A fundraiser carries at least one configured price at all times, enforced by CHECK |
| 80 | Dietary attributes belong to `EventSupporter`, never a grant, pass, or contribution |
| 81 | Dietary attributes are never entitlement |
| 82 | Dietary questions are asked only when the contribution will mint ≥1 pass and collection is on |
| 83 | Null means never answered and is distinct from false |
| 84 | Dietary answers describe a supporter's party, not individual attendees |
| 85 | Volunteer interest is an `EventSupporter` attribute requiring no sheet, slot, role, or token |
| 86 | Interest confers nothing; it selects who receives a link and nothing else |
| 87 | Interest is additive by implicit signal and removable only by explicit action |
| 88 | Interest may be recorded on a `pending` supporter and dies with it |
| 89 | Volunteer follow-up is email only at launch; no SMS or A2P dependency is introduced |
| 90 | Interest is stored and filtered only; no automated delivery, and sheet edits never send |

### 91–109 · Board collaborators addendum §10

| # | Statement |
|---|---|
| 91 | Board authorization is determined solely by an active `BoardCollaborator` row |
| 92 | Every board has exactly one active `OWNER`, enforced by partial unique index |
| 93 | Authorization is read live on every request; no role is cached |
| 94 | No grant → 404. Grant without capability → 403 |
| 95 | Capabilities are checked, never roles; the mapping lives in one place |
| 96 | An invite link is an invitation, never an authorization |
| 97 | `acceptedAt` is set once, conditionally, in the collaborator-creating transaction |
| 98 | An invite may be accepted only by an authenticated host, and only by the bound identity when set |
| 99 | An expired, revoked, or accepted invite cannot produce a collaborator row |
| 100 | `OWNER` is not an invitable role |
| 101 | An owner or manager's own contribution sets `isHostEntry` and is never drawing-eligible |
| 102 | `recordedByHostId` and `isHostEntry` are independent and never derived from each other |
| 103 | Every host- or manager-recorded or -confirmed contribution stores actor and timestamp |
| 104 | A walk-up contribution satisfies every invariant a contributor-initiated one does |
| 105 | Walk-up recording is blocked when the board is not `OPEN`, and for squares when sales are paused |
| 106 | A MANAGER cannot close, draw, alter finalized totals, change payout destination, set locked terms, delete, manage collaborators, or transfer ownership |
| 107 | Revocation terminates authorization on the next request |
| 108 | Revocation never alters or deletes historical records; nothing cascades from a collaborator row |
| 109 | `revoked` is terminal; re-granting creates a new row |

---

## Environment invariants — E1–E5

**Not product invariants. They consume no number from the registry above and are never cited as invariant N.** They constrain how the repository is operated, and they are recorded here because this is the file every implementer reads first.

**E1 — Local development never points at the production database.**
`DATABASE_URL` in `.env` / `.env.local` must not resolve to the production Supabase project. Discovered at Gate 2: local holds `sk_test_` while `DATABASE_URL` is identical to production, which means a test-mode checkout writes `cs_test_` session ids into production rows, and `prisma migrate dev` from a laptop would reset the production database with no warning that anything unusual was happening.

**E2 — Stripe mode and database must agree.**
A `sk_test_` key paired with the production database, or `sk_live_` paired with a development database, is prohibited. The pairing is checked, not assumed.

**E3 — Migration development happens against a non-production database.**
The A1 backfill runs against 40 real `batch_id` rows on a database with no preview tier and no alias rollback. It is rehearsed on a copy first.

**E4 — The Stripe API version is pinned in the shared client.**
STATUS.md records a prior incompatibility — the `2026-01-28.clover` webhook v2 rewrite — under bugs fixed. An unpinned client on a live account can reproduce that class of break from a dashboard-side change, with no deploy and no warning.

**E5 — Card-path tests are never reported as passing in an environment that cannot run them.**
Environment-blocked tests are marked `REQUIRED — ENVIRONMENT BLOCKED, NOT EXECUTED`. Never skipped, never green, never dropped from the suite. They gate release, not merge.

---

## Adding an invariant

1. Take the next free number from the end of the registry. **Never renumber an existing block.**
2. Add the row here and the full statement in the owning document, in one commit.
3. Amending an existing invariant does not consume a new number — mark the row `**Amended (§X)**` and point at the amending document.

*Next free number: **110**.*
