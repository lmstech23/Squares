# Fundraiser Donations — Addendum

**Status:** **READY FOR FREEZE** — product decisions applied. Invariants 51–70.
**§13 amended after freeze:** the no-backfill premise was false against the production database. Timing decision unchanged; backfill and correctness gate restored. Re-approve §13 only.
**Version:** 2.2 — cash-void representation resolved; §13 premise corrected against production preflight
**Companion to:** `fundraiser-money-state-machine.md` (authority on money) · `fundraiser-board-v2.md` (authority on flows) · `fundraiser-admission-addendum.md` (authority on passes) · `fundraiser-signup-addendum.md` (authority on helpers)

Adds donation-only and mixed contributions to fundraiser boards, and promotes `Contribution` to the money primitive that squares hang off.

---

## Rule of this document

Adds **money that buys nothing**. Does not change the square state machine, the hold-and-release sequence, the draw, or admission entitlement.

This document **amends money doc invariants 2, 16, 21, and 43**, amends admission addendum §4 and §5, and adds new invariants. Where it disagrees with the money doc on square behavior, the money doc wins and this document is wrong. Where it disagrees with the admission addendum on passes, the admission addendum wins.

**One thing here is genuinely new and not a derivation: the cash-donation void in §7.** It is approved, and §7 states its four limits explicitly so it is not widened later. Everything else in this document falls out of rules already signed off.

---

## 0. Invariant numbering — resolved

**The collision is closed and `invariant-registry.md` is the authority.** Numbers are identifiers, not sort keys; contiguity within a document is not a property worth rewriting citations for.

| Block | Owner | Change |
|---|---|---|
| 1–22 | Money doc §9 core | none |
| 23–33 | Admission addendum | none |
| 34–47 | Signup addendum | **none** — keeps its contiguous block |
| **48–50** | Money doc §8B early bird | **moved from 42–44** |
| **51–70** | This document | was 48–66 |
| **71–90** | Launch readiness addendum | was 67–85 |
| **91–109** | Board collaborators addendum | was 86–104 |

**Why the money doc moved rather than the signup addendum.** Cheapest churn wins: the signup block is fourteen contiguous invariants cited throughout its own document, while the early bird block is three, cited twice — both in `fundraiser-board-v2.md` §7. Two string edits against fourteen.

**Two citations in `fundraiser-board-v2.md` §7 must be corrected in the same commit:**

| Was | Becomes |
|---|---|
| "Money doc §8B and invariants 42–44" | invariants **48–50** |
| "sum of `pricePaidCents` on confirmed squares (invariant 43)" | invariant **49** |

**The registry is a precondition for implementation**, not a follow-up. Every addendum appends to it in the same commit that adds its invariants.

---

## 1. The rule

```
money → square → position, drawing eligibility, admission
money → donation → nothing but the money
```

A donation is a contribution that claims no square. It is not a smaller square, not a square without a number, and not a square that failed. It is a separate kind of money that lands in the same total.

### One checkout may carry both

```
5 squares × $10       $50
Extra donation        $25
                     ─────
Total                 $75
```

Internally this stays three numbers, never one:

```
squareAmountCents      5000
donationAmountCents    2500
totalPaidCents         7500
```

Collapsing these into a single paid amount is the failure this document exists to prevent. Once collapsed, the prize basis cannot be recovered, the host's breakdown cannot be reconstructed, and the split has to be re-derived from square counts — which is the `squares × price` arithmetic the money doc and board v2 both already forbid, arrived at from a new direction.

---

## 2. Vocabulary

| Term | Meaning |
|---|---|
| **Contribution** | One person's one payment. The money primitive. Carries a square portion, a donation portion, or both |
| **Square contribution** | The portion of a contribution that claims squares. Behaves exactly as the money doc defines |
| **Donation** | The portion of a contribution that claims nothing |
| **Donation-only contribution** | `squareAmountCents = 0`. No squares, no batch, no hold |
| **Mixed contribution** | Both portions non-zero. One session, one record |
| **`raisedCents`** | Confirmed square money **+** confirmed donation money. The public number |
| **`prizeBasisCents`** | Confirmed square money **only**. What prize math multiplies against |

### A naming trap, and it is already live

The thread that produced this feature proposed a host breakdown reading **"Ticket sales / Donations."** That wording cannot ship.

Board v2 §6 fixes this: **never say "ticket" on a no-prize board.** Admission addendum §2 fixes the UI vocabulary as Square / Drawing Ticket / Admission Pass, and forbids calling a pass a ticket anywhere a human reads it. A no-prize Phase A board has no tickets at all — tickets exist only when `prizePoolPercent > 0` (money doc §5).

**Internal name is `squareAmountCents` on every board.** Display is conditional:

```
no-prize board     Square sales        $3,500
prize board        Square sales        $3,500
```

The same phrase on both, because the square is the thing bought in either case, and the drawing ticket is derived from it rather than sold separately. There is no board on which "ticket sales" is the correct label for this number.

---

## 3. Amendments to existing invariants

Each of these is a rewrite of a signed-off line. They are stated in full so the diff is reviewable rather than described.

### Invariant 1 — unchanged, and stays true by construction

> `raised` counts confirmed contributions only. Never claimed, reserved, or pending.

Still literally correct once `Contribution` is the record being counted. No amendment needed. Worth stating so nobody "fixes" it.

### Invariant 2 — amended

> **Was:** `prizePool = prizePoolPercent × raised`, confirmed only.
>
> **Becomes:** `prizePool = round(prizePoolPercent × prizeBasisCents / 100)`, where `prizeBasisCents` is the sum of confirmed **square** money only. Donations never enter the prize basis. `raisedCents` is `prizeBasisCents` plus confirmed donation money, and prize math never reads it.

**Why.** Under the unamended rule, a $100 donation from someone who wants no ticket increases the prize money paid to people who do hold tickets. That is not a rounding artifact — at a 20% pool it moves the whole ladder, and it moves it in favor of entrants using money given by a non-entrant.

