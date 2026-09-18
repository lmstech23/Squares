# Fundraiser Payment Method — Addendum

**Status:** Approved for implementation
**Version:** 1.2.16 — reconciled against the repo
**Scope:** `contributions` only. Game Day tables are out of scope
**Companion to:** `fundraiser-money-state-machine.md` (authority on money) · `fundraiser-board-v2.md` (authority on fundraiser flows) · `fundraiser-admission-addendum.md` (authority on passes)

Adds a record of **how** a contributor actually paid, visible on the host ledger. One migration, one check constraint, four confirm paths.

**Changed in 1.2.** Four corrections, all found by reading the repo rather than the specs:

1. **The new field is `settlement`, not `paymentRail`.** `payment_rail` already exists on `contributions` and `entry_reservations` and means something else — the rail a contributor *declared*. §2 keeps both and defines how they relate.
2. **Target table is `contributions`.** v1.1 inherited "Square" from the Game Day field table. `squares.payment_method` and `payment_references.method` are untouched.
3. **Invariants are 120–125**, allocated in the registry. 58–63 belong to the donations addendum.
4. **Tender is required at confirmation, not at recording** — §4 and invariant 124. Offline contributions confirm in four places, not one, and a declared-but-unpaid row has no tender to record yet.

**Changed in 1.1.** The check constraint was written as an equality between two boolean expressions and did not hold under a nullable `tender`. §8.

---

## Rule of this document

Adds a **display and reconciliation field**. Does not change how money works.

Nothing here moves a dollar, creates a state, or changes who is eligible for anything. It adds invariants 120–125. If it disagrees with the money doc, the money doc wins and this document is wrong.

**Cite these by name, never by number.** The registry is the numbering authority. Any number written in `CLAUDE.md` is a snapshot and goes stale — 110 already has.

---

## 1. The problem

`contributions.payment_method` is one field carrying two meanings.

```
stripe   →  the system watched the money settle
cash     →  everything else
```

The ledger renders it correctly — a released Stripe row reads `card` today. The problem is upstream. A parent who Zelled $80, a parent who handed over a folded $80, and a parent who wrote a check all take the only path the host has, and all three land in the same bucket.

**`cash` has stopped meaning cash. It means not-Stripe.** Adding values to that enum does not fix it — it makes a field that already drives money logic start carrying cosmetic values too.

Production today: 76 contributions, 14 of them Stripe. The other 62 are indistinguishable from each other and the host is the only person who knows the difference.

---

## 2. Three fields, three jobs

The repo already has one of these. The confusion in v1.1 came from not knowing that.

| Field | Values | Written | Means |
|---|---|---|---|
| `payment_rail` *(exists)* | `zelle` · `cashapp` · `venmo` · `paypal` | At declaration, by the contributor | **What they said they'd use.** A promise, made before any money moves |
| `settlement` *(new)* | `STRIPE` · `OFFLINE` | By the system | **Did we witness it, or is the host attesting?** Replaces `payment_method` |
| `tender` *(new)* | `CARD` · `CASH` · `VENMO` · `ZELLE` · `CASHAPP` · `PAYPAL` · `CHECK` · `OTHER` | At confirmation, by the host | **What actually arrived.** A fact |

### Why declared rail and tender both exist

Their value sets overlap and they are not the same thing. `payment_rail` is what a parent typed into a form on Tuesday. `tender` is what the host had in her hand on Saturday.

**They are allowed to disagree, and the disagreement is information.** A parent declares Zelle and turns up with two twenties. That is an ordinary evening at a tailgate, and a schema that collapses the two loses the fact that it happened.

- **Neither is derived from the other. Ever.** No sync job, no trigger, no default that writes one from the other.
- **The ledger shows `tender`.** It is a record of money received, so it shows what was received.
- **The host form may *display* the declared rail as context** — *"Contributor said: Zelle"* — beside the picker. It never pre-selects it. §4.
- No constraint ties them together. A `ZELLE` declaration with a `CASH` tender is valid and correct.

### `settlement` is never chosen by a human

