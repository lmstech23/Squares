# Fundraiser Launch Readiness — Addendum

**Status:** **READY FOR FREEZE** — product decisions applied. Invariants 71–90.
**Version:** 2.1 — environment-blocked test annotation
**Companion to:** `fundraiser-money-state-machine.md` (authority on money) · `fundraiser-board-v2.md` (authority on flows) · `fundraiser-admission-addendum.md` (authority on passes) · `fundraiser-signup-addendum.md` (authority on helpers) · `fundraiser-donations-addendum.md` (authority on the ledger)

Adds three deferrals so a fundraiser can start collecting money before its configuration is complete.

---

## Rule of this document

**Launch principle:** fundraising starts before regular pricing and volunteer-role planning are finished.

Three requirements share one shape — something that used to be a precondition becomes a later step — so they are handled together rather than scattered across three documents. Each amends a different owner:

| Part | Amends |
|---|---|
| 1 — Deferred regular price | Money doc invariant 16 and §8B · board v2 §3, §5, §6, §7 |
| 2 — Dietary attributes | Admission addendum §3, §7, §8 |
| 3 — Volunteer interest | Signup addendum §4 and invariant 36 |

**Does not change:** square states, the hold-and-release sequence, the draw, pass minting, or slot mechanics. Where this document appears to disagree with the money doc, the money doc wins and this document is wrong.

**Numbering.** This document owns invariants **71–90**. The earlier collision is resolved; see donations addendum §0 and `invariant-registry.md`.

---

# Part 1 — Deferred regular price

## 1.1 What is optional, and what is not

Stated plainly because the first reading of this requirement was wrong, and the wrong version is the more natural thing to assume:

> **A fundraiser does not launch without a square price.** It launches with the **early bird price**, which is fully configured and fully active. The **regular price** — the one that takes effect after the early bird window ends — is what may be set later.

Square purchasing works **normally** at launch. Nothing is paused, nothing is degraded, and nobody is buying at an undefined price. The deferral only affects a moment in the future that has not arrived.

### Valid launch configurations

| Configuration | `earlyBirdPriceCents` | `earlyBirdEndsAt` | `squarePrice` | Valid |
|---|---|---|---|---|
| Flat pricing *(board v2, unchanged)* | null | null | set | ✅ |
| **Early bird first, regular deferred** | set | set | **null** | ✅ **new** |
| Early bird with regular set up front | set | set | set | ✅ |
| Nothing priced | null | null | null | ❌ |
| Early bird with no end date | set | null | either | ❌ *(existing CHECK)* |

**Decided: flat pricing is preserved.** Early bird is required only on the deferred-regular-price path, because early bird is what carries the launch there. A host who wants one price for the whole campaign sets one price, exactly as board v2 specifies, and never sees an early bird field.

### The rename — decided, and it ships first

**`squarePrice` → `regularPriceCents`**, field and column, in its own PR ahead of everything else.

It is migration-cheap in the only sense that matters: `ALTER TABLE ... RENAME COLUMN` moves no data, rewrites no rows, and cannot lose anything. What it touches is **shipped Game Day code** — board creation, the player board, `confirm-cash`, the payout preview — so the cost is a grep and one atomic commit, not a data risk.

**Do it now, for one reason:** the column only became ambiguous when it acquired a sibling. `squarePrice` next to `earlyBirdPriceCents` reads as "the price of a square," which is what `earlyBirdPriceCents` also is. Every future reader has to work out which one is in effect. That confusion has a permanent cost and the rename has a one-time one.

**Do not add a second column.** A board carrying both `squarePrice` and `regularPriceCents` has two fields meaning the same thing and one will be wrong.

**One thing to verify before writing the migration:** confirm `squarePrice` is stored in **cents**. `confirm-cash` passes it straight into `PaymentReference.amount`, and board v2's form says "Contribution per square, min $1." If it is stored in dollars, the new name asserts something false and the correct target is `regularPrice`. Check the column, not the form label.

---

## 1.2 Effective price — one function, derived at claim

```
effectivePrice(board, now):
    if board.earlyBirdEndsAt is not null and now < board.earlyBirdEndsAt:
        return board.earlyBirdPriceCents          # always set when earlyBirdEndsAt is
    return board.squarePrice                      # may be null → no price
```

Two sources. No third. **No inference, no copy from one field to the other, no default, no fallback, no last-known-good.** If this function returns null, it returns null, and the caller pauses. It never produces a number.

That sentence is the entire safety property of Part 1. A function that helpfully falls back to the early bird price when the regular price is missing would charge people the discount forever, after the deadline the host advertised, with no record of a decision anywhere.