It also breaks the story board v2 §13 tells the landing page: *"prizes grow as the board fills."* Under the unamended rule prizes grow when anyone gives anything, which is a different and less legible promise.

**A question for whoever handles compliance posture, not a claim made here:** a prize funded in part by people who are not entrants changes the relationship between what entrants paid and what is on offer. The amended rule keeps the basis exactly equal to entrant money, which is the conservative shape. Worth confirming before a prize board with donations enabled ever runs.

### Invariant 16 — amended

> **Was:** After the first confirmed contribution, these are locked: square count, contribution price, prize on/off, prize percent, tier count, drawing rule, drawing date. *(Plus event date, per admission addendum §10. Plus the early bird fields, per money doc §8B.)*
>
> **Becomes:** After the first confirmed **square** contribution, these are locked: *(same list)*. A confirmed donation-only contribution locks nothing.

**Why.** The lock protects people who bought into a stated deal. Its subject is the deal — square count, price, prize percent, drawing date. A donor bought into none of those. Under the unamended rule, a $20 donation on day one freezes the entire configuration of a board on which not one square has sold, and the host discovers it when she tries to correct a typo in the square price.

**The obvious objection, and why it doesn't hold.** *A donor gave under a stated set of terms too.* What she gave under is the cause, and the cause is protected by a different mechanism: title changes are recorded in `titleHistory` and displayed in the public audit (board v2 §11). Nothing in the invariant 16 list changes what her money does. And because donations never enter the prize basis, a host turning prizes on after a donation lands cannot route that donor's money into a prize.

### Invariant 21 — amended

> **Was:** Finalization cannot occur while any square is `pending` or `reserved_cash`. `CLOSING` reconciles every outstanding payment against Stripe before `finalRaisedCents` is written.
>
> **Becomes:** Finalization cannot occur while any square is `pending` or `reserved_cash`, **or while any `Contribution` is `pending`**. `CLOSING` reconciles every outstanding payment session against Stripe — square batches and donation-only sessions alike — before `finalRaisedCents`, `finalPrizeBasisCents`, and `finalPrizePoolCents` are written.

**Why.** A donation-only checkout in flight at the cutoff is neither a pending square nor a reserved cash square. Under the unamended rule the assertion passes with live money unresolved, and the case money doc §7 was written to eliminate reappears through a door it doesn't cover.

### Invariant 49 — amended

*(Money doc §8B, renumbered from 43 — §0.)*

> **Was:** The raised figure is the sum of `pricePaidCents` on confirmed squares, never a count multiplied by a price.
>
> **Becomes:** `prizeBasisCents` is the sum of `pricePaidCents` on confirmed squares, never a count multiplied by a price. `raisedCents` is the sum of `totalPaidCents` on confirmed contributions. Neither is ever derived from a square count.

The original guarantee is preserved intact — it simply now names the basis rather than the public figure, which is where it was always doing its work.

### Invariants 4, 5, 13, 15, 17, 24, 31 — unchanged, scope clarified

| Invariant | Clarification |
|---|---|
| 4 — CONFIRMED is terminal | Extends to donations. See §7 for the one proposed carve-out |
| 5 — no refund state or action | Extends to donations without modification |
| 13 — final amounts immutable | Now three fields, written together. See §8 |
| 15 — host squares count, never win | Unaffected. A host donation also counts and also wins nothing, trivially |
| 17 — free entries move no money | Unaffected. A free entry is still not a donation |
| 24 — one confirmed square, one pass | Unaffected. A donation is not a square, so it mints nothing. See §9 |
| 31 — supporter status is a one-way latch | Unaffected. Donation confirmation is a new way to reach `active`, not a way to leave it |

---

## 4. New invariants

**51–70.** Registered in `invariant-registry.md`.

**Ledger**

51. `Contribution` is the money primitive. Every dollar the system counts belongs to exactly one `Contribution` row. `raisedCents` is computed from contributions, never from squares.
52. `totalPaidCents = squareAmountCents + donationAmountCents`, enforced by CHECK constraint at write. Both portions are `>= 0` and at least one is `> 0`.
53. On a confirmed contribution, `squareAmountCents` equals the sum of `pricePaidCents` on its confirmed squares. This is assertable at any time and is the reconciliation between the ledger and the grid.
54. A confirmed contribution's amounts never change. Square economics remain immutable exactly as money doc invariants 4 and 13 require.

**Separation**

55. A donation claims no square, holds no square, and never changes square availability or the open count.
56. A donation never produces a drawing ticket and never enters the eligible draw pool. A donation-only contributor is absent from the ticket pool entirely, not present with zero tickets.
57. `prizeBasisCents` counts confirmed square money only. Prize math reads the basis and never reads `raisedCents`.
58. Terms lock on the first confirmed **square** contribution. A board holding only confirmed donations has unlocked terms.

**Payment**

59. A mixed checkout is exactly one Stripe Checkout Session and exactly one `Contribution`. Its square portion and its donation portion confirm together or not at all.
60. When a hold expires on a mixed checkout, the session is expired before anything is released, and nothing is charged. There is no path in which the donation succeeds and the squares release, or the reverse.
61. There is no partial-success payment state. `Contribution.status` is `pending` · `confirmed` · `released` — three payment-lifecycle values, and no fourth may be added. **Void is not a status.** It is an administrative correction represented by `voidedAt`, `voidedByHostId`, and `voidReason` on a contribution that remains `confirmed`.
62. At confirmation, the Stripe session's `amount_total` must equal `totalPaidCents`. A mismatch does not confirm, does not release, and raises. Amounts are authoritative from the `Contribution` row, never read back from the session.
63. Confirmation is idempotent by conditional update on `status = 'pending'`. A replayed webhook matches zero rows, acknowledges, and changes nothing.
64. A donation-only contribution has no hold, no `holdExpiresAt`, and no countdown. Nothing is being held, and a timer that implies otherwise is a lie.

**Cash**

