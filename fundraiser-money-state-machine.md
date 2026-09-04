# Fundraiser Money & State Machine

**Status:** Draft — pending sign-off
**Authority:** This document is the source of truth for anything involving dollars or drawing eligibility on Fundraiser boards. Where `fundraiser-board-v2.md` and this document disagree, **this document wins.**
**Extended by:** `fundraiser-admission-addendum.md` — event admission. Invariants 23–33 live there. They extend this list and never override 1–22.
**Scope:** Fundraiser boards only. Game Day boards are unchanged and out of scope.

Sign off on the invariants in Section 9 before any of this is built. The product spec will be written around them.

---

## 1. Vocabulary

| Term | Meaning |
|---|---|
| **Square** | A spot on the fundraiser board. 25/50/75/100 per board. |
| **Contribution** | Money given to claim a square. Non-refundable once confirmed. |
| **Drawing ticket** | An entry in the prize drawing. Exists only on prize-enabled boards. Derived from a Square, never a stored row — see §5. |
| **Confirmed** | Money actually received. Card settled, or cash marked received by the host. |
| **Reserved** | A cash square held for a named person. **$0.** Not confirmed. |
| **Raised** | Sum of confirmed contributions. The public number. |
| **Prize pool** | `prizePoolPercent × raised`. Confirmed money only. |

**Claimed ≠ funded.** A reserved square is claimed. It is not funded. Every number in this document that involves dollars uses confirmed only.

---

## 2. Square states

```
OPEN ──┬── PENDING ──── CONFIRMED ──── (terminal)
       │      │
       │      └──────── OPEN          (checkout abandoned / failed)
       │
       └── RESERVED ─── CONFIRMED ──── (terminal)
              │
              └──────── OPEN          (cash never received / expired)
```

Board-level lifecycle:

```
OPEN → CLOSING → CLOSED → DRAWN
```

`CLOSING` is a reconciliation phase, not a display state. See Section 7.

**CONFIRMED is terminal.** A confirmed square never returns to OPEN. There is no refund transition, no refund state, and no host-facing refund action. See Section 8 for how external payment reversals are handled.

| State | Grid color | Counts toward raised | Ticket |
|---|---|---|---|
| `open` | empty | No | None |
| `pending` | **blue** (host view) — checkout in progress, minutes | No | None |
| `reserved_cash` | **amber** (host view) — cash hold, days | **No** | **None** |
| `paid` | green | **Yes** | **Active** |

Blue and amber are a **host-dashboard distinction**. The host needs to tell a ten-minute checkout from a five-day cash hold she has to chase. On the public board, any non-open square simply renders as unavailable — see Section 10.

---

## 3. Card lifecycle

`OPEN → PENDING → CONFIRMED`

**Batches are atomic.** A contributor claiming squares #12, #23, #87 for $150 gets one Stripe Checkout session. All three confirm together or none do.

1. Contributor selects 1–10 squares → all move to `pending` in one transaction, and `holdExpiresAt` is written on each
2. One Checkout Session created for the full amount. Daali stores `holdExpiresAt` separately and displays that countdown; Stripe's native session expiry may be longer and is never shown. When the Daali hold expires, Daali resolves and if necessary expires the Stripe session before releasing the batch — see invariant 18.
3. On `checkout.session.completed` → all N squares flip to `paid` and drawing eligibility activates for each, all in **one transaction**
4. On confirmed non-payment — session expired by Daali, or failed — all N squares release to `open` together

**Partial confirmation is impossible on card.** If the transaction fails at any point, the whole batch releases. There is no path where 2 of 3 squares confirm.

### Checkout hold timer

Squares are held for a fixed window while the contributor completes checkout, and **the countdown is shown to them**. This is the Ticketmaster pattern: the hold already existed, but nobody could see it.

**Duration: 10 minutes, capped at campaign close.**

```
holdExpiresAt = earlier of (now + 10 minutes) or campaign close
```

Someone starting checkout three minutes before the cutoff gets a three-minute timer, not a fake ten-minute one that outlives the campaign. This mirrors the cash rule in Section 4 — no hold of any kind survives close.