**One caller.** `effectivePrice` lives in one module and every claim path goes through it — card claim, cash reservation, host-entry square, and the create-form preview. The board v2 rule that price is locked at claim rather than at payment is unchanged; this only names where the number comes from.

---

## 1.3 The paused state

When `effectivePrice` returns null, the board is **paused for square sales**.

```
OPEN ─────────────────────────────▶ CLOSING → CLOSED → DRAWN
  │
  └── square sales: available ⇄ paused        (derived, orthogonal to status)
```

**Paused is not a board status.** The board is still `OPEN`. It closes on schedule, it finalizes normally, and `CLOSING` is unaffected. Paused is a derived read on top of an open board.

```
paused  ⟺  boardType = 'fundraiser'
           AND earlyBirdEndsAt IS NOT NULL
           AND now >= earlyBirdEndsAt
           AND squarePrice IS NULL
```

**Derived, never stored.** The transition fires on a timestamp with no event behind it — nobody does anything at 11:59pm, the clock simply passes. A stored flag would need a cron to maintain, and a cron that runs late leaves squares purchasable at a price that no longer exists. This mirrors the signup addendum's treatment of eligibility: *derived from state, never a column that can drift out of sync with the thing it describes.*

### What pauses

| | Paused |
|---|---|
| Card square claim | ❌ blocked |
| Cash square reservation | ❌ blocked |
| Host-entry square | ❌ blocked |
| **Donations, card and cash** | ✅ **unaffected** |
| Confirmation of an already-claimed square | ✅ **unaffected** |
| Cash confirm/release on existing reservations | ✅ unaffected |
| Free entries | ✅ unaffected — they move no money |
| Close, finalization, draw | ✅ unaffected |

**Blocked at the API, not only in the UI.** A hidden button is not a constraint. The claim endpoints reject with a specific error when `effectivePrice` is null, and the pause is asserted server-side inside the same transaction that would create the squares.

### Claims in flight across the changeover

A square claimed at 11:58pm at the early bird price, with a ten-minute hold that crosses midnight into a paused board, **confirms at the price it was claimed at.** Board v2 already settles this — price is fixed at claim or reserve, not when payment lands — and pausing changes nothing about it. The same holds for a cash square reserved during early bird and confirmed by the host a week into the pause: she is owed the early price, and her cash panel shows the amount that square was reserved at.

**Pause blocks new claims. It never touches existing ones.**

---

## 1.4 Immutability

Invariant 16 currently locks *contribution price* at the first confirmed square contribution. With two prices that become effective at different times, one trigger is no longer enough.

> **Amendment.** The early bird fields (`earlyBirdPriceCents`, `earlyBirdEndsAt`) lock at the first confirmed square whose `priceSource = early_bird`. The regular price (`squarePrice`) locks at the first confirmed square whose `priceSource = regular`. Neither lock affects the other. Everything else in the invariant 16 list is unchanged and still locks at the first confirmed square contribution of any kind (per donations addendum, a donation locks nothing).

**The guarantee is preserved exactly.** The rule was always "you cannot change the terms someone already bought under." A regular price nobody has paid is not a term anyone bought under. The moment it participates in confirmed square economics, it is frozen under the identical rule.

### `priceSource`

New enum on `Square`: `early_bird` · `regular`. Written alongside `pricePaidCents` when the square leaves `open`.

It is derivable — compare `pricePaidCents` against the two board prices, which the existing `earlyBirdPriceCents < squarePrice` CHECK guarantees are distinct — but derivation by comparison is the kind of thing that silently produces the wrong answer if the CHECK is ever relaxed. One enum makes the lock trigger a plain `EXISTS` query and makes the audit legible. It is cheap and it is written at a call site that already exists.

### Price history

Every change to `squarePrice` before it locks writes to `priceHistory` on the board and displays in the public audit, exactly as `titleHistory` does:

```
Regular price set October 1 · $30 per square after October 3
Regular price updated September 28 · Previous: $28
```

No alarm, no modal. Just a record. The reason is the same as it is for the title: the public page has been advertising *"$25 through October 3, then $30"* to people deciding whether to buy now, and a silent change to that number is the kind of thing that looks like bad faith when someone notices it later.

**A regular price must be strictly greater than the early bird price.** Rejected at the set-later endpoint with a real message, not a generic 400. An "early bird price" that isn't lower than the regular price is not an early bird price, and the host has almost certainly typed the two into the wrong fields.

---

## 1.5 Public copy

**During early bird, regular price not yet set:**

```
Hampton Homecoming Tailgate
$25 per square through October 3
$1,850 raised of $2,000
```

The deadline is stated because urgency is the point. **The "then $X" clause is omitted entirely.** No placeholder, no "then TBD," no "price increases after." Printing a partial sentence about a number that does not exist invites the reader to assume one.

