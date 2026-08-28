# Fundraiser Boards — Product Spec v2

**Status:** Draft — pending approval
**Companion:** `fundraiser-money-state-machine.md` — **signed off and frozen**
**Depends on:** Phase 1 (shipped), Phase 2 double grid (shipped)

---

## Rule of this document

This spec owns **what Daali does**. The money doc owns **what must always be true**.

Anything involving dollars, square state transitions, ticket eligibility, close, or draw mechanics is defined in `fundraiser-money-state-machine.md` and is **not restated here.** Where this document needs one of those rules, it points to the invariant number.

If the two ever appear to disagree, the money doc wins and this document is wrong.

---

## 1. What a Fundraiser board is

A second board type alongside Game Day. The host picks the type before the create form opens, and the two never mix.

| | Game Day | Fundraiser |
|---|---|---|
| Purpose | Squares tied to a game score | Raise money for a goal |
| Teams / sport | Yes | **No** |
| Periods / scores | Yes | **No** |
| Digit randomization | Yes | **No** |
| Winner determined by | Last digit of score | **Random draw** |
| Prizes | Payout structure of the pot | Percentage of confirmed contributions |
| Square choice | Player picks | **Auto by default**, pick optional |

Game Day is unchanged in every respect. This spec adds a parallel path.

**Why the draw is random and not score-based:** a prize awarded by game score and a prize awarded by random draw are different regulated categories, and only the second has a workable path for an informal group. This is a hard constraint. Do not implement a "random" draw that reads a score.

---

## 2. Files

| File | Change |
|------|--------|
| `src/app/host/boards/new/board-type-picker.tsx` | **NEW** — Game Day vs Fundraiser |
| `src/app/host/boards/new/new-board-flow.tsx` | Add type step before grid-type picker |
| `src/app/host/boards/new/fundraiser-form.tsx` | **NEW** |
| `src/app/api/boards/route.ts` | Branch on `boardType` |
| `src/app/board/[slug]/fundraiser-view.tsx` | **NEW** — contributor board |
| `src/app/board/[slug]/claim-sheet.tsx` | **NEW** — quantity + optional picker |
| `src/app/board/[slug]/hold-timer.tsx` | **NEW** — countdown |
| `src/app/board/[slug]/page.tsx` | Branch: fundraiser vs game view |
| `src/app/host/boards/[id]/fundraiser-panel.tsx` | **NEW** — replaces score entry |
| `src/app/host/boards/[id]/draw-panel.tsx` | **NEW** |
| `src/app/api/boards/[id]/draw/route.ts` | **NEW** |
| `src/app/api/boards/[id]/free-entry/route.ts` | **NEW** — data path, no UI |
| `src/app/api/boards/[id]/close/route.ts` | **NEW** — CLOSING phase |
| `src/lib/prizes.ts` | **NEW** |
| `src/lib/checkout-holds.ts` | **NEW** — resolve-then-release |
| `src/app/api/webhooks/stripe/route.ts` | Batch confirmation |
| `src/lib/cron/release-expired.ts` | Resolve, don't release — invariant 18 |
| `prisma/schema.prisma` | Section 3, plus admission addendum §2 |

**Admission (only on boards with an event):**

| File | Change |
|------|--------|
| `src/lib/admission.ts` | **NEW** — sole owner of supporter, grant, and pass lifecycle: resolve, prepare, activate, mint |
| `src/app/api/webhooks/stripe/route.ts` | Activation joins the batch confirmation transaction |
| *existing cash confirm route* | Same activation call. Locate it; do not guess the path |
| `src/lib/cron/release-expired.ts` | Clean up orphaned pending grants |
| `src/app/host/boards/new/fundraiser-form.tsx` | Optional event block — §5 |
| `src/app/board/[slug]/claim-sheet.tsx` | Donate checkbox, `pricePaidCents` at claim — §6 |
| `src/app/board/[slug]/passes/page.tsx` | **NEW** — passes screen |
| `src/app/api/host/events/[id]/donate-flag/route.ts` | **NEW** — host toggles a grant's donate setting |
| `src/app/host/boards/[id]/event-panel.tsx` | **NEW** — roster, volunteer links, forecast |
| `src/app/gate/[token]/page.tsx` | **NEW** — volunteer surface — §6B |
| `src/app/api/gate/[token]/checkin/route.ts` | **NEW** — scan, search, undo |

---

## 3. Schema

### Board — new

| Field | Type | Notes |
|---|---|---|
| `boardType` | enum | `"game"` \| `"fundraiser"`. Default `"game"`. **Backfill existing rows to `"game"`.** |
| `causeDescription` | String? | One or two lines under the title. |
| `prizePoolPercent` | Int | 0–50. Default 0. Zero = no-prize board. |
| `prizeTierCount` | Int | 1–4. Default 4. Ignored when percent is 0. |
| `drawTrigger` | enum | `"date"` \| `"when_full"` |
| `drawDate` | DateTime | **Required on every prize board**, both triggers. Backstop. |
| `timezone` | String | IANA, e.g. `America/New_York`. **One per board**, covering early bird, close, draw, and event. Renamed from `drawTimezone` — it was never draw-specific |
| `cashHoldDays` | Int | Default 7. Capped at campaign close — invariant 6. |
| `finalRaisedCents` | Int? | Written at CLOSED. Immutable — invariant 13. |
| `finalPrizePoolCents` | Int? | Written at CLOSED. Immutable — invariant 13. |
| `drawnAt` | DateTime? | |
| `drawResults` | Json? | |
| `titleHistory` | Json? | Array of `{previousTitle, changedAt}` |
| `earlyBirdPriceCents` | Int? | Null = flat pricing. Money doc §8B |
| `campaignEndsAt` | DateTime? | **Required for fundraiser**, null for game. See CHECK constraints below |
| `fundraisingGoalCents` | Int? | Optional, host-entered. Null = no progress bar. Editable after launch |
| `earlyBirdEndsAt` | DateTime? | Changeover, in the board's `timezone` |

### Conditional constraints

Four requirements are conditional, so none can be `NOT NULL` on a table full of Game Day rows. Enforce each with a partial CHECK rather than API validation alone — API validation is one code path away from being bypassed, and adding a CHECK after rows exist requires a validation scan.