65. A cash donation has no reserved state. It is recorded confirmed in one host action, attributed to the recording host, and logged. There is no cash-donation hold, expiry, or release.

**Close**

66. Donations stop when the board leaves `OPEN`. No contribution may be created and no session started at `closing`, `closed`, or `drawn`.
67. `CLOSING` resolves every pending contribution against Stripe using the same resolution sequence as square batches — paid confirms the whole contribution, unpaid expires the session first and then releases. `CLOSING` does not advance while any contribution is `pending`.
68. `finalRaisedCents`, `finalPrizeBasisCents`, and `finalPrizePoolCents` are written in one transaction and are immutable. `finalPrizePoolCents = round(prizePoolPercent × finalPrizeBasisCents / 100)`.

**Identity**

69. A donation-only contributor becomes an `EventSupporter` where an event exists and an email was captured, with status `active` and zero `AdmissionGrant` rows. Supporter existence never implies entitlement of any kind.

**Cash void**

70. A cash donation may be voided by **any currently authorized OWNER or MANAGER holding `cash.void`**, while the board is `OPEN`, with actor, timestamp, and reason recorded. The voiding user need not be the user who recorded it. Void sets `voidedAt` and never changes `status` or any amount; the row is never deleted; `voidedAt` is write-once. A voided contribution is excluded from `raisedCents` and remains excluded permanently. Void is structurally unavailable to any contribution that is not a confirmed cash donation, and unavailable from the moment `CLOSING` begins.

---

## 5. The Contribution ledger

### Shape

```
                    Contribution
                   /            \
        Square × N                (donation portion — no child rows)
             │
        AdmissionGrant ──▶ AdmissionPass × N
```

A donation portion is an integer on the contribution. It has no child records because it entitles nothing. Resisting the urge to give it a table is what keeps this small.

### Contribution

| Field | Type | Notes |
|---|---|---|
| `id` | String | **Is the batch identity.** Replaces `Square.batchId` |
| `boardId` | String | |
| `status` | enum | `pending` · `confirmed` · `released`. **Payment lifecycle only — never `voided`** |
| `paymentMethod` | enum | `card` · `cash` |
| `squareAmountCents` | Int | Default 0 |
| `donationAmountCents` | Int | Default 0 |
| `totalPaidCents` | Int | CHECK equality with the two above |
| `checkoutSessionId` | String? | **Unique where not null.** Card only |
| `holdExpiresAt` | DateTime? | Null on donation-only and on cash |
| `contributorName` | String | |
| `contributorEmail` | String? | Required for card. Optional for cash donations — see §10 |
| `contributorPhone` | String? | |
| `isHostEntry` | Boolean | Default false. Money doc invariant 15 |
| `displayAnonymous` | Boolean | Default false. **Reserved, unused in this phase** — see §10 |
| `confirmedAt` | DateTime? | |
| `releasedAt` | DateTime? | |
| `recordedByHostId` | String? | Cash only. Who entered the record. **Split from confirmation — see board collaborators addendum §8** |
| `voidedAt` · `voidedByHostId` · `voidReason` | | Cash-donation void, §7. `voidedAt` is write-once. Null on every other contribution |
| `confirmedByHostId` | String? | Cash only. Who confirmed receipt. May differ from the recorder once managers exist |

### Constraints

```
Contribution.checkoutSessionId        unique where not null
Square.contributionId                 FK → Contribution.id, nullable while open
AdmissionGrant.contributionId         unique where not null
CHECK (total_paid_cents = square_amount_cents + donation_amount_cents)
CHECK (square_amount_cents >= 0 AND donation_amount_cents >= 0)
CHECK (square_amount_cents > 0 OR donation_amount_cents > 0)
CHECK (payment_method = 'cash' OR contributor_email IS NOT NULL)
CHECK (donation_amount_cents = 0 OR board_type_is_fundraiser)  -- see note
```

The last needs a denormalized flag or a trigger, since `boardType` lives on `Board`. Simplest correct version is API-level plus a periodic assertion; a Game Day board must never accumulate donation money, because nothing downstream of Game Day knows what to do with it.

### How the three cases relate

| | `squareAmountCents` | `donationAmountCents` | Squares | Hold | Countdown |
|---|---|---|---|---|---|
| Square purchase | > 0 | 0 | N | Yes | Yes |
| Donation-only | 0 | > 0 | 0 | No | **No** |
| Mixed | > 0 | > 0 | N | Yes | Yes |

The hold exists because squares are inventory. The donation rides on the hold when squares are present and has none when they aren't. This is the entire behavioral difference and everything else follows from it.

### Cleanup must key on status, never on square presence

The admission addendum §4 keys orphan cleanup on **"the grant has no live squares."** That rule, applied unchanged to this model, **deletes every pending donation-only contribution**, because a donation-only contribution has no live squares by definition and never will.

**Amend it: cleanup keys on `Contribution.status = 'released'`.** A `confirmed` contribution is never touched. A `pending` one is never touched, because a pending contribution by definition still has a live payment path and releasing is the resolution sequence's job, not the cleanup's.

This is strictly better than the original rule and it also fixes the case admission §4 called out as the one a release-keyed cleanup cannot see — squares re-batched onto a new contribution, leaving the older one holding nothing. Under status-keying, that older contribution is released by the merge, and cleanup finds it for the ordinary reason.

---

## 6. Card payment behavior

### Amount entry

```
[ $10 ]  [ $25 ]  [ $50 ]  [ $100 ]  [ Other ]
```

**Minimum card donation is $5.** Below that, Stripe's per-transaction cost consumes most of the gift and the host nets under a dollar. Enforced server-side, not only in the picker. Cash donations have no minimum — the host is recording money already in her hand.

Presets are `$10 / $25 / $50 / $100`, with `Other` opening a free amount field. `Other` is a peer option, not a smaller link: the person giving $250 should not have to hunt for it.

### Donation-only

```
enter amount → Contribution created pending → one Checkout Session
    → checkout.session.completed → status = confirmed, raised increases
    → abandoned → session expires → status = released
```