**Stripe cannot enforce a 10-minute session.** Its `expires_at` minimum is 30 minutes. So `holdExpiresAt` is Daali's timestamp, not Stripe's, and Daali must actively close the session:

```
hold expires → query the session
  status = complete / paid  → confirm the full batch, release nothing
  status = open / unpaid    → POST /v1/checkout/sessions/{id}/expire
                              THEN release the batch
```

This is Stripe's documented pattern for limited inventory. The `expire` endpoint cancels a pending purchase immediately, which is what makes the release safe.

`holdExpiresAt` and the on-screen countdown are the same value. The Stripe session expiry is a longer backstop and is never displayed.

**Rules:**

- `holdExpiresAt` is written server-side at the moment the batch goes `pending`. The client renders a countdown against that timestamp — never a client-side counter, which drifts and stalls when the tab is backgrounded.
- **The cron does not release squares.** When `holdExpiresAt < NOW()`, it queues the batch for resolution and runs the sequence above: paid → confirm the batch; open/unpaid → expire the Stripe session, and only on successful expiration → release the batch. A cron that releases on timestamp alone violates invariants 18–20.
- Resolution may lag the displayed zero by up to one cron cycle. This is acceptable and invisible — the squares are unavailable to others either way.
- On release the contributor gets an explanation, not a dead end: *"Your squares were released. Claim them again?"* — with the same squares preselected if still open.
- Other viewers see held squares as unavailable while the timer runs. Two people cannot start checkout on #87.

### Manual release of pending squares

The host may release a `pending` batch **only after `holdExpiresAt` has passed.** Before that the control is absent, not disabled — the checkout is genuinely live and there is nothing to reclaim.

**Payment always wins — enforced by ordering, not by recovery.** A `pending` batch is never released while its Stripe session can still complete. Resolution comes first, every time:

```
paid   → confirm the batch, assign tickets
unpaid → expire the Stripe session, then release
```

Because the session is expired before the squares are made available, a released batch cannot later produce a valid payment. There is no late-success case to recover from, and no "we'll find you another square" mechanism to build.

`holdExpiresAt` is capped at campaign close (Section 3), so no card hold can still be running when `CLOSING` begins — the same resolution logic drives both.

The host panel shows batch age ("3 squares, held 12 min") so the release decision is informed rather than a guess.

**Confirmed squares are never releasable** — by the host or anyone else. See invariant 4.

---

## 4. Cash lifecycle

`OPEN → RESERVED → CONFIRMED` or `OPEN → RESERVED → OPEN`

**Batches are NOT atomic.** This is the deliberate difference from card, and it exists because cash doesn't behave like a payment processor.

A parent reserves #12, #23, #87 for $150 and shows up with $100. The host must be able to confirm #12 and #23 and release #87. Do not force cash batches to resolve as a unit.

- Reservation groups N squares under one contributor name and phone
- The host confirms or releases **each square independently**
- Confirming a square: `reserved_cash → paid`, ticket assigned, raised increases
- Releasing a square: `reserved_cash → open`, no ticket, no money

### Reservation expiry

**Expiry = the earlier of:**
- The host's cash-hold window (fundraiser default: 7 days, host-configurable), or
- **Campaign close**

The 20-minute TTL used on Game Day boards does not apply to fundraiser boards. A six-week campaign cannot release a square twenty minutes after a parent says they'll bring cash Friday.

The cap at campaign close is not optional. Without it, a reservation made the day before an October 15 close would hold until October 22, and the draw would wait on it.

**If money isn't confirmed by close, it doesn't count.** No ticket, no dollars, square releases.

---

## 5. Ticket assignment

Tickets exist only when `prizePoolPercent > 0`.

**Paid tickets:** ticket number = square position. Claim #87, you're ticket #87. One identifier, not two.

**Free entries:** numbered `F1, F2, F3…` in a separate sequence. They occupy no square, do not appear on the grid, and contribute $0. They are eligible in the draw.

**Activation point:** drawing eligibility goes active the moment a square reaches `paid` — inside the same transaction as the status flip. Never earlier.