The Stripe path writes `STRIPE`. Every host-recorded contribution writes `OFFLINE`. Two values, no form field, no host control. This is `payment_method` with an honest name and the cosmetic load taken off it.

### `CARD` belongs to Stripe alone

`settlement = STRIPE ⟺ tender = CARD`, enforced by the constraint in §8. A host who swipes a card on her own reader records `OTHER` with a reference note.

### The CARD seam

That rule buys safety by making one sentence above not quite true.

**`tender` is "what actually arrived" in every case but one.** A parent who taps a card on a host's own reader used a card, and the ledger says `Other`. The reference note carries it; the enum doesn't, and no query will find it.

`CARD` currently encodes two facts at once — a card was used, *and* Stripe settled it. They coincide today because Stripe is the only processor, so the constraint costs nothing and gives the ledger a word meaning exactly one thing.

**It is the first thing a second processor breaks.** §10 preserves a connected non-Stripe processor by making `settlement` an enum rather than a boolean. The day that lands, a third value exists whose payments the system *does* witness — not `OFFLINE` in any meaningful sense — and `STRIPE ⟺ CARD` is too strong, because a card settled by that processor is a card.

What to do then, written now so it isn't rediscovered under deadline:

- `settlement` splits into *witnessed* values (`STRIPE`, the new one) and *attested* (`OFFLINE`). That is the distinction §5's ledger marker actually draws.
- Any additional witnessed settlement value requires its own explicit, null-safe pair clause in the constraint when it is implemented. §8.
- `OFFLINE + CARD` stays rejected. A host-attested card is still an unverified claim, and that is the case the rule exists for.
- No backfill. Existing rows are unaffected.

None of this is built now and none of it changes §11.

---

## 3. What tender may never do

This is the load-bearing section. Everything else is a form field and a column.

**No money figure reads `tender`.** Not `raised`, not `prizePoolBaseCents`, not `finalRaisedCents`, not the prize ladder, not a fee estimate, not an eligibility check, not a state transition. Drop the column and every dollar in the system is unchanged.

**Tender never opens a second door to confirmed.** It is written inside a transaction that is already confirming a contribution, never in one of its own. If recording a method can advance a contribution's state, this change has invented a second confirmation path and money doc §2 no longer holds.

**Fees are a settlement question.** Board-v2 §5 calls estimated proceeds an estimate because processing cost varies — that variance is Stripe vs. offline, which `payment_method` already expressed and `settlement` inherits. Zelle and cash cost the same nothing. No fee logic gains a branch.

---

## 4. Recording — all four confirm paths

v1.1 put the picker on Record donation and stopped. Offline contributions confirm in four places, and a picker on one of them would leave the other three writing nulls onto new rows.

| Path | Picker | Tender written |
|---|---|---|
| Record donation — `cash-donation` route + form | ✅ | At creation; this path creates and confirms in one action |
| Host confirms a declared donation — `confirm-button` | ✅ | At confirmation |
| Host confirms cash-reserved squares — `confirm-cash` route | ✅ | At confirmation |
| Host confirms an entry reservation — `entry-reservation.ts` | ✅ | At confirmation |
| Contributor declares a donation — `donate` route | ❌ | **None.** Null until a host confirms |

**The declaration path gets no picker and that is correct.** No money has moved, the host has received nothing, and there is no fact to record. The contributor's intent is already captured — that is what `payment_rail` is for. Forcing a tender there would be recording a guess as a fact in the field whose whole job is to be a fact.

One shared picker component across the four confirm paths. Four copies will drift.

### What one confirmation covers

**`confirm-cash` confirms exactly one square per action.** The route takes a single `squareId`, and both host surfaces render one button per square. One tender selection therefore covers one square and nothing else.

- When that confirmation **writes a new contribution** — the square has no linked row, or a `pending` or `released` one — the tender is written to the contribution that action creates.
- When the square already points at a **confirmed contribution that matches it exactly**, `writeLedger` is false and **no contribution row is written**. Nothing is corrected and no confirmed row is overwritten in order to store a tender.

**Fundraiser `confirm-cash` validates tender for every confirmation action even when an already-confirmed matching contribution means `writeLedger = false`. The host-facing action should have one invariant regardless of the linked row's persistence state. When no contribution write occurs, the validated tender is not persisted.**