**During early bird, regular price set** — board v2's existing copy, unchanged:

```
$25 per square through October 3, then $30
```

**Paused:**

```
Square purchases are paused right now.
You can still support the fundraiser.

[ Donate ]
```

Not an error, not a dead end, and never a countdown or a "check back soon." The donate path is fully working and is the correct thing to offer. This is the same principle as the release message in board v2 — an explanation with a way forward.

**On a board where the host has switched donations off**, the paused state is read-only until she sets a price. That is correct — she has disabled the only remaining action, and the §1.6 banner tells her exactly what to do.

### The create-form preview

Board v2 shows a raise range: *"If all 100 squares fill you raise $2,500 – $3,000."* With no regular price the high end is unknown, so the range collapses to its low end and says so:

```
At the early bird price, 100 squares raises $2,500
Set your regular price to see the full range
```

Never invent the high end.

---

## 1.6 Host warning

This is the requirement most likely to be under-built, because it works fine right up until it doesn't.

**Dashboard banner, from creation, whenever `squarePrice` is null and an early bird end date is set:**

```
⚠ Set your regular price before October 3

Square purchases will pause when early bird pricing ends
unless a regular price is set. Donations keep working.

[ Set regular price ]
```

Escalates in prominence at T-7 days, T-1 day, and after the pause has begun — where the copy changes from future tense to present:

```
⚠ Square purchases are paused. Set a regular price to resume.
```

**Email reminders at T-7 and T-1 ride on the notification infrastructure the signup addendum introduces** (`NotificationDelivery`, with its dedupe key and delivery lease). They are not a precondition for this feature — the dashboard banner is — and they should not be built ahead of that table. A host who never opens her dashboard is the exact person this is for, so they should land soon after.

---

## 1.7 Schema

### Board

| Field | Change |
|---|---|
| `squarePrice` | **Nullable for fundraiser.** Required for game — branch the API validation and relax the column |
| `priceHistory` | **New.** `Json?`. Array of `{field, previousValue, newValue, changedAt}` |

### Square

| Field | Change |
|---|---|
| `priceSource` | **New.** enum `early_bird` · `regular`. Written with `pricePaidCents` when the square leaves `open` |

### Constraints

```sql
-- at least one price must exist on a fundraiser
CHECK (board_type = 'game'
       OR square_price IS NOT NULL
       OR (early_bird_price_cents IS NOT NULL AND early_bird_ends_at IS NOT NULL))

-- game boards still require a price
CHECK (board_type = 'fundraiser' OR square_price IS NOT NULL)

-- amended: the existing early-bird ordering check, made explicit about nulls
CHECK (early_bird_price_cents IS NULL
       OR (early_bird_ends_at IS NOT NULL
           AND (square_price IS NULL
                OR early_bird_price_cents < square_price)))
```

**The third one needs care and is the trap in this part.** The existing constraint reads `early_bird_price_cents < square_price`. In SQL a comparison against NULL evaluates to unknown, and **a CHECK constraint passes on unknown** — so the existing constraint would already permit a null regular price silently, without anyone deciding to allow it.

That is the same class of problem the admission addendum flagged about retired columns: *check `is_nullable` and `column_default`, not just whether anything reads it.* The constraint is being rewritten to state the permission explicitly rather than inherit it from three-valued logic that nobody reviewed.

---

# Part 2 — Dietary information

## 2.1 The owning record

**`EventSupporter`.**

The requirement is that this follows the attendee rather than the payment transaction. The admission model offers three candidates and two of them are wrong:

| Candidate | Verdict |
|---|---|
| `AdmissionGrant` | ❌ **This is the payment transaction.** One grant per purchase. A supporter who buys twice gets two grants and two contradictory answers |
| `AdmissionPass` | ❌ **Reintroduces the declaration model.** Per-pass dietary means asking "for each of your four passes, dietary needs?" — which requires naming and managing each attendee. Admission addendum 2.0 deliberately removed exactly that: no picker, no per-supporter ceiling, no management screen |
| **`EventSupporter`** | ✅ Already defined as *"one person's identity on one event, across all their purchases. The roster unit."* One person, one set of answers, survives multiple purchases |

`EventSupporter` is the attendee record. Dietary goes there.

## 2.2 Multi-admission purchases — what launch does and does not do

This is the sharpest edge in Part 2 and it needs stating before anyone builds a catering report off it.

**Launch collects one dietary response per supporter. Per-attendee dietary collection is deferred.**

A supporter who buys four squares gets four admission passes and answers the dietary questions **once**. The system knows one thing about her group and does not know how it distributes across the four people.

### The question must not be phrased as if it covers everyone

