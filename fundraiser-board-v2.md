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
| `src/lib/admission.ts` | **NEW** — sole owner of pass lifecycle: resolve, declare, activate, allowance |
| `src/app/api/webhooks/stripe/route.ts` | Activation joins the batch confirmation transaction |
| *existing cash confirm route* | Same activation call. Locate it; do not guess the path |
| `src/lib/cron/release-expired.ts` | Clean up orphaned pending grants |
| `src/app/host/boards/new/fundraiser-form.tsx` | Optional event block — §5 |
| `src/app/board/[slug]/claim-sheet.tsx` | Attendance step, first purchase only — §6 |
| `src/app/board/[slug]/passes/page.tsx` | **NEW** — passes screen |
| `src/app/board/[slug]/attendance/page.tsx` | **NEW** — Manage attendance, token-gated |
| `src/app/api/attendance/request-link/route.ts` | **NEW** — §6A |
| `src/app/api/attendance/route.ts` | **NEW** — declare / adjust, token-gated |
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
| `cashModeEnabled`, `cashPin` | Unchanged |

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
| Early bird price | Optional. Min $1, must be below the standard price |
| Early bird ends | Required if an early bird price is set. Date + time |
| **Campaign closes** | **Required.** Date + time → `campaignEndsAt` |
| Timezone | **Required.** IANA. One per board, covering all dated fields → `timezone` |
| Cash hold window | Default 7 days. Only if cash mode on. |
| Payment handles | The four host handles only — this is how contributors pay |

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

### One timezone per board

A single selector covers early bird, campaign close, draw date, and event. Stored as `Board.timezone`; `Event.timezone` reads from it.

The field was previously called `drawTimezone`, which was never accurate — it always described the board, and on a Phase A no-prize board there is no draw for it to belong to. Renamed before either migration is applied.

**A separate event timezone is not supported.** A school fundraiser and its tailgate are in the same place. If a national organization ever needs otherwise, that is a second field and a doc change, not an assumption to build in now.

**`datetime-local` gives wall-clock time with no zone.** Parsing it on a UTC server silently shifts it — a 7pm New York close becomes 2pm. Conversion must be explicit and zone-aware. `campaignEndsAt` gates money and `cashHoldDays` caps against it, so this is not cosmetic.

### DST disambiguation

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

The conversion helper takes the policy as an explicit argument rather than defaulting. A generic helper cannot know whether it is resolving a deadline or a start time, and picking one convention silently makes it wrong half the time.

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

    Event name                    [defaults to campaign title]
    Date and time                 [required]
    Venue                         [optional]
    Max attendees per supporter   [1-10, default 4]
```

**Independent of the drawing date.** No validation relates the two. The event may fall before, on, or after the draw, and admission stays valid after the board reaches CLOSED and DRAWN (admission invariant 36).

Per supporter, not per purchase. A second square bought later draws from the same allowance and never re-asks (admission invariant 28).

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

### Attendance step — boards with an event only

Rendered **after** the contact fields, because identity resolves on normalized email.

**First purchase** — one number, no names:

```
How many people are attending?
0 · 1 · 2 · 3 · 4
```

Zero is a real answer. A supporter three states away is not driving down, and a picker that starts at 1 inflates the host's headcount by every remote contributor — the one number this feature exists to produce.

**Returning supporter** — no picker, ever:

```
You're attending with 2 people.
Your event limit is 4.
[ Manage attendance ]
```

Existence of an `EventSupporter` row is the test, not its status. Someone whose first purchase is still an unconfirmed cash reservation is a returning supporter and sees the status line.

A second square means one thing: another drawing chance. Admission is untouched by it.

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

Drawing Ticket #23
3 Admission Passes

[ View your passes ]
```

Never call an admission pass a ticket. A drawing ticket keeps its existing meaning — an entry in the drawing, numbered to the square, derived rather than stored. The display strings are **Drawing Ticket** and **Admission Pass**, never interchangeable.

### Passes screen

One row per pass, each independently shareable. Naming is optional and most supporters will skip it.

```
Pass 1 of 3    [ Keep ]   [ Share ]
Pass 2 of 3    [ Keep ]   [ Share ]
Pass 3 of 3    [ Keep ]   [ Share ]
```

Pass display ordinals are derived from the supporter's current usable passes in sequence order. `AdmissionPass.sequenceNumber` is internal, monotonic, never reused, and never shown to the supporter. The QR encodes an opaque token, never a URL — see §6B.

### Returning

Same URL, same page. The meter has moved, the prizes have grown. That growth is the reason to come back and the reason to send the link on.

On a board with an event, a returning supporter also sees their attendance state and a Manage attendance entry point.

---

## 6A. Manage attendance — authentication

**A new auth path. Not the shipped Player Resume Checkout flow**, which matches on email alone.

That match is fine where it lives: the only thing it unlocks is the right to pay for your own abandoned square. It is not fine here. Knowing an address must not let a stranger void a family's passes an hour before the event.

### Flow

1. Supporter taps **Manage attendance**, enters their email
2. `POST /api/attendance/request-link` — **always the same response**, matched or not. No enumeration.
3. If matched, an email carries a raw single-use token
4. Following the link consumes the token and opens a session scoped to **that one supporter on that one event**, 30 minutes
5. Inside that session: raise attendance to the ceiling, lower it, label passes, re-send passes