**The "one method for this whole action" line belongs to entry reservations.** A reservation collapses every tier line into ONE contribution, so a single selection covers every pass and the donation with it, and the picker says so. Per-square `confirm-cash` needs no such line: one action, one square, at most one row.

### The picker

```
Contributor said: Zelle                    ← shown only when payment_rail is set

Method     ( ) Venmo   ( ) Zelle   ( ) Cash App
```

- **Options = the board's configured payment handles. Nothing else.** Read live from the board at render time. Never offer a method the host cannot receive.
  - The resolver already exists: **`acceptedRails(board)` in `src/lib/accepted-payments.ts`**. It returns a rail only when the board lists it in `acceptedPaymentMethods` AND the matching handle — `hostZelle`, `hostCashapp`, `hostVenmo`, `hostPaypal` — is set. The picker's list is exactly that, in rail order. Both host surfaces resolve it per render, so a handle added mid-session appears on the next one.
  - **Cash, Check and Other were appended unconditionally and have been removed.** The reason is that none of the three is selectable at setup: `BoardPaymentMethod` is `card`, `zelle`, `cashapp`, `venmo`, `paypal`. Offering them put methods in front of the host that she never chose, in a list whose entire claim is that it reflects her configuration.
  - **The consequence is real and was accepted.** Money that arrives some other way — notes at a folding table, a cheque — has no option here and stays unrecorded, rather than being filed under a method nobody used. That is the same falsehood as backfilling `CASH`, and refusing it is why this document exists. Making the three selectable means adding them to `BoardPaymentMethod`: a migration and a setup-form change, not a picker change.
  - **A board with no configured rails offers nothing, and the cell says so.** There is no dropdown, no disabled placeholder option and no invented method. An organizer holding `cash.record` on such a board sees, in place of the picker:

    > **No payment methods configured.**
    > Add a payment method in Board Settings to record this contribution.

    Silence would read as a broken cell; a fallback would file money under a method nobody chose. The label on the closed row reads *No payment type recorded* rather than *Select payment type*, because the invitation tracks what she can actually do — offering a selection the board cannot satisfy is the same broken promise as offering a control the route would refuse. The moment a method is configured, the normal picker appears with no other change.

    **Host-facing only.** It describes what this ledger can record. It creates and implies no contributor payment option, and nothing about it reaches the public board.

    No fundraiser board in production is in this state; every one has at least two rails.
  - **A row's own tender still displays even when it is not in the list** — recorded before this rule, or on a rail the board has since dropped. The control states the truth about the row it sits on; that is not an offer to any other row.
- **No default selection, including no pre-fill from the declared rail.** The declared rail is shown as context and nothing else. A pre-filled picker is a picker the host taps past, and the row it produces says *fact* while meaning *she didn't correct the guess*. That is the exact failure this document exists to end.
- `CARD` never appears.
- **There is no reference field.** It was optional free text on every confirm path and in the correction; it is gone from all of them. A host confirming money picks the method and presses the button. A second field on a form whose whole job is one answer is a field that gets skipped, and a skipped field teaches nothing about the row it sits on.
  - **`contributions.tender_reference` remains in the schema** — nullable, unused, length CHECK intact. No migration. Nothing writes it, nothing reads it, and no production row ever carried one, so removing the reading of it orphaned nothing.
  - The correction route **refuses `tenderReference` by name** rather than ignoring it, so a stale client hears about it instead of silently writing nothing.
- `recorded_by_host_id` and `recorded_at` are written on every offline confirmation.

**Board handles are not locked by invariant 16.** A host who adds Zelle in week three sees Zelle in the picker in week three. Earlier rows are corrected through §6, never rewritten.

### On the authority for filtering the picker

The payout coordination memo §2B establishes the principle on the player side: *player options are filtered to match what the host has, so no mismatch is possible.* The host-side version — never offer a method the host can't receive — is the same idea and is **stated here as new**, not inherited. v1.1 cited SYSTEM-FLOW §9.7 for it, which does not exist; the nearest rule is about what players see and says nothing about this.