Wording is a copy decision but the *shape* is not. The question asks about the responder, with room to speak for the party:

```
Any dietary needs we should know about?

  [ ] Vegetarian
  [ ] No red meat

  Food allergies or anything else  [                    ]

  You have 4 admission passes. If others in your group have
  different needs, add them in the box above.
```

The pass count is shown deliberately. It is the one place the supporter can see the gap between what is being asked and what the host will act on, and it converts a silent modelling limitation into a visible prompt.

### The limitation, stated plainly

| Launch knows | Launch does not know |
|---|---|
| This supporter's party includes at least one vegetarian | How many of her four are vegetarian |
| This supporter reported an allergy | Which attendee has it |
| 9 supporters flagged vegetarian, holding 23 passes between them | Whether the vegetarian count is 9 or 23 |

**A boolean on a supporter with four passes is a flag, never a count.** Nothing in the system may multiply it by her pass count, and nothing may treat its absence as four negative answers.

### Why per-attendee is deferred rather than built

Per-attendee dietary requires naming and managing each attendee, which is the declaration model — the picker, the ceiling, the management screen, the token auth path — that admission addendum 2.0 removed and that should stay removed for a school tailgate.

**The path back is preserved and costs no schema now.** `AdmissionPass.label` already holds an optional per-pass name. Per-pass dietary hangs off a labelled pass whenever a host genuinely needs a census, and that is a deliberate decision made then with a real UI behind it.

**Consequence for host display.** The host panel shows the signal as a bound, never as a count of people:

```
Dietary responses            42 of 73 supporters answered

Vegetarian in party          9 supporters · up to 23 passes
No red meat in party        14 supporters · up to 31 passes
Allergies noted              6 supporters   [ view ]
```

"Up to 23 passes" is honest and useful — she can cater a ceiling. "23 vegetarians" would be a number the system does not know, printed on a screen she will order food from.

**The free-text allergies field is where the nuance actually lives** — *"2 of us vegetarian, one severe peanut allergy"* — and it should be shown to the host verbatim, never parsed, never summarized, never turned into a tag.

If a real per-head census is ever needed, the path exists: `AdmissionPass.label` already holds an optional per-pass name, and dietary could hang off a labeled pass. That is a future decision with a real UI cost, and it is deferred, not foreclosed.

## 2.3 Who is asked

```
asked  ⟺  Event exists
          AND Event.collectDietary
          AND this contribution will mint ≥ 1 pass
```

The third clause is `squareAmountCents > 0 AND NOT donateAdmissions`. It excludes exactly the right people:

- **Donation-only supporters are never asked.** They have no passes and are not attending.
- **Supporters who checked "I'm not attending — donate my admissions" are never asked.** Same reason, and asking them would contradict the box they just ticked.
- A supporter who donates now and buys squares later **is** asked at the later purchase.

**`Event.collectDietary`** is host-configurable, default false, and lives **on the event panel only — not on the fundraiser create form.** Decided. Creation is already the longest screen in the product and dietary collection is a decision most hosts make once catering is real, weeks later.

It is **not** locked by invariant 16 — it collects information and changes no terms — so the host may turn it on at any point in the campaign. Supporters who contributed before it was enabled answer through the self-service path in §2.5, and the host panel shows them as unanswered until they do.

## 2.4 Schema

On `EventSupporter`:

| Field | Type | Notes |
|---|---|---|
| `dietaryVegetarian` | Boolean? | **Nullable** |
| `dietaryNoRedMeat` | Boolean? | **Nullable** |
| `foodAllergies` | String? | Free text. Never parsed |
| `dietaryUpdatedAt` | DateTime? | |

On `Event`:

| Field | Type | Notes |
|---|---|---|
| `collectDietary` | Boolean | Default false |

**Null and false are different and nothing may coerce between them.** Null means never answered; false means answered no. The host needs "42 of 73 answered" to know whether to chase the rest, and a schema that defaults these to false destroys that distinction permanently on the first migration. This is why they are nullable booleans rather than booleans with a default, which is the shape a code generator will produce if nobody says otherwise.

## 2.5 Editing and permissions

**Latest write wins.** Not a latch — unlike supporter status and volunteer interest, a changed answer is a correction, and the old one has no value.

**The supporter can edit their own** through `SupporterAccessToken` — the table the signup addendum reinstated and rescoped from `AttendanceAccessToken`. Do not create a second token path. Someone who develops an allergy, or mistyped, should not have to text the host.

**The host can edit any of them**, because a parent will tell her at pickup and she will not make that parent open an email.

**Check-in staff cannot see dietary information.** The admission addendum's permission table grants roster access to both host and volunteer, but that roster exists for admission — search by name, scan, check in. Allergy data is unrelated to letting someone through a gate and does not belong on a screen a volunteer holds at the entrance.