```sql
CHECK (prize_pool_percent = 0 OR draw_date IS NOT NULL)
CHECK (board_type = 'game' OR campaign_ends_at IS NOT NULL)
CHECK (board_type = 'game' OR timezone IS NOT NULL)
CHECK (early_bird_price_cents IS NULL
       OR (early_bird_ends_at IS NOT NULL
           AND early_bird_price_cents < square_price))
```

The last one carries a real business rule: an early bird price with no end date never changes over, and an early bird price at or above the standard price is not an early bird.

All four are dormant against existing data — every Game Day row satisfies them trivially.

### Board — nullable for fundraiser

`teamRow`, `teamCol` — required for `game`, **null** for `fundraiser`. Branch the API validation and relax the DB constraint.

`gameName` is reused as the campaign title. No new column, no migration.

### Square — new

| Field | Type | Notes |
|---|---|---|
| `holdExpiresAt` | DateTime? | Set on `pending` — invariant 18 |
| `checkoutSessionId` | String? | Needed to resolve/expire — invariant 18 |
| `batchId` | String? | Groups a multi-square claim |
| `isHostEntry` | Boolean | Default false. Funded, never eligible — invariant 15 |
| `pricePaidCents` | Int? | Null while `open`. **Written when the square leaves `open`. Never recomputed** — invariant 42 |

### FreeEntry — new table

Free entries occupy no square, so they cannot be Square rows.

| Field | Type |
|---|---|
| `id`, `boardId` | |
| `sequenceNumber` | Int — the `F` counter, atomic |
| `name`, `phone` | String |
| `verifiedAt` | DateTime? |
| `createdAt` | DateTime |

**Built in v1. Not surfaced in the UI.** No link, no button, no board copy. The path exists in the data model and the draw includes it (invariant 17) so that surfacing it later is a link, not a refactor. Whether it appears publicly is a copy decision, deferred.

### Existing fields on fundraiser boards

| Field | Behavior |
|---|---|
| `hostCutPercent` | Forced to 0. Not shown. |
| `payoutStructure` | Unused — prize split derives from `prizeTierCount` |
| `periodType`, `periodLabels` | Unused |
| `rowNumbers`, `colNumbers`, `rowPairs`, `colPairs` | **Never assigned** |
| `gridType` | `"standard"`. Not meaningful. |
| `maxSquaresPerPlayer` | **Does not apply** — money doc §12 |
| `totalSquares` | 25 / 50 / 75 / 100 |
| `cashModeEnabled` | **Forced true** on fundraiser boards. No toggle — §6C |
| `cashPin` | Unused on fundraiser boards. Never displayed |

---

## 4. Board type picker

New first step at `/host/boards/new`.

```
BoardTypePicker
  ├─ Game Day    → GridTypePicker → NewBoardForm   (both existing)
  └─ Fundraiser  → FundraiserForm                  (new)
```

Two cards, equal weight, no recommended badge. Continue disabled until one is selected. Cancel returns to `/host/boards`. No X close. Reuse the `grid-type-picker.tsx` modal shell.

The fundraiser path skips the grid-type picker — square count is a field on the form instead.

---

## 5. Create form

| Field | Validation |
|---|---|
| What are you raising money for? | Required → `gameName` |
| Tell people what it's for | Optional, 2 lines → `causeDescription` |
| Number of squares | 25 / 50 / 75 / 100. Segmented. Default 100. |
| Contribution per square | Min $1 → `squarePrice` |
| Fundraising goal | Optional. Min $1 → `fundraisingGoalCents`. Shows a progress bar when set |
| Early bird price | Optional. Min $1, must be below the standard price |
| Early bird ends | Required if an early bird price is set. Date + time |
| **Campaign closes** | **Required. Date only** → `campaignEndsAt`, stored as 11:59:59 PM Eastern |
| Payment window | Default 7 days. Always shown on fundraiser boards — direct payment is always available. See §6C |
| Payment handles | Venmo, Zelle, CashApp, PayPal. **At least one required** — this is how most contributors pay. §6C |

**Prize fields do not render in Phase A.** `prizePoolPercent` stays 0. A host must not be able to switch on a drawing that has nothing behind it. Deferred to Phase B, specified here for when it returns:

| Field (Phase B) | Validation |
|---|---|
| Offer a prize? | No prize (default) / Yes |
| Prize pool | If yes. 0–50% of raised. Default 20%. |
| Number of prizes | If yes. 1–4. Default 4. |
| Drawing | If yes. On a date / When all squares claimed |
| Drawing date | Required either way, + timezone |

**Not on the Phase A form:** `requirePlayerPayout` and `payoutVisibility`. Both exist to pay winners, and Phase A has no winners. Server defaults them. They return with Phase B.

### Campaign close

`drawDate` previously did double duty — it scheduled the drawing *and* backstopped the campaign. With prizes deferred, nothing closes the board, so **`campaignEndsAt` is its own required field** on every fundraiser board, prize or not.

Host-entered. Same conditional-validation pattern as the prize fields: enforced by the API for `boardType = "fundraiser"`, nullable in the database because Game Day rows will never have one.

Helper text under the field, guidance only:

> Cash reservations must be confirmed before this date.

`cashHoldDays` caps at close (invariant 6), so a close date sitting right against the event squeezes the window for confirming Zelle payments. **No validation enforces a gap.** The host decides.

### Dates, times, and the timezone

**Two of the three dated fields are date-only. Only the event asks for a time.**

| Field | Input | Stored as |
|---|---|---|
| Early bird ends | Date only | 11:59:59 PM Eastern on that date |
| Campaign closes | Date only | 11:59:59 PM Eastern on that date |
| Event date and time | Date **and** time | The time given, Eastern |

A close date means the **end** of that day. Pick Oct 9 and a contributor clicking through at 4pm on the 9th makes it. That is the answer a host would give if asked, and it removes the midnight-boundary ambiguity that a bare date otherwise carries.

The event keeps a time because a tailgate has a kickoff. 11:59 PM is meaningless for it.

### Timezone: `America/New_York`, hardcoded

No selector on the form. Phase A is a single-region product.

**`America/New_York`, never a fixed −5 offset.** "EST" as a literal offset is wrong from March through November, and Hampton homecoming is in October — EDT, −4. A fixed offset would be an hour off for the entire season this runs in. The IANA zone handles the switch, which is what the conversion helper already takes.