No squares move. No inventory is touched. No countdown is shown, because nothing is being held and showing one manufactures urgency for a scarcity that doesn't exist (invariant 64).

The session must still be actively resolved rather than left to sit, for two reasons: a contribution stuck `pending` forever will stall `CLOSING` under amended invariant 21, and the host's in-flight number would drift upward permanently. The existing cron does this — it gains a branch for contributions with no squares.

### Mixed — one atomic session

**One Stripe Checkout Session, two line items.** The squares' `holdExpiresAt` governs the whole session, because the squares are the only part with inventory behind them.

```
hold expires → query the session
  status = complete / paid  → confirm the whole Contribution
                              squares → paid, donation counted
  status = open / unpaid    → POST /v1/checkout/sessions/{id}/expire
                              THEN release squares AND mark Contribution released
```

This is money doc invariant 18's sequence, unchanged, applied to a record that now carries a donation portion. Nothing new enters the state machine.

**The rejected alternative, stated so it doesn't get re-proposed.** Letting the donation survive when the squares release requires a second payment intent, a partial-success state, a reconciliation path between two sessions that can each fail independently, and an answer to "what does the confirmation email say." It buys a $25 recovery in a case that is already rare. Invariant 61 forbids it, and it is forbidden on purpose.

**Required copy at checkout, wording TBD:**

> This is one payment. If your hold expires, nothing is charged — including the extra donation.

And on release, extending the existing release message rather than adding a second one:

> Your squares were released and nothing was charged. Claim them again?

### Webhook implications

| Change | Detail |
|---|---|
| Lookup key | `Contribution.checkoutSessionId`, not batch id |
| Branch | Donation-only sessions have zero squares to flip. The handler must not assume a square set |
| Amount check | Assert `amount_total == totalPaidCents` before confirming (invariant 62) |
| Idempotency | `UPDATE ... WHERE status = 'pending'`; zero rows affected means already handled — ack, do nothing |
| New traffic | `checkout.session.expired` now arrives for donation-only sessions with no squares attached |
| Order | Square flips, supporter activation, and pass minting all stay inside the one confirmation transaction |

---

## 7. Cash donations

### The flow

One host action. Amount, name, optional contact. Recorded `confirmed` immediately, `paymentMethod = cash`, `recordedByHostId` set, logged.

There is no reserve step because there is nothing to reserve. The reserve→confirm pattern exists for cash squares because a square is inventory that must be held off the board while the parent goes to get the money. A cash donation holds nothing, so a hold would be a state with no purpose and an expiry with nothing to expire.

### The trust model, and why it is safe here specifically

A cash square has a counterpart artifact — a square that visibly turns green, on a public grid, that a contributor can point to. A cash donation has none. The host is asserting that money exists, and the host is the beneficiary of the number going up.

**The reason this is acceptable is invariant 57.** A cash donation cannot reach the prize basis. A host inflating cash donations inflates only the public raised figure — a vanity number that costs her credibility if it's wrong — and cannot move one dollar into a prize pool she or her family might win. If donations fed the prize basis, host-recorded cash donations would be an unsupervised path from a host's assertion to a prize she could win, and this section would have to say no.

That is worth writing down because it is the load-bearing reason, and someone reconsidering invariant 57 later needs to see what else it is holding up.

### The void — approved

**Money doc invariant 4 has no correction path, and cash donations are the one place that becomes an operational problem.** A host types $500 instead of $50. There is no square to release. Under invariants 4 and 54 as written, the board's raised figure is wrong forever and the host's only recourse is a support request.

**Approved. The carve-out is narrow and it is the only one:**

> A cash donation, and only a cash donation, may be **voided** by any currently authorized OWNER or MANAGER holding `cash.void`, while the board status is `OPEN`. A voided contribution is excluded from `raisedCents`, is never deleted, and records actor, timestamp, and reason. Void is terminal. It is unavailable from the moment `CLOSING` begins.

**The voiding user need not be the recorder.** An earlier draft said "the recording host," which would mean a mis-keyed amount could only be corrected by whoever typed it — so a host at the table on Saturday would have to find the manager who entered it on Thursday. The audit trail already answers who did what; requiring the same person to also be the fixer buys nothing and blocks a correction at the moment it is noticed.

### How void is represented — decided

**Void is not a `Contribution.status`.** It is three fields on a contribution that stays `confirmed`:

```
voidedAt        DateTime?   write-once
voidedByHostId  String?
voidReason      String?
```

**Why not a fourth status.** A `confirmed → voided` transition would break two frozen guarantees to model something no processor was ever involved in: invariant 4 makes `CONFIRMED` terminal, and invariant 54 says a confirmed contribution's amounts never change. Under this model both stay literally true — the status does not move, the amounts do not move, and the row is excluded from a total. Void is an administrative correction to a host assertion, not a payment outcome, and the schema should say so.

**The hazard this creates, and the mitigation that is not optional.** `raisedCents` becomes `status = 'confirmed' AND voidedAt IS NULL`. Any query that forgets the second predicate silently returns voided money in a total, and nothing fails loudly.

**One owning scope, and no raw status filter anywhere else.**

```ts
// src/lib/contributions.ts - the only definition of "counts toward raised"
const countsTowardRaised = { status: 'confirmed', voidedAt: null };
```

Every `raisedCents` read, host breakdown, `CLOSING` recomputation, and `finalRaisedCents` write goes through it. Same single-owner pattern as `effectivePrice()` and `getOrCreateSupporterAccessToken()`, and it exists here for the same reason: the failure is silent, so the correctness has to live in one place rather than in everyone remembering.

**Structural guard, so void is unreachable for anything else:**

```sql
CHECK (voided_at IS NULL
       OR (payment_method = 'cash'
           AND donation_amount_cents > 0
           AND square_amount_cents = 0
           AND status = 'confirmed'))
```

Invariant 70's "no other contribution type has a void path" is enforced by the database rather than by API validation, which is one code path away from being bypassed.