Dietary answers are **never entitlement**. They do not affect pass minting, drawing eligibility, check-in, or slot claims.

## 2.6 Where it is asked

**On the post-contribution screen, not in checkout.**

Board v2 fixes the checkout fields at *name, email, phone, payment — nothing else*. That constraint holds, and there is a principle underneath it worth stating because it also settles Part 3:

> **Checkout carries only what the confirmation transaction needs.**

The donate-admissions checkbox is in checkout because pass minting reads it inside the confirmation transaction — it has to be known before. Dietary answers affect nothing that happens at confirmation, so they come after, on the screen the supporter already lands on. Same for volunteer interest.

---

# Part 3 — Volunteer interest

## 3.1 The conflict, stated first

The signup addendum already has a volunteer-interest mechanism, and **it does not survive this requirement.**

> Signup addendum §4: stored as `AdmissionGrant.wantsToHelp`. *"Intent is a one-way OR across grants... Interest is `EXISTS (grant WHERE wantsToHelp)` — a derived read, not a column on the supporter."*

Two things break it:

1. **A donation-only contribution creates no `AdmissionGrant`.** Grants are created at claim time for squares. A donor has no grant, so `wantsToHelp` is unreachable for exactly the group this requirement says must be able to express interest.
2. **The requirement is now more than a boolean.** Contact preference has to live somewhere, and a preference spread across N grants has the same "which one is current" problem that ruled out grants for dietary.

**Move it to `EventSupporter`.** The signup addendum's reasoning for keeping it off the supporter was sound *given that grants always exist* — that premise no longer holds.

**Nothing is built yet, so `wantsToHelp` is deleted rather than migrated.** Do not dual-write. Signup addendum §4 and invariant 36 are amended in §3.7.

## 3.2 The record

On `EventSupporter`:

| Field | Type | Notes |
|---|---|---|
| `volunteerInterest` | enum | `none` (default) · `interested` · `declined` |
| `volunteerContactMethod` | enum? | **Reserved — read by nothing at launch.** §3.3 |
| `volunteerInterestAt` | DateTime? | |

**Interest requires an event.** A board with no event has no `EventSupporter` and nothing to volunteer for — the signup addendum is explicit that sheets exist only on board-linked events. On a no-event board the question is not asked.

**Donation-only supporters may express interest.** They are `active` supporters with zero grants (donations addendum §10), and the signup addendum's own eligibility rule — *one confirmed contribution equals eligibility* — already covers them. Its own reasoning does too: a supporter who donated their admissions stays eligible because *"they aren't attending, but they may still drop supplies."* Someone who gave $100 and took no square is in precisely that position.

### One-way by implicit signal, reversible only by explicit action

`none → interested` is additive and never reverses on its own. A supporter who checks the box on her first contribution and leaves it unchecked on her second is **still interested** — the unchecked box on a later screen is not a withdrawal, it is an absence of a signal. This is the same latch shape as `EventSupporter.status`.

`interested → declined` requires a **deliberate opt-out**, through the supporter access token screen or by host action. It is recorded with a timestamp and it is honored. `declined → interested` is likewise possible by deliberate action.

The general rule, which is worth stating because it will come up again: **implicit signals only ever add; only explicit action removes.**

### Interest on an unconfirmed supporter

Interest may be recorded on a `pending` supporter — a cash square reserved but not yet paid, for instance. It confers nothing either way, and if the contribution never confirms, the supporter is deleted by ordinary cleanup and the interest goes with it.

No special case. No money, no supporter, no interest.

## 3.3 Contact — email only at launch

**Decided: no channel picker ships.** The volunteer follow-up is email, and the supporter's email is already on file and already required on any board with an event.

```
Would you like to help out at the event?

  o Yes    o No thanks

  We'll email you when volunteer roles are ready.
```

**This drops a question that was previously requested** — *"how would you like to be contacted"* — and it should be dropped, because with one available channel it is not a question. Offering a choice between email and a channel that cannot deliver is worse than offering no choice: it records a preference the system will violate on the first send.

**SMS introduces an A2P dependency and this launch takes none.** STATUS.md has the Twilio 10DLC campaign rejected, and nothing here is gated on it clearing.

**The column stays.** `volunteerContactMethod` is defined, nullable, and **read by nothing** — the same treatment `displayAnonymous` gets in the donations addendum. When a second channel exists, the picker is a form field and a send branch, not a migration.

**The one line of copy that must be accurate:** *"We'll email you"* is a promise about a channel. Do not write *"we'll be in touch"* and then send email, and do not write either until the send action exists. See §3.4.

## 3.4 What interest is not