The paid ticket ID **is** the square position. There is no sequence generator for paid tickets and none should be built. The only sequential counter in the system is the `F` free-entry sequence.

**There is no `Ticket` table, and none should be built.** A paid drawing ticket is not a row. It is a property of a Square:

```
paid drawing ticket  =  Square where paymentStatus = paid
                        AND isHostEntry = false
                        AND board.prizePoolPercent > 0

free entry ticket    =  FreeEntry row, F sequence
eligible draw pool   =  a query over those two
```

**Concurrency:** uniqueness of `(boardId, ticketNumber)` holds structurally rather than by index, because paid ticket numbers equal square positions and square positions are already unique. Two simultaneous confirmations of different squares cannot collide. The only real index needed is on `FreeEntry (boardId, sequenceNumber)`, and the only sequential-collision risk is the `F` counter, which needs its own atomic increment.

An earlier version of this paragraph read as if it mandated a `(boardId, ticketNumber)` constraint on a table. It does not. It describes a guarantee that already holds.

**Gaps are normal.** If only #4 and #87 are claimed, the pool is exactly `{#4, #87}`. There is no requirement for contiguous numbering.

**Reserved cash squares have no ticket.** The ticket materializes when the host confirms receipt. That transition — square turns green, ticket goes active, prize pool ticks up — should be visible in the UI.

### Host and admin contributions

A host or admin may contribute to their own board. Their square behaves like any other square financially — it turns green and counts toward `raised` — but it **does not create an active drawing ticket.**

Do not issue a ticket that cannot win. The audit section displays these plainly:

```
#37 — Organizer contribution — not eligible for drawing
```

**Eligible draw pool** = confirmed non-host, non-admin paid tickets + free-entry tickets.

---

## 6. Prize pool

```
raised     = sum of confirmed contributions (card paid + cash confirmed)
prizePool  = round(raised × prizePoolPercent / 100)
```

**Never** computed from: squares claimed, reserved cash, free entries, or projected full-board value.

Because confirmed contributions are non-refundable, the live pool **only increases** during normal campaign operation. It is safe to display live.

**Public display:**

```
Prize pool so far        $580
Watch it grow as contributions come in.

If drawn right now
1st  $232    2nd  $174    3rd  $116    4th  $58

Drawing October 15 at 8:00 PM ET
```

Potential-at-full-board may be shown, visually subordinate to the live number.

**Tier ratios:** 1 prize → 100. 2 → 60/40. 3 → 50/30/20. 4 → 40/30/20/10.

**Rounding:** compute each tier from the finalized pool, round to whole dollars, assign any remainder to 1st place. The sum of prizes must equal the announced pool exactly.

---

## 7. Close

```
OPEN → CLOSING → CLOSED → DRAWN
```

`CLOSING` is an internal reconciliation phase. It exists to eliminate the one moment where "payment always wins" and "final amounts are immutable" could contradict each other.

**The problem it solves:** campaign closes at 3:00:00. Totals finalize at 3:00:01 at $3,250. A delayed Stripe webhook arrives at 3:00:04 for a $150 checkout that genuinely succeeded before the cutoff. Actual confirmed money is $3,400, but the immutable final says $3,250 — and the draw may already be live.

Close fires either by host action (early close) or by reaching the scheduled/backstop date. Both paths go through `CLOSING`.

### CLOSING — reconciliation

Board status flips to `closing`. New claims are rejected immediately. Then:

1. **Resolve every outstanding card checkout against Stripe.** Query session status directly — do not wait for webhooks. Paid → confirm the batch, activate eligibility. Open or unpaid → **expire the Stripe session first**, then release. Same sequence as invariant 18; a session is never left live while its squares are released.
2. **Resolve outstanding cash.** Manual early close: the host must confirm or release each reserved square inside the close flow. Scheduled close: unresolved reservations auto-release at the cutoff, no host action needed.
3. **Assert zero `pending` and zero `reserved_cash` squares remain.** If any remain, `CLOSING` does not advance. Retry.

`holdExpiresAt` is already capped at campaign close (Section 3), so no card hold can still be legitimately running when `CLOSING` begins. Step 1 is reconciliation, not waiting.