**Two things void does not touch.** A cash donation mints no admission passes, so there is nothing to revoke. And a donation never enters `prizeBasisCents`, so voiding one cannot move a prize pool — the same property that made host-recorded cash donations safe to allow at all.

**Why this does not contradict invariants 4 and 5.** Those protect *contributor* money against *host* action and against a refund path that would let money move backward out of the fundraiser. This moves in the opposite direction: it is the host correcting an assertion she alone made, about money no processor ever saw, before anything is final. It touches no square, no ticket, no pass, and no prize basis, so the guarantee that confirmed square economics are immutable is untouched.

**The boundary, stated so it is not widened later.** Void exists for cash donations and nothing else. Not cash squares — those have release. Not card donations — those have a processor and a dispute path. Not after `CLOSING` — finalization is where immutability starts. Invariant 70 states all four limits and none of them are configuration.

Owners and managers both hold it (`cash.void`, collaborators §2), because the person who typed the wrong number is usually the person standing at the table.

---

## 8. Closing

### Donations stop at close. Decided.

No donation may be created and no session started once the board leaves `OPEN` (invariant 66).

**The counter-argument is real and is being rejected on invariant grounds, not on product grounds.** A fundraiser page keeps getting shared after the campaign ends, and *"we're still accepting donations"* is normal fundraiser behavior. But invariant 13 makes `finalRaisedCents` immutable at finalization. A post-close donation would either mutate a number that cannot be mutated, or accumulate into a second figure that never appears in the final total — meaning the public page shows one number and the audit shows another, permanently.

That second option is coherent, but it is a decision about whether the campaign page outlives the board, which is a v3 presentation question (§12). It is not a donation question and it should not be settled inside a donation addendum.

### CLOSING — amended sequence

Money doc §7, with the added step in bold:

1. Resolve every outstanding card checkout for square batches against Stripe.
2. **Resolve every pending donation-only contribution against Stripe.** Same sequence: paid → confirm; open/unpaid → expire the session, then mark released. Query directly; do not wait for webhooks.
3. Resolve outstanding cash squares — unchanged.
4. **Assert zero `pending` squares, zero `reserved_cash` squares, and zero `pending` contributions.** If any remain, `CLOSING` does not advance. Retry.

### CLOSED — finalization

In one idempotent transaction:

5. Recompute `prizeBasisCents` from confirmed squares only
6. Recompute `raisedCents` from confirmed contributions
7. Write `finalPrizeBasisCents` — **new field, immutable**
8. Write `finalRaisedCents` — immutable
9. Write `finalPrizePoolCents` = `round(prizePoolPercent × finalPrizeBasisCents / 100)` — immutable
10. Lock material terms, status `closing → closed`, enable the draw — unchanged

`finalPrizeBasisCents` is not optional. Without it, the prize arithmetic cannot be verified after close from the two stored numbers, because `finalPrizePoolCents / prizePoolPercent` no longer equals `finalRaisedCents`. Someone auditing the board a month later would find what looks like an error.

---

## 9. Admission

Governed by the admission addendum. This section states the interaction and changes two of its mechanisms.

```
donation-only contribution   → 0 passes
mixed contribution           → 1 pass per confirmed square, unaffected by the donation
square contribution          → unchanged, admission addendum §5
```

Invariant 24 needs no rewrite. A donation is not a square, so "one confirmed square mints one pass" already produces zero for it. Stating it here is so nobody helpfully makes donors into attendees.

**The donate-admissions checkbox does not render on a donation-only checkout.** There are no admissions to donate. Rendering it produces a checkbox that does nothing, on the screen where the person has already given the most generous thing available.

### Amendment to admission addendum §5 — supporter activation

Today, `EventSupporter.status` flips to `active` inside the transaction that flips a square to `paid` and mints its pass. A donation-only contribution never flips a square, so under the unamended rule its contributor stays `pending` forever — which silently makes them ineligible for helper signups (signup invariant 35) and leaves a permanently pending row that the cleanup rules then argue about.

**Activation must also fire in the donation-only confirmation transaction:**

```
card:  Stripe webhook  ──┐          contribution → confirmed
                         ├──▶ tx    supporter → active (if not already)
cash:  host records   ───┘          mint 0 passes
```

The compare-and-swap on the supporter row (admission §5) is unchanged and still required — a donation and a square purchase from the same person can confirm concurrently, and only one transaction may do the activation work.

### Amendment to admission addendum §4 and §3

`AdmissionGrant.squareBatchId` becomes `AdmissionGrant.contributionId`, unique where not null. The uniqueness guarantee that makes a retried claim idempotent is preserved unchanged; only the referent is renamed. Invariant 27's wording follows.

---

## 10. Supporter and donor identity

### Where the donor lives

| Board has an event | Result |
|---|---|
| Yes, email captured | `EventSupporter` created or resolved, status `active`, zero `AdmissionGrant` rows, zero passes |
| Yes, cash donation with no email | **`Contribution` only, no supporter.** `EventSupporter.email` is `NOT NULL` (board v2 §6) and cannot be satisfied |
| No | `Contribution` only. The contribution carries the identity |

Identity does not need `EventSupporter` to exist. That table is the *event roster*, and a donor to a board with no event has no roster to be on.

The cash-donation-without-email case is worth naming explicitly because it is the one row in this document where a donor exists in the ledger and nowhere else. That is correct — the host wrote down that Miss Carol handed her $40 at the church, and nothing more is known. Forcing a fake email to satisfy a constraint is worse.

### Signup eligibility — resolved, not deferred

A donation-only contributor **is eligible to claim helper slots.**

This falls directly out of the signup addendum's own rule — *"1 confirmed contribution = eligibility to claim slots"* — and out of its own reasoning, which already establishes that a supporter who donated their admissions stays eligible because *"they aren't attending, but they may still drop supplies."* Someone who gave $100 and took no square is in exactly that position.

No change to signup invariants 35 or 47. Invariant 47's *"a host appears only by contributing"* remains true; a donation is contributing.

### Anonymity — deferred, column reserved