---

## 5. Ledger display

Method shows the tender label.

```
Contributor      Type               Method              Status
Janelle Harris   Entry + donation   Cash                confirmed
Felicia Barnes   Entry tickets      Zelle               confirmed
Maureen Gold     Entry tickets      Card                confirmed
Daaliyah Tate    Entry tickets      Card                released
```

- **The label alone carries the distinction. There is no marker.** A subdued `· recorded` beside every offline tender was specified here and built, and it was redundant from the moment invariant 121 existed: that constraint makes `CARD` reachable only from `STRIPE` and unreachable from `OFFLINE`, so **`Card` already means the system watched it settle and every other label already means a host said so.** The marker restated what the constraint proves, and it was not free - it produced a trailing separator on every offline row and wrapped the cell onto two lines. A second signal that can only ever agree with the first is not reassurance; it is noise that will one day disagree.

- **The cell still has to look openable**, because the marker was the only thing signalling that it opens. That is an affordance, not a status: a hover underline and a chevron that turns when the row is open. It spends no word, and nothing enters the reading flow beside the label.

  **The chevron is drawn, not typed.** As the character `▾` at 9px in a dim grey it rendered as a full stop after the label — *Zelle ·* — which reads as a dangling separator, and was reported as one. A glyph that small is at the mercy of whichever font the platform substitutes for it; an inline path is the same two strokes everywhere and cannot be mistaken for punctuation.

- Tapping an offline row reveals recorded-by, recorded-at, and the declared rail when the two differ.

- **A row with nothing recorded opens straight to the select. There is no empty state.** *"Nothing further was recorded. This row predates the method picker."* answered a question the cell used to raise — why is this panel blank — and the label answers it now by being a control rather than a description. A historical row carries no timestamp, no reference, no declared rail and a recorder that resolves to nothing, so the paragraph stood between the host and the only thing in the panel she came for. Rows that *do* carry a tender keep the reveal unchanged. The rule is "nothing to reveal", not "tender is null": if such a row ever does carry a recorder, showing it beats discarding it to satisfy the premise.
- **A row with no tender says so, and the copy is permission-aware.** *Recorded by host* on a null-tender row is **false**, not merely unhelpful: nobody recorded a payment type on that row, which is what null means. §9's backfill refused to write `CASH` onto those rows because it would assert a fact nobody had recorded — and the display layer then asserted a different invented fact in its place. **A label is a claim about the data exactly as much as a column value is.** With `cash.record` the cell reads **Select payment type**; without it, **No payment type recorded**, and the cell does not open. The copy tracks the same capability the route enforces, because offering a control to a viewer the route would refuse spends her time and then denies her. **Neither ever renders *Cash*** — unchanged, and the reason this cell exists.

- **The host's vocabulary, not the schema's.** `method`, `tender` and `settlement` are our words. *Payment type* is what a host says out loud, and this cell is read by someone reconciling a bank deposit. The column heading stays **Method**, because it heads a column of values like Cash and Zelle; the two labels above are sentences addressed to a person, and they read as such.

- **The Method column carries a width of its own, declared on a block inside the cell.** Ten columns share the table's `w-full`, and this one used to be sized by its shortest value — `Cash` — so on a real board the label and the detail panel beneath it wrapped one word per line. It now holds a sentence and a `<select>`, both wider than anything it previously carried.

  **`min-width` on the `<td>` is not the constraint, and on its own it is not enough.** Column sizing belongs to the table layout algorithm, which derives each column from its cells' content; a `min-width` on the cell box is not part of that derivation and browsers honour it inconsistently. A `min-width` on a **block child** is, because it raises the cell's minimum content width. Every branch of the cell — witnessed, non-interactive and interactive — wraps in it, so a board of nothing but Card rows sizes the column the same as a board full of corrections, and the first correction does not reflow the table. The `<td>` and `<th>` carry the same value as a hint; the two must stay in step. The table already scrolls horizontally, so the cost on a narrow screen is a scroll rather than a squashed cell.