### Rules

- Token stored hashed. The raw value exists only in the email.
- 20-minute TTL, single use. A new request invalidates outstanding ones.
- Rate limit by email and by IP. This endpoint sends mail on request.
- The session grants nothing outside that supporter's own attendance. No squares, no money, no other supporters.
- **Decrease** is free any time before the event and voids `active` passes only — a `used` pass is never voidable.
- **Increase** is free up to the ceiling. That is claiming entitlement already granted, not creating new entitlement.
- Every path closes at the event start time. At the gate it becomes a volunteer or host action.

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

Do not reuse the game grid component. Do not try to make 75 a rectangle.

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

**Always visible:** raised, prize pool, and the full state breakdown (money doc §10 host view) — confirmed, cash reserved, in checkout, open. Cash reserved is the number she works from; those are the parents who owe her money before close.

**Cash panel:** confirm or release **per square**, never forced as a batch. Someone reserving 3 and arriving with $100 must be resolvable to 2 confirmed and 1 released — invariant 7.

**Pending panel:** batch age visible ("3 squares, held 12 min"). Manual release only after the hold expires, and only through the resolution sequence — invariants 18–19.

**Close:** early close requires resolving all outstanding cash inside the flow. Scheduled close needs no host action. Money doc §7.

**Close-flow warning, required:**
> Prize amounts are final once announced. If a contribution is later disputed through the contributor's bank, that amount comes out of your proceeds — not out of the prizes.

**Event panel (boards with an event only):**

```
126 expected · 12 declared but unpaid
74 checked in · 52 remaining

[ Volunteer links ]   [ Roster ]
```

Expected counts **active** supporters only. The unpaid line is a chase list before she orders food, mirroring the amber/green split she already reads on the grid. It is a forecast, never a headcount, and it never reaches the volunteer roster.

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

**Locked after the first confirmed contribution** (invariant 16): square count, contribution price, prize on/off, prize percent, tier count, drawing rule, drawing date, and — on boards with an event — event date and the maximum attendee allowance per supporter.

Lowering the allowance later never invalidates passes already issued.

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

## 14. Platform fee — 3%

**Ship after the board works.** Not in the first PR.

- Fundraiser boards: 3% via Stripe Connect `application_fee_amount` per charge
- Game Day boards: credit system unchanged
- Cash squares: no collectable fee — falls back to one credit

Charged to host proceeds. **No player-facing tip prompt and no cover-the-fees checkbox.** Contributors see the square price and nothing else.

---

## 15. Unchanged

Game Day in every respect · cash mode PIN and reserve/confirm · Stripe Connect onboarding · credit system and `pending_payment` flow · payout coordination · manual payout model · host onboarding.

---

## 16. Build order

**Nothing in this document is built yet.** As of the admission review, the repo contains no `boardType`, no fundraiser columns, no `FreeEntry`. Everything below starts from zero.

### Phase A — No-prize fundraiser + admission (Hampton)

Prize boards are **deferred**, by decision, not by configuration. `prizePoolPercent` stays in the schema defaulted to 0, and the prize fields do not render on the form. A host cannot turn prizes on in Phase A, because a toggle that produces a board with no draw behind it is worse than no toggle.

| # | Step | Live-next-week? |
|---|---|---|
| A1 | Schema migration 1 — fundraiser columns, `FreeEntry`, backfill `boardType = "game"` | ✅ |
| A1b | Schema migration 2 — admission tables (addendum §2) | ✅ |
| A2 | Board type picker | ✅ |
| A3 | Fundraiser form + API branch. **Event block. Three dates. Early bird.** No prize fields | ✅ |
| A4 | Fundraiser grid + contributor board | ✅ |
| A5 | Claim flow: quantity, picker, batching, `pricePaidCents`, **admission preparation** | ✅ |
| A6 | Hold timer + resolve-then-release cron | ✅ |
| A7 | CLOSING + finalization — `finalRaisedCents` only | — |
| A8 | Admission activation in the confirmation transaction | — |
| A9 | Attendance step, passes screen, Manage attendance + token auth | — |
| A10 | Volunteer surface, QR, roster, search, check-in, undo | — |

**A1–A6 is the live-next-week set.** A7 isn't needed until the campaign actually closes, weeks later, and can land while squares are selling.

### Why the event block and preparation moved earlier

Both were originally in the admission slices. Both had to move once squares go live before admission does.

**Event block to A3.** Invariant 16 locks event terms at the first confirmed contribution. If admission is configured later, early supporters bought a square and later supporters bought a square plus admission for four, at the same price — and the early ones backed the cause first. Configuring the event at board creation means everyone gets the same disclosed offer. The block collects name, date, venue, and max attendees per supporter. The attendance picker and passes still come at A9.

**Preparation to A5.** Resolve the supporter, write the grant, `declaredCount = 0`. Without it, every contributor between launch and A8 has no `EventSupporter` row and needs a backfill written under time pressure against live money.

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
| **2** | Event block on the create form, attendance step, passes screen, Manage attendance + token auth | Contributor and host |
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