`displayAnonymous` exists on `Contribution`, defaults false, and **nothing reads it in this phase.**

The reason to defer rather than build: the public surface where a donor name could appear does not exist. The public board shows `raised` and, on prize boards, the prize pool (money doc §10). Supporter momentum on a no-prize board is a **count** — "73 supporters so far" — not a list. The public audit lists ticket numbers, and a donor has none (§11). There is currently nowhere for a donor's name to be published, so anonymity has nothing to suppress.

**The rule that applies if a public donor list ever ships:** anonymity suppresses the display name only. Identity is always captured and always visible to the host. There is no anonymous-to-Daali donation — card payments carry an email by necessity, receipts require it, and a dispute with no identity behind it is unresolvable.

---

## 11. Public audit and host reporting

### Public audit — donations do not appear individually

The audit exists for one purpose, stated in board v2 §10: so a contributor can open the link and confirm their number was in the pool before the draw ran. A donor has no number and nothing to verify. Listing donors adds a privacy surface and zero verification value.

Ticket-number eligibility reporting is preserved exactly as specified. Nothing in this document changes it.

### One required addition to the public audit on prize boards

The prize basis line is **required**, not optional:

```
Raised                    $4,250
Prize basis               $3,500     square contributions only — donations do not fund prizes
Prize pool  20%             $700
```

Without it the arithmetic visibly fails. A contributor reading `$4,250 raised` and `20%` computes $850, sees $700, and concludes the host took something. One line prevents an accusation that would otherwise be entirely reasonable to make.

On a no-prize board there is no basis and no percent, so this block does not render and the public page shows the single raised figure as it does today.

### Host dashboard — four numbers

```
Square sales      $3,500
Donations           $750
─────────────────────────
Raised            $4,250

Prize basis       $3,500        (prize boards only)
```

Plus the existing state breakdown from money doc §10, unchanged. Note the naming rule from §2 — this reads "Square sales" on every board type.

Every one of these is derivable from `Contribution` with a single grouped query. That is the payoff for making it the primitive.

### Public page — decided

**No-prize boards show total raised only.** No breakdown, no donation line, no square-sales line. This is board v2 §10 unchanged, and it is the Phase A behavior.

**Prize boards show the three-line block above**, because without it the percentage arithmetic visibly fails. That block is required, not optional, and it arrives with prizes in Phase B — not at launch.

---

## 12. Prize boards versus no-prize boards

### The mechanical rule

Donations do not increase the prize basis (invariant 57) and do not affect ticket availability (invariant 55). This is restated here because it is the sentence most likely to be re-litigated by someone who thinks a bigger prize pool sounds better.

### On a prize board, donating is dominated by buying a square

With squares available, a $50 donation and a $50 square cost the same and the square additionally yields a drawing ticket and an admission pass. Nobody informed donates instead. Expect the donation line on a prize board to be small and to come almost entirely from two cases:

1. **Sold out.** Zero open squares, and the only remaining way to give is to give.
2. **"I don't care about the board, here's $100."** Real, and the reason this feature was requested.

**Consequence for the UI:** on a prize board with squares open, the donate action is subordinate to the square action. When open squares reach zero, **it becomes primary.** That is cheap to build and it is the difference between a full board earning nothing more and a full board that keeps going.

**A third case, added by the launch readiness addendum.** When square sales are **paused** for a missing regular price, donations are the only working path on the board and the donate action becomes primary for the duration. This is the same promotion as sold-out, triggered by a different condition, and it is what keeps a paused board from being a dead end. Because `Contribution` ships at A1, the donate path exists whenever a pause can occur, so a paused board always has a working action.

### On a no-prize board, this is the main event

Phase A boards have no prize, no draw, and no ticket. The only thing a square buys is a position on a grid and, where there is an event, admission. For a supporter who is not attending and does not care about the grid — the out-of-town aunt, the parent who already gave at the last one — the square is friction, not product.

**Donations are what make the no-prize fundraiser a real product rather than a prize board with the fun removed.** Board v2 §6 already worries about this, requiring that the no-prize board *"must not read as the diminished version."* A donate path is a substantive answer to that requirement rather than a copy-level one.

Phase A is Hampton. This matters now, not in Phase B.

### Platform fee — decided

**The 3% platform fee applies to the donation portion at the same rate as the square portion.** One rate across `totalPaidCents`, charged to host proceeds via `application_fee_amount` on the single session. A mixed checkout is one charge and takes one fee.

Two rates on one payment would need a split calculation, a second line in every host-facing total, and an explanation of why generosity is priced differently from participation. Board v2 §14 is unchanged and this fee still ships **after** the board works, not in the first PR.

### Required copy constraint — no deductibility language

The word "donation" invites an assumption about tax deductibility. Most Daali hosts are parent groups, booster clubs, and church committees — not registered charities — and the platform has no way to know which is which.

**No Daali surface may state or imply that a contribution is tax deductible.** No receipt language, no "for your records," no charitable-contribution framing in the confirmation email. Where a clarifying line is needed, the host is the giver's counterparty, not Daali.

Modeled on the no-refund disclosure in money doc §8: the requirement is stated here, the exact wording is a copy decision made elsewhere. Both should be reviewed together, since both live on the same checkout screen.

---

## 13. Migration and rollout

### Boundary — decided, premise corrected

**`Contribution` ships in migration A1, the earliest migration.** That decision stands. **The stated reason for it did not survive contact with the database, and this section is the correction.**

v2.0 of this document claimed no backfill was required, inheriting board v2 §16's *"nothing is built yet."* That was true when board v2 was written and stopped being true when fundraiser boards shipped. A read-only preflight against production found:

| Finding | Count |
|---|---|
| Fundraiser squares | 700 |
| Carrying `batch_id` | **40** |
| `paid` | **18** |
| `reserved_cash` | 20 |
| `admission_grants` with non-null `square_batch_id` | **13 of 13** |
| `payment_reference` rows | 22 |

Across five boards, one of them (`rpffdlbf`) **closed and finalized**.