- **The select's empty option must not restate the cell's label.** They sit one above the other on an open row — the label is the control the host tapped, the select is what it opened — so sharing a string made the row read *Select payment type / Select payment type*, which looks like a rendering fault rather than a control and its contents. The label keeps the sentence because it is the thing she taps; the option takes a neutral verb, **Choose…**, which adds no second claim. It is not left blank either: an empty option renders as a nameless row in a native wheel rather than as an absence. **The radio variant has no placeholder and never had one**, so the confirm paths were never affected — checked, not assumed.

- **The correction control is the compact variant of the one picker — a native `<select>`, not a second component.** Same options from the board's accepted rails, same `CARD` exclusion, same route. Only presentation differs, and the radio group stays on the four confirm paths, where the host has already stopped to confirm a payment and the reference field needs room. Opened, the radio stack ran taller than three donor rows and pushed the ledger down the page; one line that opens the phone's own wheel is the right trade for fixing a row in a backlog.

- **No presentation of the picker asks for a reference**, because the field no longer exists in the product — see §4. Neither variant accepts the prop, so it cannot drift back into one of them.
- Nothing here reaches the public board. Money doc §10 gives the public two numbers.

**A ledger reservation row has no method to name.** Those rows are grouped from `squares` in `reserved_cash`, not from a contribution, and a square carries no declared rail: `payment_rail` is a column on `contributions` and `entry_reservations`, never on `squares`. Their Method cell renders an em dash. It read `cash` before, which asserted a method nobody recorded - the same defect the null-tender rule exists to prevent.

**Declared rails belong to the entry-reservation worklist**, which is where that data exists: a pending `EntryReservation` carries the rail the contributor chose, and the worklist already shows it beside the reference code.

---

## 6. Correcting the record

Sixty-two rows on live boards predate this change. Some are wrong and the host is the only person who knows how.

**The tender is correctable inline. Settlement, amount, status — and the reference, which no longer exists — are not correctable through this path** — and the route rejects them explicitly rather than ignoring them.

That asymmetry is the whole safety argument: a correction that cannot touch a dollar or a state cannot break reconciliation, so it needs no confirmation modal and no close-flow gate.

**Correction requires `cash.record`** - the capability both OWNER and MANAGER hold. The board's existing authorization is the whole boundary, and nothing in the path consults `recorded_by_host_id`: **the original recorder does not own the row.** A row only its recorder could fix would be uncorrectable the day she is unavailable, which is exactly when a ledger gets fixed.

**A correction never changes `recorded_by_host_id`.** That column answers who recorded the money; the correction log answers who later changed how it is described. Two questions, two answers, kept apart on purpose.

**The correction is the cell. No edit mode, no Save, no Cancel, no modal.** Choosing a method writes it. The asymmetry above is what buys this: a Save button on a one-field form that cannot move a dollar only asks her to confirm what she already said. While the write is in flight the select is disabled; if it is refused, the prior value is restored and the error sits beneath the control. Nothing is written by opening a row — only by choosing.

**A successful write collapses the row; a refused one leaves it open.** Removing Save and Cancel left nothing to end the interaction, so the row stayed expanded with the picker showing the value the label above it had just begun displaying — the same answer twice. **Collapsing is the acknowledgement**: the label reads what she chose, which is all a one-field correction has to report. The failure path is the exception and must stay open, because the restored value and the error message both live inside the control she just used.

**A correction sends `tender` alone**, and the route refuses any other key by name — `tenderReference` included.

Every correction writes a `tender_correction_log` row — host, contribution, field, old, new, timestamp. Same shape and reasoning as `SignupLog`. **`field` is always `TENDER`.** The enum keeps its `REFERENCE` value and nothing writes it; all five correction rows in production are `TENDER`.

---

## 7. Close

`CLOSING` does not read tender. Reconciliation resolves outstanding card checkouts against Stripe and outstanding cash per square, both settlement-level operations, unchanged.

What close gains is a host-facing breakdown:

```
Confirmed              $3,650
  Card                 $2,300
  Zelle                $  610
  Venmo                $  410
  Cash                 $  330
```

This is the actual deliverable. It is the list she works from at the bank, and today she reconstructs it from memory.