**Keep the `timezone` column**, defaulted to `America/New_York`. It exists, nothing writes to it if the form does not ask, and leaving it means adding a selector later is a form change rather than a migration.

**Known limit:** a host outside Eastern gets close times shifted. Acceptable for Hampton. The fix is the selector this column is already waiting for.

**`datetime-local` gives wall-clock time with no zone.** Parsing it on a UTC server silently shifts it — a 7pm New York close becomes 2pm. Conversion must be explicit and zone-aware. `campaignEndsAt` gates money and `cashHoldDays` caps against it, so this is not cosmetic.

### DST disambiguation

Still required. Date-only fields resolve to 11:59:59 PM, which never lands in a DST gap or an ambiguous hour — but the event field takes an arbitrary time, and a fall campaign crosses a boundary. The helper stays as written.

Two wall-clock times per year are not a single instant, and both must be resolved deliberately.

| Case | Example | Resolution |
|---|---|---|
| **Gap** (spring forward) | 2:30am doesn't exist on the changeover day | Shift **forward** to 3:30am |
| **Ambiguous** (fall back) | 1:30am occurs twice | Depends on the field — see below |

**The gap rule is absolute: a deadline is never resolved earlier than the host typed.** Resolving 2:30am backward to 1:30am closes a board an hour before its stated deadline, silently.

**Ambiguity takes a policy per field**, because the same convention is wrong for both kinds of timestamp:

| Field | Policy | Why |
|---|---|---|
| `campaignEndsAt` | **Later** occurrence | A deadline. Nobody is harmed by an extra hour; someone loses an hour they thought they had |
| `earlyBirdEndsAt` | **Later** occurrence | Same. A deadline |
| `Event.startsAt` | **Earlier** occurrence | A start time. Doors open at the first 1:30am, not the second |

### How it resolves

Enumerate the candidate instants for the entered wall clock, then count how many are real:

| Real candidates | Meaning | Behavior |
|---|---|---|
| 0 | The gap. That local time does not exist | Take the later instant, **under both policies** |
| 1 | Ordinary time | Policy is inert |
| 2 | Genuine ambiguity | Policy decides |

**The policy applies only to the two-candidate case.** The gap is not a choice between real instants, so `"earlier"` must never be able to drag 2:30am back to 1:30am. A correction-pass implementation — one that only knows "corrected" versus "uncorrected" — cannot express this distinction and will get one of the two cases wrong.

Call sites read `parseZoned(value, timezone, "later")`, so the kind of timestamp is stated where a reader needs it.

Tests must cover: both policies across the fall boundary differing by exactly an hour, the gap resolving identically under both, the policy leaving unambiguous times untouched, and **a southern-hemisphere zone** — DST ends in April and begins in October there, so the gap and the ambiguity land on opposite months from the US. That last one is what catches a northern-hemisphere assumption in the candidate search.

Practical impact is one hour, twice a year, in the small hours. The reason to be explicit anyway is that the call site then states which kind of timestamp it is, which is the thing a reader needs to know.

### The three dates are independent

```
Early bird ends       optional, required only if an early bird price is set
Campaign closes       required
Event date and time   required if admission is on
```

Any of the three may fall in any order relative to the others. No validation relates them. All three lock after the first confirmed contribution (invariant 16).

**Backstop date is required even for "when full."** A fill-triggered board that never fills would otherwise hold contributions with no drawing on the calendar, and the host has already been paid. Public copy reads: *"Drawing when all 100 squares are claimed, or October 15 — whichever comes first."*

**Live preview — Phase A:**

```
If all 100 squares fill you raise $2,500 – $3,000
```

A range, because early bird pricing means the total depends on when squares sell.

**Low end is every square at the early bird price. High end is every square at the standard price.** At 100 squares, $25 early and $30 standard, that is $2,500 to $3,000. With flat pricing the range collapses to a single figure.

An earlier version of this paragraph described both ends as the standard price, which was wrong and contradicted its own example.

### Estimated proceeds — not in Phase A

Deliberately absent. Proceeds depend on the payment mix, and nothing at board creation knows it.

Card carries Stripe's per-transaction cost; cash and Zelle carry none. The fee is **per transaction, not per square**, so five squares in one checkout cost the same fixed component as one — meaning even a fully-card board can't be estimated from square count. The platform fee (§14) is Phase C and isn't charged yet.

A single blended percentage would be a made-up number on a host-facing money screen. Show the raise range and nothing else. Reinstating this needs a real fee model written down first, not a rate picked to look plausible.

**Phase B** reinstates the prize lines:

```
  Prizes         $1,000
    1st  $400    2nd  $300    3rd  $200    4th  $100
```

### Early bird pricing

Optional, one changeover, date-based. Money doc §8B and invariants 42–44.

Public copy states the deadline, because urgency is the whole point:

> **$25 per square through September 15. $30 after.**

Price is fixed when a square is claimed or reserved, not when payment lands. A cash square reserved at the early price and confirmed a week later is still owed the early price, and the host's cash panel shows **the amount that square was reserved at**, never the board's current price.

### Optional event block

Collapsed by default. A fundraiser without an event is unchanged in every respect.

```
[ ] This fundraiser includes event admission

    Event name       [defaults to campaign title]
    Date and time    [required]
    Venue            [optional]
```

**Independent of the drawing date.** No validation relates the two. The event may fall before, on, or after the draw, and admission stays valid after the board reaches CLOSED and DRAWN (admission invariant 36).

**No attendance cap.** One confirmed square mints one admission pass (admission invariant 24). Buy 20 squares, bring 20 people. A purchaser who is not attending checks the donate box at checkout.

**Not on this form:** sport, teams, periods, payout split grid, host cut. If any of these render, the form is wrong.

Submit → `POST /api/boards` with `boardType: "fundraiser"`. Credit flow unchanged.

---

## 6. Contributor experience — mobile first

These links go into texts, parent chats, GroupMe, Facebook. Design at 360px and let it grow. The five-second test happens on a phone.

### Above the first scroll

Four questions, in this order:

```
What is this      Hampton Parent Homecoming Tailgate
                  Help us cater the parent tailgate.

How's it going    $3,650 raised
                  [████████████░░░░]

What's the fun    🎁 Prize pool so far  $730
                  Drawing September 30 at 8 PM ET

What do I do      [ Claim a square — $50 ]
                  or pick your own
```

On a no-prize board the third block is replaced with supporter momentum — "73 supporters so far · 27 squares left." Never leave a hole; the no-prize board must not read as the diminished version.

The grid renders below this. **The board is the visualization; the button is the action.** Nobody should have to study a 10×10 grid to work out what to do.

**Display rules are fixed by the money doc §10.** Public sees `raised` and, on prize boards, `Prize pool so far`. No state counts, no "73 of 100 filled." The qualifier "so far" is required — without it the number reads as final.

### Claim flow

Primary button takes the next open square. Under it, a quiet text link — not a second button — opens the grid picker.

```
How many?     [1] [2] [3] [4] [5]  ⌄

Or pick your own
  ☑ #23   ☑ #52   ☑ #87
  3 squares — $150

[ Continue ]
```

Maximum 10 per transaction (money doc §12) — mechanical, not a policy cap. When someone hits 10, the copy reads **"claim more squares"** after checkout, never "limit reached." There is no limit on how many squares a person may contribute to overall.

### Merged claims and the donate flag

`/api/checkout` merges when a returning contributor with pending squares claims more: the old Stripe session is expired and the claims combine. Merged squares keep their original `batchId` and new ones get a fresh one, so **one checkout can produce two grants.**

That is fine for passes — minting is per square, so the headcount is right either way. It is **not** fine for the donate flag, which is per grant.

Someone claims 2 squares, abandons checkout, returns and claims 2 more while ticking *I'm not attending*. She experienced one checkout of 4 squares and expects 0 passes. Without a fix she gets 2, because the older grant still carries `donateAdmissions = false`.

**On merge, propagate the current submission's donate value to every grant in the merge.** The checkbox states the person's intent for the whole checkout, not for whichever fragment of it was written last.

Grant-level rather than supporter-level is still correct: someone who attended in September and makes a pure donation in October must not have September's passes voided by October's checkbox.

## 6C. Direct payment — no toggle, no PIN, no "cash"

Game Day is a cookout. Everyone is in the same yard, someone hands over twenty dollars, and a PIN shared around the group is a reasonable way to let them claim a square.

**A fundraiser is not that.** Contributors are scattered across states. Nobody hands anyone paper money. Payment that Daali doesn't process arrives by Zelle, CashApp, Venmo, or PayPal.

Three changes follow.

### Always on, never a toggle

`cashModeEnabled` is **forced true** on fundraiser boards and the toggle does not render. A host cannot switch it off, because switching it off would mean the only way to contribute is a card — and direct payment is how most people will pay.

### No PIN — on either side

`cashPin` is unused on fundraiser boards, never displayed to the host, and **never requested from the contributor.**

A PIN exists so a host can hand a code to people standing in front of her. There is nobody standing in front of her. A contributor two states away has no way to obtain one, so asking for it does not merely look wrong — it makes direct payment unreachable, which is the way most people will pay.

Removing it from the host dashboard is half the job. The claim sheet is the other half.

**The contributor chooses the method at checkout**, which is what replaces the PIN:

```
How would you like to pay?

( ) Card
( ) Zelle, CashApp, Venmo, or PayPal
```

Choosing the second shows the host's handles, reserves the squares, and tells the contributor to send the amount. The square sits amber until the host confirms. Same machinery as Game Day cash, reached without a code.

The host's handles come from the create form. At least one is required on a fundraiser board — without one there is nowhere to send money.

### Prize-dependent fields do not render

Phase A has no prizes, so there are no winners, so nothing needs to ask how a winner should be paid.

**Off the claim sheet:** "How should the host pay you?" and any payout-preference selector. That field exists to route a prize. `requirePlayerPayout` and `payoutVisibility` are already off the create form for the same reason (§5).

**Off the board:** the "If you win" section, and any prize or payout language in the Payment panel.

These return with Phase B, gated on `prizePoolPercent > 0` rather than on board type — a fundraiser *with* prizes needs them.

### The word "cash" never appears

It means paper money to everyone reading it, and there is no paper money here.

| Game Day string | Fundraiser string |
|---|---|
| Cash Mode On / PIN: 2663 | *not rendered* |
| Cash Reservations | **Awaiting payment** |
| Reserve | **Reserve for contributor** |
| Cash reserved | **Awaiting payment** |
| Confirm cash received | **Mark as received** |
| Cash hold window | **Payment window** |
| Player / Players | **Contributor / Contributors** |
| Player name | **Contributor name** |

**"Player" is a word class, not a list of instances.** Anywhere a fundraiser surface says player — the reserve form, the roster heading, filter labels, empty states — it should say contributor. Nobody is playing anything. Treat the rows above as the pattern rather than the complete set, and prefer one mapping keyed by board type over scattered conditionals.

**Display strings only.** `cashModeEnabled`, `cashPin`, `cashHoldDays`, and the `reserved_cash` payment status keep their names in the database and the code. Renaming a live enum is real risk for zero benefit, and the money doc's invariants reference those names.

### Contact fields are a hard requirement

**Name and email are both required** on a board with an event. Email must not be marked optional on the claim sheet — it is the supporter identity key, and omitting it makes `resolveSupporter` throw inside the claim transaction. The claim fails, not the admission step. `EventSupporter.name` and `.email` are `NOT NULL` with no default, and `resolveSupporter` runs inside the claim transaction — an email-only sheet fails on the first claim, not at A8.

`phone` is nullable, matching how `squares.player_phone` already behaves.

### Admission — boards with an event only

**One square equals one admission pass.** No picker, no ceiling, no math. Buy 4 squares and 4 people get in.

One checkbox, after the contact fields:

```
[ ] I'm not attending - donate my admissions
```

Default unchecked. Checked, the purchase mints no passes and the supporter is excluded from the host's headcount. People buying squares purely to support the cause are a real and expected group, and this is the whole cost of handling them.

Changing it later is a host action from the event panel, not a self-service screen. See addendum §6.

### Hold timer

On reaching checkout, a countdown appears against the server's `holdExpiresAt`:

> **Your squares are held for 9:47**

Client renders against the server timestamp, never a local counter. On release: *"Your squares were released. Claim them again?"* with the same squares preselected if still open. An explanation, not a dead end.