**The timing decision is unchanged and is now better supported, not worse.** Those 40 rows are the smallest they will ever be. Deferring `Contribution` to a later migration means backfilling them plus everything the next campaign adds. Earlier is still cheaper — it simply is not free, which is what v2.0 got wrong.

**What ships at A1 is the ledger, not the feature.**

| At A1 | Later |
|---|---|
| `Contribution` table, all constraints | Donation amount field at checkout |
| `Square.contributionId` FK + **backfill** | Cash donation recording |
| `AdmissionGrant.contributionId` + **backfill** | `prizeBasisCents` split in host reporting |
| `donationAmountCents`, defaulted to 0, **read by nothing** | Closing reconciliation for donation sessions |
| Actor fields (§8) | The donate CTA |

**Campaign-page-first presentation** remains a v3 refactor, out of scope, and unblocked by the ledger existing early.

### Migration inventory

Lands in **A1**, with a backfill and a correctness gate.

| # | Change | Notes |
|---|---|---|
| 1 | Create `Contribution` + all CHECK constraints | |
| 2 | Add `Square.contributionId`, nullable, FK → `Contribution.id` | **Additive. `batch_id` is not touched in this migration** |
| 3 | Add `AdmissionGrant.contributionId`, unique where not null | |
| 4 | **Backfill** — §13.1 | |
| 5 | **Correctness gate** — §13.2. Migration aborts on failure | |
| 6 | `Board.finalPrizeBasisCents` | Nullable. Written at CLOSED |
| 7 | `Contribution.displayAnonymous` | Reserved, unread |

**`batch_id` and `square_batch_id` are retained, not dropped.** Dropping them belongs in a **separate later migration**, after the gate has passed and the application has run against `contributionId` in production. With no preview environment, a migration that both rewrites ownership and destroys the source of truth for that rewrite has no recovery path short of a database restore.

Board v2 §3 and admission §3 must be corrected to describe `contributionId` as the forward model, noting `batch_id` as retained-and-deprecated rather than absent.

### 13.1 Backfill

**One `Contribution` per distinct `(board_id, batch_id)`** where that batch has at least one **non-open** square.

```
status        any square paid            → confirmed
              else any reserved_cash     → pending
paymentMethod from the batch's squares
squareAmountCents   = SUM(price_paid_cents) over the batch's non-open squares
donationAmountCents = 0
totalPaidCents      = squareAmountCents
confirmedAt         = earliest confirmation timestamp available, else null
recordedByHostId    = null      -- unknowable retroactively; do not guess
confirmedByHostId   = null      -- see below
```

Then set `Square.contributionId` on **non-open squares only**, and `AdmissionGrant.contributionId` from the `square_batch_id` → `Contribution.id` mapping.

**Four rules that the data forces:**

**Open squares carrying a stale `batch_id` produce no Contribution and get a null `contributionId`.** The preflight found 40 `batch_id` rows against 18 paid and 20 `reserved_cash` — two `open` squares retain a `batch_id` from an abandoned checkout that released without clearing it. They are released squares, they hold no money, and creating ledger rows for them would invent contributions that never completed. Log them; do not normalize `batch_id` itself in this migration.

**A batch may legitimately span `paid` and `open`.** Invariant 7 permits a cash batch resolved two-confirmed-one-released. Only the non-open squares attach, and `squareAmountCents` sums only those — which is what invariant 53 asserts.

**Actor fields backfill to null, not to the board owner.** Nothing recorded who confirmed these, and a plausible guess written into an audit column is worse than an honest gap. Invariant 103 governs contributions created after A1; it is not retroactive and must not be enforced against backfilled rows.

**`rpffdlbf` is closed and its money is finalized.** The backfill assigns ownership of existing rows and writes no amount anywhere. It must not touch `finalRaisedCents`, `finalPrizePoolCents`, or any square's `price_paid_cents`. Invariants 4 and 13 hold through this migration.

### 13.2 Correctness gate

Runs inside the same transaction. **Any failure aborts the migration.**

1. Per board: `SUM(Contribution.totalPaidCents)` for confirmed contributions equals the pre-migration confirmed square total. Capture that total **before** step 4 and compare after.
2. Every non-open square with a `batch_id` has a non-null `contributionId`. Expected: 38.
3. **Legacy-backfill assertion, not a forward invariant.** Every `open` square has a null `contributionId`. Expected exceptions: 0.

   This holds for the migration snapshot because stale `batch_id` values on released squares must not produce Contributions. **The counts in assertions 2 and 3 — 38 attached, 0 exceptions — describe this database at this moment and must never become application validation.** In normal operation a `pending` Contribution legitimately owns squares while its checkout is live; those squares are `pending` or `reserved_cash`, and that relationship is the point of the ledger. Do not port these numbers into a runtime check.
4. All 13 `admission_grants` rows have a non-null `contributionId`, and each points at the contribution owning the squares that minted its passes.
5. `AdmissionGrant.contributionId` is unique where not null — assert on real rows, not an empty table.
6. Contribution count equals the count of distinct `(board_id, batch_id)` pairs having at least one non-open square.
7. `rpffdlbf`: `finalRaisedCents` and `finalPrizePoolCents` are byte-identical to their pre-migration values.

**Capture the pre-migration counts and totals as a committed artifact before running anything.** Without a preview environment, the numbers the gate compares against cannot be recovered after the fact.

### Code touchpoints

| File | Change |
|---|---|
| `src/lib/checkout-holds.ts` | Resolution operates on `Contribution`; branch for zero-square contributions |
| `src/lib/cron/release-expired.ts` | Resolve pending contributions with no squares |
| `src/app/api/webhooks/stripe/route.ts` | Lookup by `checkoutSessionId`, amount assertion, zero-square branch |
| `src/app/api/boards/[id]/close/route.ts` | CLOSING step 2, assertion step 4, three final fields |
| `src/lib/prizes.ts` | Read `prizeBasisCents`, never `raisedCents` |
| `src/lib/admission.ts` | Activation on donation confirmation; grant keyed to contribution |
| `src/app/board/[slug]/claim-sheet.tsx` | Donation amount field, mixed total, one-payment copy |
| `src/app/host/boards/[id]/fundraiser-panel.tsx` | Four-number breakdown, cash donation entry |
| **New** — donation route, cash donation route | |