**Interest confers nothing.** Not a slot, not a role, not a priority, not a queue position, not a reservation, not check-in authority, not admission, not a drawing entry.

Its **only** function is to define the group that receives the signup link when the host has built the sheet.

**It requires nothing to exist.** No sheet, no slot, no role, no open status, no token. That is the whole point of the requirement — a host launching in September has not thought about who is running the grill in October, and should not have to in order to start collecting names.

### What launch ships — storage and filtering only

**Decided, and stated as a boundary rather than a phase note:**

| Ships at launch | Does not ship at launch |
|---|---|
| The yes/no question on the post-contribution screen | A send action of any kind |
| Persisted answer on `EventSupporter` | An email template for the invitation |
| Host and manager view of the interested list, with contact details | Any scheduled or triggered delivery |
| Filter and count — *"31 people said yes"* | Automated delivery on sheet creation |

**There is no send button at launch, because there is nothing to send.** The signup link does not exist until roles and slots are defined, and a button that mails people a link to an empty sheet is worse than no button.

**The send action ships with the sign-up sheet feature** (signup addendum S2–S3), as an explicit, owner- or manager-initiated action against the filtered list, using `getOrCreateSupporterAccessToken()` and the existing `NotificationDelivery` dedupe and lease guards.

**No automated invitation delivery, at launch or with the sheet.** Creating a sheet must never mail anyone as a side effect. A host building slots on a Tuesday evening, reordering them, renaming two and deleting one should not discover she sent three emails to forty parents. Sending is always a deliberate act with a visible recipient count and a confirmation.

## 3.5 When the sheet actually opens

**The signup addendum becomes authoritative with no amendment to its mechanics.**

- Eligibility is still `EventSupporter.status = active`, derived and never stored (signup invariant 35). Interest is not an input to it. An interested supporter whose contribution never confirmed is not eligible, and a confirmed supporter who never expressed interest is fully eligible if she finds the link.
- Slot capacity is still enforced by unique `(slotId, position)`. Interest reserves nothing.
- **Interest is not a queue position.** Someone who said yes in September and opens the email late may find the gate shift gone. Signup addendum §4 already says exactly this about the checkbox and calls it *"the only behavior that survives contact with a shared sheet."* It survives contact with a three-week-old interest list the same way.

The host's send flow reads: *supporters where `volunteerInterest = 'interested'` and `status = 'active'`* → issue or reuse tokens via `getOrCreateSupporterAccessToken()` — the single idempotent owner the signup addendum specifies — → send.

## 3.6 Where it is asked

Post-contribution screen, alongside the dietary questions, for the reason given in §2.6. Two short questions on a screen that currently says thank you.

The signup addendum's card handoff — poll sees `paid`, redirect to the sheet — is the flow for when a sheet **exists**. When none exists, that redirect has nowhere to go, and this question takes its place. The two are alternatives on the same screen, selected by whether an open sheet exists, not two things stacked on top of each other.

## 3.7 Amendments to the signup addendum

| Location | Change |
|---|---|
| §4 "The checkbox" | `AdmissionGrant.wantsToHelp` is **removed**. Interest moves to `EventSupporter.volunteerInterest`, with contact method. The one-way OR across grants is replaced by the latch described in §3.2 |
| §3 schema | Drop `AdmissionGrant.wantsToHelp` from the migration. Nothing has been built; there is no data |
| Invariant 36 | **Was:** *The help checkbox records intent only. It never claims, reserves, or holds a slot.* **Becomes:** *Volunteer interest records intent only. It never claims, reserves, or holds a slot, and it requires no sheet, slot, role, or token to exist.* |
| Invariant 35 | **Unchanged.** Eligibility remains supporter status. Interest is not an input |
| Invariant 47 | **Unchanged.** *"A host appears only by contributing"* remains true |
| §5 the handoff | Add the no-sheet-exists branch: ask for interest instead of redirecting |

---

# Invariants

**71–90.** Registered in `invariant-registry.md`.

**Pricing**

71. A square may be claimed or reserved only when `effectivePrice(board, now)` returns a value. There is no path to a claim with a null, undefined, zero, or inferred square price.
72. `effectivePrice` reads `earlyBirdPriceCents` while `now < earlyBirdEndsAt` and `squarePrice` otherwise. There is no third source. No component may infer, copy, default to, or fall back to a price, and a null result never produces a number.
73. When `effectivePrice` returns null, square sales are paused: no card claim, no cash reservation, no host-entry square. Donations, confirmations of existing claims, cash resolution, close, finalization, and the draw are all unaffected.
74. Paused is derived at read time and never stored. No flag, no cron, and no cached value represents it.
75. `pricePaidCents` and `priceSource` are written together when a square leaves `open`, from the effective price at that moment. A square already claimed confirms at its claimed price regardless of any later changeover or pause.
76. Early bird fields lock at the first confirmed square with `priceSource = early_bird`. The regular price locks at the first confirmed square with `priceSource = regular`. The two locks are independent. *(Invariant 16 amendment.)*
77. A regular price, once set, is strictly greater than the early bird price. A value at or below it is rejected.
78. Every change to a price field before it locks is recorded in `priceHistory` and displayed in the public audit.
79. A fundraiser board carries at least one configured price at all times: either `squarePrice`, or `earlyBirdPriceCents` with `earlyBirdEndsAt`. Enforced by CHECK, not by API validation alone.