Mechanics are invariant 18 — resolve the Stripe session before releasing.

### Checkout

Minimum viable fields: **name, email, phone, payment.** Nothing else.

**Do not collect payout handles at checkout.** That is Game Day behavior and it does not belong here. Winners are asked for a handle after the draw, in the notification — four people, not a hundred.

**Price is locked at claim.** The claim sheet shows the price in effect at that moment and writes it to `pricePaidCents`. If the hold expires and the squares are reclaimed after the changeover, that is a new claim at the new price — correct, and the release copy should not imply otherwise.

**The no-refund policy must be visible before payment.** Money doc §8 flags this as a dependency: an undisclosed no-refund policy is the most reliable way to produce the disputes it cannot prevent. Exact wording is a copy decision; the requirement is not.

### Confirmation

Not a generic success page.

**Prize board:**
```
🎉 Square #87 is yours.

You just moved the tailgate $50 closer.

Your drawing ticket is #87.
We'll email you when the drawing happens.

[ Claim another square ]  [ Share this board ]
```

**No-prize board:**
```
🎉 Square #87 is yours.

You just moved the tailgate $50 closer.
You're supporter #73.

[ Claim another square ]  [ Share this board ]
```

**Never say "ticket" on a no-prize board.** Ticket to what? The word only means something when there is a drawing. This is one conditional and it's the difference between polished and confusing.

Multi-square confirmation lists every square: *"Your drawing tickets: #23 · #52 · #87."*

**Board with an event** adds one line, and a passes screen behind it:

```
Square #23 is yours.

Entry #23
1 Ticket

[ View your passes ]
```

**Vocabulary, reversed from earlier drafts.** Those used *Drawing Ticket* and *Admission Pass*, on the theory that "ticket" was taken by the drawing. Contributors do not talk that way — people say **tickets** for getting into an event and **entries** for a drawing.

```
Square #23     the position on the board
Entry #23      the drawing entry, derived from the Square
1 Ticket       event admission
```

**Never call a drawing entry a ticket.** The collision runs the other direction now. Internal model names (`AdmissionPass`, `AdmissionGrant`) are unchanged — display strings only.

### Passes screen

One row per pass, each independently shareable. Naming is optional and most supporters will skip it.

```
Ticket 1 of 4    [ Keep ]   [ Share ]
Ticket 2 of 4    [ Keep ]   [ Share ]
Ticket 3 of 4    [ Keep ]   [ Share ]
Ticket 4 of 4    [ Keep ]   [ Share ]
```

A four-square purchase yields four passes. A donated purchase yields none, and no admission line renders on the confirmation.

Pass display ordinals are derived from the supporter's current usable passes in sequence order. `AdmissionPass.sequenceNumber` is internal, monotonic, never reused, and never shown to the supporter. The QR encodes an opaque token, never a URL — see §6B.

### Returning

Same URL, same page. The meter has moved, the prizes have grown. That growth is the reason to come back and the reason to send the link on.

On a board with an event, a returning supporter also sees their passes. A second purchase mints its own passes on top of the existing ones - no allowance to check, nothing to re-ask.

---

## 6B. Volunteer surface

**Purpose-built layout, existing design tokens.** Not a reskin and not a second visual language. Same fonts and color variables so it belongs to the product, but laid out for a condition no other screen in Daali faces: outdoors, midday glare, one hand, a line of people, and a volunteer who has never seen the app and got no training.

| | |
|---|---|
| Result state | Full-viewport color flood, one word. Readable at arm's length |
| Roster rows | Minimum 64px tall. Thumb targets, not cursor targets |
| Chrome | None. No nav, no board branding, no menu |
| Structure | One screen. Scan button and search field both always visible |
| Search | Never behind a failed camera prompt. Always one tap, always |

That last row is load-bearing. Search is the **primary** path for every cash payer confirmed while standing at the gate, who has no QR yet because none existed until the host tapped confirm.

Roster rows are keyed to the supporter, not the purchase — one family, one row, however many times they bought in.

```
Daaliyah Tate
daaliyah@example.com · (770) 555-0142
3 passes · 2 used · 1 remaining
```

Search matches supporter name, email, and phone. A pass label, when one exists, is an additional index. The roster works correctly with zero labels entered, which is the realistic case.

**Undo** is a volunteer action. Misscans are the most common gate error and without undo the counter drifts until the host stops trusting it. Undo consumes nothing and creates nothing.

**Deliberately absent:** any money, any square, any grid, any drawing, any host setting. Volunteers consume entitlement and never create it (admission invariant 33).

### QR mechanics

**Payload is an opaque token, never a URL.** A link payload means anyone pointing a phone camera at their own pass reaches a check-in endpoint. Check-in must originate from the authenticated volunteer surface and nowhere else. An opaque token scanned by a stray camera app does nothing.

**Decoder:** a maintained JS library (`html5-qrcode` or `zxing-wasm`), not the native `BarcodeDetector` API — coverage is still uneven across iOS Safari versions and this has to work on whatever phone a parent brought.

**Camera:** permission requested on an explicit *Start scanning* tap, never on page load. Denial, unavailability, and failure all fall through to search with no dead end. Continuous scan — the volunteer should not tap once per person.

**The gotcha, and it needs host-facing copy.** `getUserMedia` is blocked inside iOS in-app browsers — Facebook, Instagram, and similar. If the host shares a volunteer link through a social app, the camera fails silently and the volunteer is stuck on search without knowing why. **Send volunteer links by SMS or email.** Put that sentence in the share UI, not in a support doc nobody reads.

---

## 7. Grid

No row or column meaning, so no axis math and no digit assignment.

- Always **10 columns**, wrapping. 25 → 3 rows (10/10/5). 50 → 5. 75 → 8. 100 → 10.
- **5 columns below 400px.**
- Confirmed squares show their number.
- Any non-open square renders as unavailable, no legend, no state colors — money doc §10.

**No legend.** Not "Open / Taken / Pending" in muted, green, and amber. A contributor sees available or not available; the state breakdown is the host's view. A legend also leaks how many squares are stuck mid-checkout, which is nobody's business but hers.

"Taken" and "Pending" are Game Day words besides. Nothing is taken from anyone.