### CLOSED — finalization

Only once step 3 asserts clean, in one idempotent transaction:

4. Recompute `raised` from confirmed squares only
5. Write `finalRaisedCents` — immutable
6. Write `finalPrizePoolCents` — immutable
7. Lock material terms (invariant 16)
8. Status `closing → closed`
9. Enable the draw

**There is no legitimate late payment after finalization,** because finalization cannot occur while any payment is unresolved. Anything arriving after this point is a duplicate webhook (Section 8, test 8) or a processor exception (Section 8) — never new money.

---

## 8. Payment disputes

Daali does not offer refunds on fundraiser boards and does not build a refund action.

A chargeback or bank reversal is an **exceptional processor event**, not a fundraiser state and not a host workflow. It has no state transition. The square stays `paid`. The ticket stays active. `finalRaisedCents` and `finalPrizePoolCents` do not change.

**Host-facing warning, shown in the close flow:**

> Prize amounts are final once announced. If a contribution is later disputed through the contributor's bank, that amount comes out of your proceeds — not out of the prizes.

**Dependency:** the no-refund policy must be disclosed to contributors before payment. An undisclosed no-refund policy is the most reliable way to produce the disputes this section describes. Copy is out of scope here; the requirement is not.

---

## 8B. Contribution price schedule

Optional. A board may carry one changeover:

```
earlyBirdPriceCents   Int?        null = flat pricing, current behavior
earlyBirdEndsAt       DateTime?   with the board's timezone
squarePrice                       the standard price, after changeover
```

**Date-based, deliberately.** A quantity trigger ("first 25 squares") would need an atomic counter, a row lock, a rule for a batch spanning the boundary, and an answer for whether an expired hold returns its tier to the pool. A timestamp has none of that. If quantity tiers are ever wanted, they are a separate spec with their own invariants.

**Price locks at claim, not at confirmation.** These are now two different moments and the gap between them can be days:

| Case | Price |
|---|---|
| Card claim at 11:58pm, pays at 12:01am | Early. Claimed before changeover |
| Card claim before, hold expires, reclaimed after | Standard. It is a new claim |
| Cash reserved Friday at early price, host confirms the following Thursday | **Early.** The reservation fixed it |

The cash row is the one to get right. A host confirming a week-old reservation must see the amount that square was reserved at, not the board's current price, or she collects the wrong money and `raised` disagrees with her bank.

**Prize interaction: none.** The pool is a percentage of `raised`, and `raised` is a sum of actual amounts. Variable pricing flows through untouched. Had the pool been `squares × price × percent`, this would have broken it.

---

## 9. Invariants

Every one of these must hold at all times.

1. `raised` counts confirmed contributions only. Never claimed, reserved, or pending. It is the **sum of `Square.pricePaidCents`** across confirmed squares — never `count × price`, because price can vary by schedule.
2. `prizePool = prizePoolPercent × raised`, confirmed only.
3. A reserved cash square contributes $0 and holds no ticket.
4. `CONFIRMED` is terminal. A confirmed square never returns to `open`.
5. There is no refund state, transition, or host action.
6. A cash reservation expires at the earlier of the cash-hold window or campaign close.
7. Card batches confirm atomically. Cash batches resolve per square.
8. Ticket number = square position for paid entries. Free entries use the `F` sequence.
9. Drawing eligibility becomes active in the same transaction as the square flips to `paid`. On prize-enabled boards the active paid ticket ID equals the square position. Never activate eligibility before confirmation.
10. `(boardId, ticketNumber)` is unique.
11. The draw cannot run while any square is `reserved_cash` or `pending`.
12. The draw is idempotent. A second call returns 409 and changes nothing.
13. Once `finalPrizePoolCents` is written, it never changes — including for later disputes.
14. Prize tiers sum exactly to the finalized pool.
15. Host and admin squares count toward `raised` but never receive an active drawing ticket. No override.
16. After the first confirmed contribution, these are locked: square count, **the contribution price schedule** (both prices and the changeover time), prize on/off, prize percent, tier count, drawing rule, drawing date, and — on boards with an event — event date and the maximum attendee allowance per supporter. A disclosed schedule set before the first contribution is not a price change; an edit to that schedule afterward is. Attendance is a declaration against that allowance, never a fixed number of admissions per square or per purchase.
17. Free entries never occupy a square or move the fundraising meter.
18. A `pending` square carries a server-set `holdExpiresAt` = earlier of (now + 10 minutes) or campaign close. The displayed countdown uses that same timestamp. When the Daali hold expires, the Stripe Checkout Session must be resolved before any square is released: complete/paid → confirm the full batch; open/unpaid → explicitly expire the Stripe session, then release the full batch.
19. A `pending` square may be manually released only after `holdExpiresAt` has passed, and only through the resolution sequence in 18.
20. Payment always wins before release and before finalization. A pending card batch must never be released while its Stripe session remains capable of successful payment. A released batch must not later produce a new valid payment.
21. Finalization cannot occur while any square is `pending` or `reserved_cash`. `CLOSING` reconciles every outstanding payment against Stripe before `finalRaisedCents` is written.
22. Paid ticket numbers may have gaps. Contiguity is never required or asserted.