**Dietary**

80. Dietary attributes belong to `EventSupporter`. They are never stored on a grant, a pass, or a contribution.
81. Dietary attributes are never entitlement. They do not affect pass minting, drawing eligibility, check-in, or slot claims.
82. Dietary questions are asked only when `Event.collectDietary` is true and the contribution will mint at least one pass. A donation-only supporter and a supporter who donated their admissions are never asked.
83. Null means never answered and is distinct from false. Nothing coerces null to false, and no migration defaults these columns.
84. Dietary answers describe a supporter's party, not individual attendees. No host-facing surface presents them as a headcount.

**Volunteer interest**

85. Volunteer interest is an `EventSupporter` attribute. Its existence requires no signup sheet, no slot, no role, no open status, and no token.
86. Interest confers nothing: no slot, no priority, no queue position, no reservation, no check-in authority, no admission, no drawing entry. It selects who receives a link and nothing else.
87. Interest is additive by implicit signal and removable only by explicit action. A later contribution with the box unchecked never revokes it.
88. Interest may be recorded on a `pending` supporter and is deleted with that supporter by ordinary cleanup if the contribution never confirms.
89. Volunteer-interest follow-up is email only at launch. `volunteerContactMethod` is defined and read by nothing. No volunteer-interest feature introduces an SMS or A2P dependency.
90. Volunteer interest is stored and filtered at launch and is never delivered automatically. No send action exists until a sign-up sheet exists, and creating, editing, or opening a sheet never sends a message as a side effect.

---

# Required tests

> **Environment-blocked tests.** Production is the only deployment target and its Stripe key is `sk_live_` (Gate 2). Tests requiring a *completed* Stripe Checkout Session cannot run without charging a real card against a real connected account, on the same database holding the S3b fixture. They are marked below.
>
> These are **required and not executed.** They are never marked skipped, never marked passing, and never removed from the suite. They become executable the moment a non-production database plus test-mode Stripe environment exists, and they gate release, not merge.
>
> Rejection-path and cash-path tests remain fully executable — they neither contact nor mutate Stripe.

**Blocked: 28** only. The hold crossing the changeover needs a card claim held through the boundary and then confirmed.

**Executable now:** 25, 26, 27, 29–43. Pricing behaviour is provable end to end on the cash path — 29 covers a reservation crossing the same boundary — and the dietary and volunteer suites never reach a payment.


Appended to money doc §11 and the donations addendum's 12–24.

**Pricing**

25. **Launch with deferred regular price.** Create a fundraiser with early bird set and `squarePrice` null. Assert creation succeeds, the board is `OPEN`, and a square claim at the early bird price succeeds and writes `priceSource = early_bird`.
26. **Pause at the changeover.** Advance past `earlyBirdEndsAt` with `squarePrice` still null. Assert card claim, cash reservation, and host-entry square are all rejected **at the API**, and that a donation succeeds in the same window.
27. **No fallback, asserted directly.** With the board paused, assert `effectivePrice` returns null and that no claim path produces a square with any `pricePaidCents` value — not the early bird price, not zero, not the last known price.
28. **REQUIRED — ENVIRONMENT BLOCKED, NOT EXECUTED.** **Hold crossing the changeover.** Claim at 11:58pm at early bird with a 10-minute hold; let the clock pass `earlyBirdEndsAt` into a paused board. Assert the batch confirms at the early bird price and `raised` increases by that amount.
29. **Cash reservation crossing the changeover.** Reserve during early bird, confirm during the pause. Assert the early bird price is honored and the host's cash panel shows the reserved amount.
30. **Resume.** Set the regular price while paused. Assert sales resume immediately with no cron and no board-status change, and a new claim writes `priceSource = regular`.
31. **Independent locks.** Confirm one early-bird square. Assert `earlyBirdPriceCents` is now rejected for edit and `squarePrice` is still editable. Then confirm one regular-price square and assert `squarePrice` is now rejected.
32. **Ordering rejection.** Attempt to set a regular price at and below the early bird price. Assert both are rejected and nothing is written to `priceHistory`.
33. **Price history in the audit.** Change an unlocked regular price twice. Assert both entries appear in the public audit.