Subtotals cover confirmed, unvoided rows — the population the ledger header already totals. Rows with a null tender appear as *Unspecified* and are not silently folded into Cash.

**It is a report, not a doorway.** *Unspecified* is a line in the list, as written above — not a link. Rendering it as one put an amber underline in a column of figures, where it reads as an error rather than an invitation, and it points back at the ledger the host has just come from. The filtered view still exists at `?method=unspecified`; nothing in the deposit list advertises it.

**The breakdown renders while `CLOSING` and after `CLOSED`, never while the board is open.** Collecting and reconciling are different jobs. While she is collecting, she manages the ledger; while she is closing, she reconciles the money. A deposit worksheet on a board still taking payments answers a question she has not asked, and its subtotals change under her while she reads them.

---

## 8. Data model

### contributions

| Column | Type | Notes |
|---|---|---|
| `settlement` | Enum | `STRIPE` · `OFFLINE`. System-written. Replaces `payment_method` |
| `tender` | Enum? | Null on pre-migration rows and on unconfirmed offline rows. §9, invariant 124 |
| `tender_reference` | String? | Max 64. **Retained, unused.** Nothing writes or reads it |
| `recorded_at` | DateTime? | New. `recorded_by_host_id` already exists |

`payment_rail` is unchanged in name, values, and meaning. Its constraint `contributions_rail_is_cash_only` keeps its name and its meaning — a declared rail exists only on a host-attested contribution — but its text was rewritten in M1a to read `settlement` instead of the dropped `payment_method`.

A declared `payment_rail` implies `settlement = 'OFFLINE'`, and `CARD` requires `settlement = 'STRIPE'`. So a row with a declared rail cannot carry `tender = 'CARD'`. This is a consequence of two existing constraints, not a third constraint, and it does not narrow the independence rule: every non-`CARD` tender may still disagree with the declared rail. A host who takes a card on her own reader records `OTHER` — the CARD seam, §2.

### tender_correction_log — new

`id` · `contribution_id` · `host_id` · `field` (`TENDER` · `REFERENCE`) · `old_value` · `new_value` · `created_at`

**Locked down like every table in `public`.** Row-level security is enabled; `PUBLIC`, `anon` and `authenticated` hold no privileges on it, and only `service_role` is granted — the containment block every new table gets, applied in the same migration. The migration's closing gate reads `relrowsecurity` from the catalog and aborts if it is off. No policy is written, because nothing reads this table over the Data API.

### Constraint

```sql
ALTER TABLE contributions ADD CONSTRAINT contributions_settlement_tender_valid CHECK (
  (settlement = 'STRIPE'  AND tender IS NOT DISTINCT FROM 'CARD')
  OR
  (settlement = 'OFFLINE' AND tender IS DISTINCT FROM 'CARD')
);
```

**Every comparison against a nullable column in a CHECK must be null-safe — `IS DISTINCT FROM` / `IS NOT DISTINCT FROM`, never `=` or `<>`.** PostgreSQL accepts any CHECK result that is not FALSE, so UNKNOWN is effectively accepted. A plain comparison against a null is UNKNOWN, and the row goes in.

This constraint was written incorrectly twice before that rule was stated. Both failures stay here, because they are the reason the rule is believable.

1. **v1.0** wrote it as an equality between two boolean tests: `(paymentRail = 'STRIPE') = (tender = 'CARD')`. With a null tender the right side is UNKNOWN, so the equality is UNKNOWN, and `STRIPE + NULL` was accepted.
2. **v1.1 through v1.2.3** wrote the legal pairs out — `(settlement = 'STRIPE' AND tender = 'CARD') OR (settlement = 'OFFLINE' AND (tender IS NULL OR tender <> 'CARD'))` — and this section said that form was the one that held. It was not. With a null tender, `tender = 'CARD'` is UNKNOWN, the first clause is `TRUE AND UNKNOWN`, the second is FALSE, and the predicate is UNKNOWN. `STRIPE + NULL` was accepted again. M0 verification caught it on 2026-09-12: the one insert this constraint exists to reject returned `INSERT 0 1`.