Do not reuse the game grid component. Do not try to make 75 a rectangle.

**Branch before computing, not after.** The fundraiser path should return before reaching any Game Day calculation, so the list below is absent by construction rather than by omission. That is what keeps it true when someone later edits the Game Day header without reading this document.

### Must not appear on a fundraiser board

Enumerated because these leak through whenever a Game Day component is reused rather than replaced. Every item below was observed on a real fundraiser board before A4.

| Game Day element | Why it's wrong here |
|---|---|
| `TEAM A` / `TEAM B` axis labels | No teams. No axes. Nothing is being competed over |
| Axis digit assignment or randomization | No digit match. Numbers are positions, not draws |
| "Numbers will randomize immediately" on close | Close means CLOSING → finalization. Nothing randomizes |
| "Numbers are set. Board is live for game day" | There is no game day |
| "$3,000 total pot" | **Two errors.** There is no pot on a Phase A board, and `squares × price` is wrong arithmetic once early bird pricing exists |
| Score entry, period selection, winner-by-quarter | Money doc §2 — a fundraiser has no scores |

**Shared and correct:** the share panel and QR, and the square-claim flow. Those are board-agnostic and should not be duplicated.

**The cash mode toggle and PIN are neither.** See §6C.

### The header

Where Game Day shows pot, a fundraiser shows what has been raised.

**With a goal set:**

```
Hampton Homecoming Tailgate
$25 per square through Oct 3, then $30
$1,850 raised of $2,000
[==================----]
```

**Without one:**

```
Hampton Homecoming Tailgate
$30 per square
$1,850 raised
```

No bar, no denominator. This is why §6's above-the-fold block shows a bare raised figure and this section shows one with a goal — they are the same block in two states, not two specifications.

The raised figure is the **sum of `pricePaidCents`** on confirmed squares (invariant 43), never a count multiplied by a price.

On a Phase A no-prize board, no prize pool line renders.

### The goal is host-entered, not derived

`fundraisingGoalCents` on Board. Optional.

**No derivation from square count works once early bird exists.** `squares × standard` is unreachable, so the bar can never fill. `squares × early` overfills. And both are the `squares × price` arithmetic this section warns against, applied to the denominator instead of the numerator.

A host-entered goal sidesteps it and is better anyway — "we need $2,000 for new uniforms" is a real target, and a derived ceiling is not.

**Not locked by invariant 16.** A goal is aspirational, not a term of the deal: raising it changes nothing about what anyone already bought, and blowing past a goal and setting a stretch target is normal fundraiser behavior. The host may edit it any time.

Clamp the bar at 100% when raised exceeds the goal, and keep showing the real raised figure above it.

### After the changeover

Once the early bird date has passed, the price line collapses to the single current price. Naming a date that is already behind you is noise on a public board.

```
before   $25 per square through Oct 3, then $30
after    $30 per square
```

---

## 8. Prize presentation

Only when `prizePoolPercent > 0`.

**Above the fold:** pool total and drawing date. That's the "how much and when" question.

**Below the grid:** the ladder, current and potential.

```
Prizes right now          At 100 squares
1st   $292                1st   $400
2nd   $219                2nd   $300
3rd   $146                3rd   $200
4th   $73                 4th   $100
```

Potential is visually subordinate to current. Prize math and tier ratios are money doc §6 and are not restated.

Below that, small but legible — not 9pt gray:

> Hosts are responsible for any prize or drawing rules that apply where they are.

---

## 9. Host dashboard

Replaces score entry on fundraiser boards.

**Always visible:** raised, and the full state breakdown (money doc §10 host view) — confirmed, awaiting payment, in checkout, open. Awaiting payment is the number she works from; those are the contributors who have said they'll send money and haven't yet.

On a Phase A board there is no prize pool line.

**Awaiting payment panel:** confirm or release **per square**, never forced as a batch. Someone reserving 3 and arriving with $100 must be resolvable to 2 confirmed and 1 released — invariant 7.

**Pending panel:** batch age visible ("3 squares, held 12 min"). Manual release only after the hold expires, and only through the resolution sequence — invariants 18–19.

**Close:** early close requires resolving all outstanding cash inside the flow. Scheduled close needs no host action. Money doc §7.

**Close-flow warning, required:**
> Prize amounts are final once announced. If a contribution is later disputed through the contributor's bank, that amount comes out of your proceeds — not out of the prizes.

**Event panel (boards with an event only):**

```
84 expected · 9 reserved but unpaid
51 checked in · 33 remaining

[ Volunteer links ]   [ Roster ]   [ Donate flags ]
```

Expected counts `active` and `used` passes on active supporters. Donated purchases contribute zero, which is the point of the checkbox. The unpaid line counts admissions that would exist if outstanding cash reservations confirm - a chase list before she orders food, mirroring the amber/green split she already reads on the grid. It is a forecast, never a headcount, and never reaches the volunteer roster.

**Donate flags** lets her toggle a purchase's setting after the fact, for the supporter who decides to come after all or the one who cannot. Toggling to donate voids that grant's unused passes; toggling back mints new ones with new tokens. A `used` pass is never voidable.

Volunteer links are created, labeled ("Renee — main gate"), and revoked individually here. Each is scoped to one event and grants roster read and check-in only — never money, never the grid. The link is shown once at creation and stored hashed.

**Draw panel:** disabled until CLOSED. On completion, winner cards reuse the Phase 1 layout — name, place, amount, contact. Host pays out externally. **Daali does not move prize money.**

---

## 10. Draw and results

After the draw, the same public URL becomes the results page. Same link people already have.

```
🎉 We raised $4,150 for the Hampton Parent Homecoming Tailgate

Drawing held September 30, 8:04 PM ET

1st  #23  Renee M.   $332
2nd  #71  Marcus T.  $249
3rd  #12  Dana W.    $166
4th  #58  Priya S.   $83
```

**Audit section, permanent and public:**

- Every eligible ticket number in the pool, and the count
- Draw timestamp
- Winning numbers
- Host/admin squares marked: `#37 — Organizer contribution — not eligible for drawing`
- Title change history, if any: `Campaign title updated August 29 · Previous: Hampton Parent Tailgate 2026`

A contributor must be able to open the link and confirm their number was in the pool before the draw ran. This is cheap and it is the entire basis for trusting the result.