**Dietary**

34. **Not asked when not attending.** Donation-only contribution, and a square contribution with `donateAdmissions` checked. Assert neither is asked and both leave the dietary fields null.
35. **Null preserved.** Migrate and create supporters without answering. Assert the columns are null, not false, and that the host panel reports them as unanswered.
36. **Follows the person, not the purchase.** One supporter, two separate contributions. Assert one set of answers on one supporter row, and that the second purchase does not reset them.
37. **Not entitlement.** Assert dietary values have no effect on pass count, check-in, drawing eligibility, or slot claiming, and that check-in staff cannot read them.

**Volunteer interest**

38. **Interest with nothing built.** Express interest on an event with no sheet, no slots, no roles, and no token. Assert it is stored and that nothing else was created.
39. **Donation-only interest.** Donation-only supporter expresses interest. Assert stored, supporter is `active`, holds zero passes, and is eligible when a sheet later opens.
40. **The latch.** Express interest, then contribute again with the box unchecked. Assert still interested. Then opt out explicitly. Assert declined and excluded from the send group.
41. **Interest dies with an unconfirmed supporter.** Interest on a `pending` supporter whose contribution is released. Assert supporter and interest are both cleaned up.
42. **Interest is not a queue position.** Two interested supporters, one slot. Assert first-to-claim wins and that interest order has no effect.
43. **SMS preference with no phone.** Choose text with no phone number on the supporter. Assert rejected, and that no preference is stored.

---

# Migrations

Independent of the donations migration and can land before or after it.

| # | Change | Notes |
|---|---|---|
| 1 | `Board.squarePrice` → nullable, plus the three CHECK constraints in §1.7 | The existing early-bird CHECK is **rewritten**, not added to |
| 2 | `Board.priceHistory` — `Json?` | Mirrors `titleHistory` |
| 3 | `Square.priceSource` — enum, nullable while `open` | |
| 4 | `Event.collectDietary` — Boolean, default false | |
| 5 | `EventSupporter` — `dietaryVegetarian`, `dietaryNoRedMeat` (nullable Booleans, **no default**), `foodAllergies`, `dietaryUpdatedAt` | §2.4 |
| 6 | `EventSupporter` — `volunteerInterest` (enum, default `none`), `volunteerContactMethod`, `volunteerInterestAt` | |
| 7 | **Drop `AdmissionGrant.wantsToHelp`** from the signup migration before it is applied | Nothing built, no data |

**Existing Game Day rows are unaffected by all seven.** `squarePrice` becoming nullable does not make it optional for Game Day — the second CHECK in §1.7 holds the line, and it is satisfied trivially by every existing row.

### Code touchpoints

| File | Change |
|---|---|
| **New** — `src/lib/pricing.ts` | `effectivePrice()` and `squareSalesPaused()`. The **only** source of a square price |
| `src/app/api/boards/route.ts` | Allow null `squarePrice` on the fundraiser branch |
| **New** — set-regular-price route | Ordering validation, lock check, `priceHistory` write |
| `src/app/board/[slug]/claim-sheet.tsx` | Paused state, donate fallback, no "then $X" with no number |
| `src/app/board/[slug]/fundraiser-view.tsx` | Paused copy, price line variants |
| `src/app/host/boards/[id]/fundraiser-panel.tsx` | Warning banner and escalation, regular-price entry, dietary summary, interest list and send |
| **New** — post-contribution screen | Dietary and interest questions; branches on whether a sheet exists |
| `src/lib/admission.ts` | Dietary fields on supporter resolve; interest write |
| `src/lib/signups.ts` | Read interest from supporter, not grant |

---

# Deferred

Decided at freeze: flat pricing preserved, rename ships first, `collectDietary` on the event panel only, volunteer follow-up email-only, storage and filtering with no send action.

| Deferred | Preserved by |
|---|---|
| **Per-attendee dietary collection** | `AdmissionPass.label` already exists. §2.2 states the launch limitation in full |
| **Volunteer send action** | Ships with the sign-up sheet (S2–S3). No link exists to send before then |
| **SMS as a contact channel** | `volunteerContactMethod` defined and unread. Blocked on A2P, which this launch does not depend on |
| Paused board with donations unavailable | Resolved in practice: `Contribution` ships at A1 and donations are the fallback path. A host who disables donations and lets early bird lapse gets a read-only board, which is correct |
| Price-warning escalation timing | T-7 and T-1 proposed, not derived. Tune after one real campaign |
| Host bulk-add of volunteer interest | No supporter row means nowhere to store it. Revisit only if hosts ask |

---

**Status: ready for freeze.**