Writing the pairs out was necessary and not sufficient. The form above does both: the legal pairs, enumerated, each comparing `tender` null-safely.

An explicit `IS NULL OR …` guard satisfies the null-safety rule as well — `tender_reference IS NULL OR char_length(tender_reference) <= 64` can never evaluate to UNKNOWN. What the rule forbids is a predicate that can be UNKNOWN, not a particular operator.

| Settlement | Tender | |
|---|---|---|
| `STRIPE` | `CARD` | ✅ |
| `OFFLINE` | `CASH` · `VENMO` · `ZELLE` · `CASHAPP` · `PAYPAL` · `CHECK` · `OTHER` | ✅ |
| `OFFLINE` | `NULL` | ✅ — pre-migration, or declared and not yet confirmed |
| `STRIPE` | `NULL` | ❌ |
| `STRIPE` | any non-`CARD` | ❌ |
| `OFFLINE` | `CARD` | ❌ |

**The database and the application split the work.** The constraint permits `OFFLINE + NULL` because that combination is legal — 62 live rows are in it and a `NOT NULL` column makes §9 impossible to run. *Confirmed* offline rows requiring a tender is a rule about a different population and lives in the confirmation transaction, where the status it depends on is being written anyway.

### Stripe rows are written at creation

`contributions.ts:149` creates the row at checkout, so `STRIPE` and `CARD` are written then, before settlement. This is fine and deliberate: `settlement` and `tender` describe the channel, `status` describes whether the money arrived. Do not add a tender write to the webhook to make the timing symmetrical — it buys nothing and puts a cosmetic field in the payment path.

---

## 9. Migration

Order matters. Reversing 2 and 3 fails on live rows.

1. Add `settlement`, `tender`, `tender_reference`, `recorded_at`, and `tender_correction_log`. All nullable.
2. Backfill: `payment_method = 'stripe'` → `STRIPE` + `CARD` (14 rows). `payment_method = 'cash'` → `OFFLINE`, tender **NULL** (62 rows). Then `settlement` → NOT NULL.
3. Add the CHECK constraint. After the backfill, never before.

**Do not backfill offline rows to `CASH`.** It would be true for most of the 62 and false for the rest, with no way afterward to tell which rows a host asserted from which a migration invented. Null renders as *recorded by host* and is honest about what is known.

**`payment_method` is dropped in M1, not here** — and dropping it requires rewriting `contributions_card_requires_email` and `contributions_rail_is_cash_only`, both of which reference it. That is M1 scope and is not a mechanical column drop.

---

## 10. Deferred

| Deferred | Preserved by |
|---|---|
| A second witnessed settlement value — connected non-Stripe processor | `settlement` is an enum, not a boolean. **Relaxing invariant 121 is part of that work — §2** |
| `payment_references.method` reconciliation | Untouched by this change and will drift from `tender`. Known, accepted, documented |
| Per-tender subtotals in the live ledger header | Same query as the close breakdown |
| CSV export of the ledger | Nothing here is display-only in the database |
| Reference validation or matching against a payout feed | `tender_reference` is untyped on purpose |
| Tender on Game Day `squares` | Out of scope. Requires explicit approval |

---

## 11. Invariants

Registry-allocated 120–125. Cite by name.

120. `settlement` is written by the system and never chosen by a human. Stripe writes `STRIPE`; every host-recorded contribution writes `OFFLINE`. No form field exposes it.
121. The only legal pairs are `STRIPE + CARD`, `OFFLINE +` any non-`CARD` tender, and `OFFLINE + NULL`. The other three are rejected by check constraint, written as enumerated pairs and never as an equality between boolean tests. `CARD` never appears in the host picker. **Scoped to a single witnessed settlement value — see the CARD seam, §2.**
122. No dollar figure, state transition, fee calculation, eligibility check, or prize computation reads `tender`. Removing the column leaves every number in the system unchanged.
123. Writing `tender` never creates or advances a path to confirmed. It is written inside a transaction already confirming a contribution, never in one of its own.
124. Every offline contribution confirmed after this change carries a non-null `tender`, enforced in the confirmation transaction. Null is legal on pre-migration rows and on declared-but-unconfirmed rows, and the set of pre-migration nulls can only shrink.
125. The tender is correctable; settlement, amount, and status are not correctable through that path. Every correction writes an audit row naming the host, both values, and the time.

    **Narrowed in v1.3.0.** It read "tender and reference are correctable" while the reference field existed. Removing that field narrows what the path may touch and loosens nothing: the list of what is *not* correctable only grew.