Grid becomes read-only.

---

## 11. Editing and cancellation

**Locked after the first confirmed contribution** (invariant 16): square count, the contribution price schedule, prize on/off, prize percent, tier count, drawing rule, drawing date, and — on boards with an event — the event date.

There is no attendee allowance to lock. One confirmed square mints one admission pass (admission invariant 24).

**Not locked:** the fundraising goal. It is aspirational rather than a term of the deal, and raising it changes nothing about what anyone already bought.

**Always editable:** title, description, contact details, payment handles.

**Title is special.** On a fundraiser the title *is* the cause. It stays editable — real corrections happen — but after the first confirmed contribution every change writes to `titleHistory` and displays in the public audit. No alarm, no confirmation modal. Just a record.

This narrows the existing edit-board behavior, which allows silent `gameName` edits at any status. That reasoning still holds for Game Day and is unchanged there.

**Cancellation.** Before the first contribution the host may delete freely.

After the first contribution there is no delete and no cancel — contributions are final (invariant 4) and there is no refund path (invariant 5). The action becomes **Close Fundraiser Early**:

> Stop accepting contributions now. Resolve outstanding cash. Finalize what you raised. If prizes are enabled, the drawing proceeds as disclosed.

This is the CLOSING phase (money doc §7), reached early. Nothing about finalization or the draw changes.

---

## 12. Notifications

**Email, two moments:**

1. **Confirmation**, immediately — square numbers, amount, and on prize boards the ticket numbers and drawing date.
2. **Draw result**, to everyone. Winners get their amount and a request for a payout handle. Non-winners get the total raised and a thank you — they contributed to something that worked.

**SMS is dormant** until A2P clears. **Resubmit the Twilio campaign now, separately from this build.** The rejection was for squares/winners/payouts language; a fundraising platform with contribution receipts and drawing notifications is a materially different and accurate description. Do not gate this spec on it — email is primary.

---

## 13. Landing page

`landing-page-rebrand.md` needs three corrections before it ships, because it was written against the earlier model:

1. Fundraiser boards have **no game and no score.** Remove any squares-with-a-goal framing.
2. Prizes are a **percentage of confirmed contributions**, not a fixed amount. "Prizes grow as the board fills" is the story.
3. Board sizes are **25 / 50 / 75 / 100**, not always 100.

The page must not promise a flow this spec doesn't build. Hero mockups showing a dollar meter are now accurate — they weren't before.

---

## 14. Monetization

### Phase A: fundraiser boards are free

**No credit gate, no `pending_payment`, no fee.** A fundraiser board activates the moment it is created.

Game Day keeps the credit system exactly as it is. This is a fundraiser-only bypass, not a change to Game Day.

**The one-pending-board-per-host guard is Game Day only.** It runs before the creation paths, so a host sitting on an unpaid Game Day draft would otherwise be blocked from creating a fundraiser — a board that needs no credit, refused by a gate belonging to a different board type. Scoping it is part of the bypass, not an optional tidy-up.

### Credits are the wrong instrument here

An earlier version of this section said cash squares "fall back to one credit." That routes a fundraiser board through `pending_payment` and puts a $9 gate in front of a host raising money for a school. Wrong on its own terms, and it also contradicted §15, which listed the credit system as unchanged.

Game Day credits work because a board is a discrete event with a known host who runs a few per season. A fundraiser is a campaign that may raise $200 or $20,000, and charging the same $9 for both is neither fair nor defensible.

### The unsolved problem, for whoever picks this up

**Most fundraiser money will never touch Stripe.** Direct payment by Zelle, CashApp, Venmo, or PayPal goes host-to-contributor, and Daali cannot take a percentage of money it never handles.

That constrains every model:

| Model | Works on card | Works on direct payment | Problem |
|---|---|---|---|
| Percentage via Connect `application_fee_amount` | Yes | **No** | Boards that are mostly Zelle pay almost nothing |
| Flat fee per board, up front | Yes | Yes | Same gate as credits, and it is what credits already were |
| Flat fee invoiced at close, on `finalRaisedCents` | Yes | Yes | Requires collecting from a host after the fact |
| Percentage of `finalRaisedCents`, invoiced at close | Yes | Yes | Same |

The last two are the only models that scale with the size of the campaign **and** survive a board where nothing went through Stripe. Both need a collection mechanism that does not exist.

**Not deciding this now.** Phase C. It needs a real decision rather than a default, and defaulting is exactly what the credit fallback was.

### When it lands

Charged to host proceeds. **No contributor-facing tip prompt and no cover-the-fees checkbox.** Contributors see the square price and nothing else.

---

## 15. Unchanged

Game Day in every respect · Stripe Connect onboarding · payout coordination · manual payout model · host onboarding.

**Changed for fundraiser boards:** the cash mode toggle and PIN (§6C), and the credit system and `pending_payment` flow (§14). Both still apply to Game Day unchanged. An earlier version of this section listed both as unchanged everywhere, which is how a $9 credit gate ended up in front of a school fundraiser.

---

## 16. Build order

**Nothing in this document is built yet.** As of the admission review, the repo contains no `boardType`, no fundraiser columns, no `FreeEntry`. Everything below starts from zero.

### Phase A — No-prize fundraiser + admission (Hampton)

Prize boards are **deferred**, by decision, not by configuration. `prizePoolPercent` stays in the schema defaulted to 0, and the prize fields do not render on the form. A host cannot turn prizes on in Phase A, because a toggle that produces a board with no draw behind it is worse than no toggle.

| # | Step | Live-next-week? |
|---|---|---|
| A1 | Schema migration 1 — fundraiser columns, `FreeEntry`, backfill `boardType = "game"` | ✅ |
| A1b | Schema migration 2 — admission tables (addendum §3). Migration 3 adds `donate_admissions` | ✅ |
| A2 | Board type picker | ✅ |
| A3 | Fundraiser form + API branch. **Event block. Dates. Early bird.** No prize fields. **No credit gate** — §14 | ✅ |
| A4 | Fundraiser grid + contributor board | ✅ |
| A4b | **Fundraiser host dashboard** (§9) + contributor confirmation page (§6) | ✅ |
| A5 | Claim flow: quantity, picker, batching, `pricePaidCents`, **admission preparation** | ✅ |
| A6 | Hold timer + resolve-then-release cron | ✅ |
| A8 | **Admission activation** — shared `confirmSquare`, minting, backfill | — |
| A7 | CLOSING + finalization — `finalRaisedCents` only | — |
| A9 | Passes screen, host donate-flag toggle | — |
| A10 | Volunteer surface, QR, roster, search, check-in, undo | — |