### Pricing (invariants 48–50)

48. `Square.pricePaidCents` is written the moment a square leaves `open` — at claim or at cash reservation — and is **never recomputed**. Price is fixed when the square is taken, not when the money arrives.
49. `raised` is the sum of `pricePaidCents` over confirmed squares. No code path may derive it from a board-level price.
50. The price schedule is a boundary in **time**, evaluated once per claim. It is never a function of how many squares have sold, so no counter, lock, or ordering guarantee is required.

### Amendments in force

Four invariants above are **superseded** by the wording below. Where they differ,
the amended text governs. Each is marked with its amending document; the
reasoning lives there and is not repeated.

**Invariant 2 — amended by `fundraiser-donations-addendum.md` §3.**

> `prizePool = round(prizePoolPercent × prizeBasisCents / 100)`, where
> `prizeBasisCents` is the sum of confirmed **square** money only. Donations
> never enter the prize basis. `raisedCents` is `prizeBasisCents` plus confirmed
> donation money, and prize math never reads it.

**Invariant 16 — amended by `fundraiser-donations-addendum.md` §3.**

> After the first confirmed **square** contribution, these are locked: square
> count, the contribution price schedule (both prices and the changeover time),
> prize on/off, prize percent, tier count, drawing rule, drawing date, and — on
> boards with an event — event date and the maximum attendee allowance per
> supporter. **A confirmed donation-only contribution locks nothing.**

**Invariant 21 — amended by `fundraiser-donations-addendum.md` §3.**

> Finalization cannot occur while any square is `pending` or `reserved_cash`,
> **or while any `Contribution` is `pending`**. `CLOSING` reconciles every
> outstanding payment session against Stripe — square batches and donation-only
> sessions alike — before `finalRaisedCents`, `finalPrizeBasisCents`, and
> `finalPrizePoolCents` are written.

**Invariant 49 — amended by `fundraiser-donations-addendum.md` §3.**

> `prizeBasisCents` is the sum of `pricePaidCents` on confirmed squares, never a
> count multiplied by a price. `raisedCents` is the sum of `totalPaidCents` on
> confirmed contributions. Neither is ever derived from a square count.

Invariants 1, 4, 5, 13, 15, 17 are **unchanged**; donations §3 clarifies their
scope without altering their text.

Invariant numbers are identifiers, not sort keys, and are allocated by
invariant-registry.md. This document owns 1–22 and 48–50. Other blocks are owned
by the addenda registered there. Gaps in this document's sequence are expected
and are not defects.

Invariants 23–33 govern event admission and are defined in
`fundraiser-admission-addendum.md`. Admission never moves money, never touches
`raised`, and never alters drawing eligibility.

---

## 10. Display rules

### Public board

Two numbers. No state counts.

```
$3,250 raised
```

Plus, only when `prizePoolPercent > 0`:

```
Prize pool so far     $650
```

That's it. No "73 of 100 filled," no confirmed/reserved/open breakdown. Stating a square count next to a dollar figure invites a multiplication that won't reconcile; omitting it removes the question rather than explaining it.