---

## 14. Required tests

> **Environment-blocked tests.** Production is the only deployment target and its Stripe key is `sk_live_` (Gate 2). Tests requiring a *completed* Stripe Checkout Session cannot run without charging a real card against a real connected account, on the same database holding the S3b fixture. They are marked below.
>
> These are **required and not executed.** They are never marked skipped, never marked passing, and never removed from the suite. They become executable the moment a non-production database plus test-mode Stripe environment exists, and they gate release, not merge.
>
> Rejection-path and cash-path tests remain fully executable — they neither contact nor mutate Stripe.

**Blocked: 12, 13, 14, 17, 19, 20.** Test 17 is added to the set named at freeze — `CLOSING` reconciliation requires a session genuinely paid before the cutoff, which is a completed live checkout.

**Executable now:** 15, 16, 18, 21, 22, 23, 24, 25, 26, 27, 28. Prize-basis isolation, terms locking, and the concurrency case are all reachable through the cash path, and the void suite touches Stripe not at all.


Appended to money doc §11. All must pass before this ships.

12. **REQUIRED — ENVIRONMENT BLOCKED, NOT EXECUTED.** **Donation-only card, success and abandonment.** Confirm → `raised` increases by the full amount, `prizeBasis` unchanged, zero squares changed state, zero passes minted. Abandon → session expired, contribution `released`, `raised` unchanged.
13. **REQUIRED — ENVIRONMENT BLOCKED, NOT EXECUTED.** **Mixed checkout, hold expiry.** 3 squares + $25 donation. Let the hold expire unpaid. Assert the session is expired *before* release, all 3 squares release together, the contribution is `released`, and **nothing is charged** — not the squares, not the donation.
14. **REQUIRED — ENVIRONMENT BLOCKED, NOT EXECUTED.** **Mixed checkout, success.** Assert `raised` increases by the total, `prizeBasis` increases by the square portion only, 3 passes minted, and `squareAmountCents` equals the sum of the three `pricePaidCents`.
15. **Prize basis isolation.** $1,000 in donations on a 20% board with $500 of squares. Assert prize pool is $100, not $300.
16. **Terms lock trigger.** Donation-only board: host edits square price → succeeds. Confirm one square. Same edit → rejected.
17. **REQUIRED — ENVIRONMENT BLOCKED, NOT EXECUTED.** **CLOSING with an in-flight donation.** A donation session paid at Stripe seconds before cutoff, webhook delayed past it. Assert `CLOSING` queries directly, confirms it, and includes it in `finalRaisedCents` — and that finalization did not occur first. Reverse branch: unpaid at cutoff → expired, never appears.
18. **Post-close donation rejected.** Attempt at `closing`, `closed`, and `drawn`. Assert rejection at every entry point including a direct API call, not only the UI.
19. **REQUIRED — ENVIRONMENT BLOCKED, NOT EXECUTED.** **Webhook replay on a donation.** Redelivered `checkout.session.completed`. Assert no double count, no second supporter activation, `raised` unchanged.
20. **REQUIRED — ENVIRONMENT BLOCKED, NOT EXECUTED.** **Amount tampering.** Session `amount_total` ≠ `totalPaidCents`. Assert the contribution does not confirm, does not release, and raises.
21. **Donation-only supporter.** Board with an event. Assert supporter is `active`, holds zero passes, is absent from the Expected headcount, and **is eligible to claim a helper slot.**
22. **Concurrent donation and square purchase, same person.** Both confirm in the same second. Assert exactly one activation, correct pass count from the square only, no double count in `raised`.
23. **Cash donation void** — *only if §7 is approved.* Void before close → excluded from `raised`, logged with actor and reason, not deleted. Attempt after `CLOSING` begins → rejected.
24. **Backfill reconciliation.** Post-migration, assert `SUM(Contribution.totalPaidCents) = ` pre-migration raised, per board.

25. **Cash-donation void.** Record a $500 cash donation, void it as a *different* authorized manager with a reason. Assert `status` is still `confirmed`, amounts unchanged, `voidedAt` and actor set, the row not deleted, and `raisedCents` reduced by $500. Then assert `voidedAt` cannot be overwritten.
26. **Void is unreachable for anything else.** Attempt to void a card donation, a square contribution, a mixed contribution, and a `pending` cash donation. Assert the CHECK constraint rejects each at the database, not only the API.
27. **Void after CLOSING.** Board at `closing`. Assert the void is rejected and `finalRaisedCents` is unaffected.
28. **No raw status filter.** Static check: `status: 'confirmed'` appears in exactly one place — `src/lib/contributions.ts`. Any other occurrence in a raised-total path fails the test.

---

## 15. Deferred

All seven questions from v1.0 are decided, as is the cash-void representation in §7. What remains is genuinely deferred.

| Deferred | Preserved by |
|---|---|
| **Post-close donations** | Needs a second, non-final total. A v3 question about whether the campaign page outlives the board |
| **Deductibility disclosure wording** | The *requirement* is frozen (§12). Exact copy is a pre-launch item, reviewed alongside the no-refund disclosure on the same screen |
| **Dropping `batch_id` / `square_batch_id`** | A separate migration after the §13.2 gate passes and the app has run on `contributionId` in production |
| Donor anonymity display | `displayAnonymous`, unread |
| Public donor list | Nothing depends on the public surface being counts-only |
| Recurring or monthly giving | Nothing assumes one payment per person |
| Matching gifts | A contribution with a `matchesContributionId` is additive |
| Donation-only boards with no grid | v3 presentation. The ledger already permits zero confirmed squares |
| Per-donation receipts | Explicitly out. §12 |

---

**Status: ready for freeze.**