**A1–A6 is the live-next-week set.** A7 isn't needed until the campaign actually closes, weeks later, and can land while squares are selling.

### A8 moved ahead of A7

Minting happens at confirmation, and confirmation never runs again for a square. Every square confirmed before A8 ships is `paid`, carries a grant, and has no pass.

Ship A8 after launch and you inherit three things: a backfill against live contributor money, a "here are your passes" email that would otherwise be unnecessary, and temporary receipt copy to unwind. Ship it before and none of them exist — the first contributor gets passes the moment they pay.

A7 is not needed until the campaign closes weeks later, so it loses nothing by moving behind.

**Until A8, the confirmation page says nothing about admission.** Not a promise of passes arriving later — a receipt that names something the person cannot see or click is worse than one that stays quiet, and temporary copy describing a delay would still be there in October, describing a delay that no longer exists.

### A4b was missing from this table

§9 specifies the host dashboard in detail and no step ever claimed it. A4 reads "grid + contributor board," so the host side fell between A4 and A7 with nothing owning it — which is why a fundraiser board opened as host still shows the pot, score entry, and "Numbers will randomize immediately."

§7's must-not-appear list applies to **every fundraiser surface, host included.** It was written from a contributor screenshot and reads as though it only governs the public board. It does not.

The confirmation page is the same kind of omission, smaller: §6 specifies it, no step claimed it.

### Why the event block and preparation moved earlier

Both were originally in the admission slices. Both had to move once squares go live before admission does.

**Event block to A3.** Invariant 16 locks the event date at the first confirmed contribution. If admission is configured later, early supporters bought a bare square while later ones bought a square that admits someone, at the same price — and the early ones backed the cause first. Configuring the event at board creation means everyone gets the same disclosed offer. The block collects name, date, and venue. The passes screen comes at A9.

**Donate checkbox to A5**, with preparation. It is written into the grant, so it has to exist when the grant is first written. Deferring it to A9 would give every contributor between launch and A9 `donateAdmissions = false` with no way to opt out — the same backfill-under-pressure problem that moved preparation here.

**Preparation to A5.** Resolve the supporter and write the grant, carrying the donate checkbox. Without it, every contributor between launch and A8 has no `EventSupporter` row and needs a backfill written under time pressure against live money.

**Consequence: the admission tables move to A1b**, not A8. A5 cannot write to tables that don't exist. Two migration files rather than one, both written before either is applied — that keeps the review separation without a timing gap.

A1–A6 is a working no-prize fundraiser that quietly accumulates admission state. A8–A10 light it up. Ship there and run Hampton.

### Phase B — Prizes

| # | Step |
|---|---|
| B1 | Prize fields on the form + live preview |
| B2 | Drawing eligibility, `finalPrizePoolCents`, prize tiers |
| B3 | Draw + audit display |
| B4 | Free-entry data path (no UI) |
| B5 | Winner notification + payout coordination |

**The eleven tests in money doc §11 gate B3.** They are not on the Phase A critical path.

### What Phase A does not have to solve

No tickets of any kind, since tickets exist only when `prizePoolPercent > 0`. No draw, no tiers, no `finalPrizePoolCents`, no immutable-pool-versus-disputed-contribution problem, no free entry, no winner notification, no payout coordination. Money doc invariants 8–14 and 17 are dormant. This is a materially smaller object than the one this document was originally written around.

### Phase C — later

Email notifications. Platform fee, separate PR.

### Admission — three slices, in order

| Slice | Contents | Visible? |
|---|---|---|
| **1** | Schema, `admission.ts`, claim-time preparation, activation in the confirmation transaction | No. Nothing user-facing |
| **2** | Passes screen, host donate-flag toggle | Contributor and host |
| **3** | Volunteer surface, QR generation and scanning, roster, search, check-in, undo | Gate |

Slice 1 is where a mistake is expensive and silent. Review it before Slice 2 starts. Handoff brief: `slice-1-handoff.md`.

---

## 17. Before writing code

**Cite rules by name, never by number.** `SYSTEM-FLOW.md` has gained rules over time — the double-grid work inserted one — so "Rule 7" points at different text depending on which copy you are reading. Refer to **the document-first rule** and **the check-before-pushing rule** instead. Any numbered citation in these documents is stale by construction.

**Superseded rule.** An earlier version of this section required a full fundraiser branch in `SYSTEM-FLOW.md` before any fundraiser code was written. That requirement is **retired and replaced by the two rules below.** It is recorded here rather than deleted so nobody reinstates it from memory.

**Rule A — this document is the flow authority for fundraiser boards.** Everything fundraiser, including admission: screens, flows, auth, build order. `SYSTEM-FLOW.md` remains the authority for Game Day. The document-first rule is satisfied for fundraiser work by writing here first.

**Rule B — the full SYSTEM-FLOW fundraiser backfill is deferred and blocks nothing.** It does not block Admission Slice 1, Slice 2, or Slice 3. It remains a real gap and a real backlog item: SYSTEM-FLOW covers Game Day only, so anyone following the check-before-pushing rule who looks only there finds a map without the territory. (Do not cite a date for that file — copies in circulation differ, and the repo's is newer than any of them.) The pointer added to its Quick Summary is what redirects them here.

**What SYSTEM-FLOW carries for admission** — three edits, no more, specified in `system-flow-port.md`. They must be **ported onto the repo's current copy**, never applied by overwriting the file. The repo's version is newer than any copy circulating in project knowledge and contains the double-grid feature.

---

## 18. Open questions

1. **Does the host see contributor identities before close?** Phase 1 exposes payout handles to the host. Fundraiser collects less. Assumed: name and contact yes, nothing more.
2. **Share card image.** These links get pasted into group chats — an OG image showing the title and meter would carry the campaign. Not scoped here. Worth its own ticket.
3. **What happens to a board that closes with zero contributions?** Assumed: closes normally, no draw, no results page.

---

*End of spec.*