**`payment_rail` and `tender` are never derived from, synced with, or constrained against each other.** Filed as a rule rather than an invariant because it forbids a mechanism rather than asserting a state. This independence is scoped to the declared rail. `settlement` and `tender` are constrained against each other by invariant 121.

---

## 12. Build order

| # | Step | Note |
|---|---|---|
| M0 | **Expand: schema + writers.** Schema, backfill and constraint, §9. Every contribution writer dual-writes `settlement` beside `payment_method`; the Stripe writer also writes `tender = CARD` at creation | No UI and no read changes. The only irreversible step. **Assert all three rejected pairs fail at the database, `STRIPE + NULL` first** |
| M1 | **Contract: reads, then drop.** Move reads `payment_method` → `settlement` and rewrite the two dependent CHECKs; then drop the column, in a separate migration | Behavior unchanged. Larger than it sounds — the CHECKs are the reason |
| M2 | Shared picker component; wire into all four confirm paths, §4 | First step that writes a tender. `donate` route gets none |
| M3 | Ledger Method column, offline marker, detail reveal | The screen that started this |
| M4 | Inline correction + audit log | Lets the host fix the 62 |
| M5 | Close-flow tender breakdown | §7. The payoff |

M0 and M1 land before any UI. Renaming underneath live UI is the failure mode the Feb 26 rule exists for.

**Release gate.** M0, M1 and M2 release together, after M2 is complete. Merging to `main` deploys production, so none of them merges before M2: in between, every offline contribution confirmed would record a null tender. The branch is not pushed either. Every pushed branch gets a Vercel Preview deployment, and Preview deployments share the production `DATABASE_URL`, so a pushed M0 would run its writers against a production database that does not have the columns yet.

---

## 13. Files

Confirmed in the repo:

| File | Change |
|---|---|
| `prisma/schema.prisma` | §8. The CHECK cannot be expressed here; it goes in the generated migration.sql by hand |
| `contributions.ts:149` | Stripe creation — write `STRIPE` + `CARD` |
| `contributions.ts:301` | `recordCashDonation` — Record donation creates here, confirmed in one host action |
| `cash-donation` route + `cash-donation-form.tsx` | Record donation. Picker, required; creates through `recordCashDonation`, `contributions.ts:301` |
| `cash-donation` route:195 + `donations/confirm-button.tsx` | Confirm a declared donation. Updates the existing pending contribution; M2 writes tender into that update. Picker, required |
| `confirm-cash` route:189 | Picker, required |
| `entry-reservation.ts:168` | Picker, required |
| `donate` route:177 | **No picker.** Leaves tender null |
| `donations/page.tsx` | Ledger Method column |
| `close-board.ts` + `close-campaign` route | §7 breakdown. Read-only |
| `fundraiser-board-v2.md` | Step 0 documentation |

Untouched: `squares.payment_method`, `payment_references.method`, everything Game Day.

---

## 14. Open questions

1. **Offline reversal.** A bounced check and a reversed Zelle have no representation here. The ledger renders voided rows, but money doc invariant 4 makes confirmed terminal and 5 denies a refund state. **This document does not answer it and must not decide it.**
2. **"Entry tickets" on the ledger.** The tiered admission addendum states an admission is never called a ticket where a human can read it. The ledger's Type and Ticket $ columns do. Invisible on a no-prize board; fires when prizes turn on.
3. **`payment_references.method`.** A third place recording method, now guaranteed to drift. Deferred in §10 rather than solved.
4. **Multi-organizer attribution.** 48 of 62 cash rows have `recorded_by_host_id`. The other 14 stay null — do not invent a recorder.

---

*End of addendum.*