The grid still renders taken squares as unavailable so two people can't claim the same one — but with no legend and no count. `pending` and `reserved_cash` may render identically to the public.

`Prize pool so far` must keep the qualifier. Without it the number reads as final, and it isn't until close.

### Host dashboard

The host sees the full breakdown, because she has to act on it:

```
65 confirmed · 8 cash reserved · 2 in checkout · 25 open
$3,250 raised · prize pool $650
```

Cash reserved is the number she works from — those are the parents who owe her money before close. `pending` and `reserved_cash` are visually distinct here (blue vs. amber) since one clears itself in minutes and the other needs her to chase someone.

---

## 11. Required tests

All eleven must pass before this ships.

**1. Card batch, success and failure.** Claim 3 squares → one session → all 3 confirm, 3 tickets issued, raised increases by the full amount. Then: abandon checkout → all 3 release together, 0 tickets, raised unchanged.

**2. Concurrent confirmation.** Squares #23 and #87 confirm in the same second from different contributors. Assert exactly tickets #23 and #87 exist, each attached to the correct contributor, no square owned twice, no double-count in `raised`. Gaps between #23 and #87 are expected and must not be asserted against. Separately, assert two simultaneous free entries produce `F1` and `F2`, never two `F1`s.

**3. Draw idempotency.** Call the draw endpoint twice concurrently. Assert exactly one result set written, second returns 409.

**4. Cash expiry vs. cutoff.** Reserve on day 14 of a campaign closing day 15, with a 7-day hold. Assert the reservation dies at close, not on day 21.

**5. Scheduled close with unresolved cash.** Amber squares outstanding at cutoff → auto-release → no tickets → pool finalizes → draw becomes available with zero host action.

**6. Partial cash batch.** Reserve 3 for $150, confirm 2, release 1. Assert exactly 2 tickets, raised increases by $100 not $150, third square returns to `open`.

**7. Close/confirm race.** Host confirms a cash square at the same instant scheduled close executes. Assert one deterministic outcome — the square is either confirmed-and-counted or released-and-not, never counted in `finalRaisedCents` while sitting in `open`.

**8. Webhook replay.** Stripe redelivers `checkout.session.completed` for an already-processed session. Assert no double-count, no second ticket, no change to `raised`.

**9. Released batch cannot pay.** Hold expires with the session unpaid → assert Daali calls the expire endpoint *before* releasing the squares. Then attempt to complete that session. Assert it fails, no square changes state, and `raised` is unchanged. Assert the reverse branch too: session was actually paid at expiry → batch confirms, nothing releases.

**10. CLOSING reconciliation.** A checkout succeeds at Stripe seconds before the cutoff but its webhook is delayed past it. Assert `CLOSING` queries Stripe directly, confirms the square, and includes the money in `finalRaisedCents` — and that finalization did not occur before that resolution. Then assert the reverse: an unpaid session at cutoff releases, and its money never appears in the final total.

**11. Host/admin ineligibility.** Host confirms square #37. Assert the contribution counts toward `raised`, the square displays as funded, #37 is marked organizer/ineligible, #37 never enters the eligible draw pool, and the draw cannot select it.

---

## 12. Square limits

**There is no limit on how many squares a person may contribute to on a fundraiser board.** `maxSquaresPerPlayer` does not apply to `boardType = "fundraiser"`. It remains in force on Game Day boards, unchanged.

A single ceiling applies, and it is **mechanical, not a policy limit**: a maximum of **10 squares per transaction**. This exists because a batch goes `pending` atomically and releases atomically — a 25-square abandoned checkout would lock an entire 25-square campaign, or half a 50-square one, for the length of the hold.

The contributor can repeat the flow as many times as they like. UI reads "claim more squares," never "limit reached."

**Consequence on prize boards:** a contributor holding 40 of 65 confirmed tickets will probably win. This is not prohibited — they contributed the most. Ticket counts per contributor should be visible in the audit section so the outcome is legible rather than surprising.

---

*End of document. Sign off on Section 9 before the product spec is written.*
