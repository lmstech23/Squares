# Fundraiser Payment Method — Addendum

**Status:** Approved for implementation
**Version:** 1.1 — constraint corrected, CARD seam documented
**Companion to:** `fundraiser-money-state-machine.md` (authority on money) · `fundraiser-board-v2.md` (authority on flows) · `fundraiser-admission-addendum.md` (authority on passes) · `fundraiser-tiered-admission-addendum.md`

Adds a record of **how** a contributor paid, visible on the host ledger. Requires one migration and one check constraint.

**Changed in 1.1.** The 1.0 check constraint was written as an equality between two boolean expressions and did not hold under a nullable `tender` — `STRIPE + NULL` evaluates to UNKNOWN and passes. §8 now enumerates the legal pairs explicitly and splits enforcement between the constraint and the application. §2 gains the CARD seam: `tender` is not purely what the contributor used, and the constraint expressing that is the first thing a connected non-Stripe processor breaks.

---

## Rule of this document

Adds a **display and reconciliation field**. Does not change how money works.

Nothing here moves a dollar, creates a state, or changes who is eligible for anything. It adds invariants 58–63. If it disagrees with the money doc, the money doc wins and this document is wrong.

**Numbering caution.** The tiered admission addendum §11 already found a collision at 42–44 between two specs. These continue from 57 on the assumption that the tiered addendum's 48–57 are current. Cite these by name, never by number — board-v2 §17.

---

## 1. The problem

`paymentMethod` is one field carrying two meanings.

```
stripe   →  the system watched the money settle
cash     →  everything else
```

The ledger renders this field correctly — a released Stripe row on the Hampton board reads `card` today. The problem is upstream. A parent who Zelled $80, a parent who handed over a folded $80, and a parent who wrote a check all take the only path the host has, and all three land in the same bucket.

The host knows which was which. At close she has to walk to a bank with a number she can account for, and the ledger can't tell her where any of it came from.

**`cash` has stopped meaning cash. It means not-Stripe.** That is the defect, and adding values to the existing enum does not fix it — it makes a field that already drives money logic start carrying cosmetic values too.

---

## 2. The split

Two fields, with two different jobs and two different owners.

| Field | Values | Owner | Job |
|---|---|---|---|
| `paymentRail` | `STRIPE` · `OFFLINE` | The system | Did we watch the money settle, or is the host attesting to it? Drives everything that already depended on `paymentMethod` |
| `tender` | `CARD` · `CASH` · `VENMO` · `ZELLE` · `CASHAPP` · `PAYPAL` · `CHECK` · `OTHER` | The host | What the contributor actually handed over. Display and reconciliation only |

**Rail is never chosen by a human.** The Stripe confirmation path writes `STRIPE`. Every host-recorded contribution writes `OFFLINE`. There is no third value, no host control, and no form field. Rail is the old `paymentMethod` with an honest name and the cosmetic load taken off it.

**`CARD` belongs to Stripe alone.** `rail = STRIPE ⟺ tender = CARD`, enforced by the constraint in §8. A host who swipes a card on her own reader records `OTHER` with a reference note — because on this ledger, `Card` has to mean *the system saw it settle*, and a host-attested card would quietly make that false.

### The CARD seam

That last rule buys safety by making one sentence in this document not quite true.

**`tender` is "what the contributor handed over" in every case except one.** A parent who taps a card on a host's own Square reader used a card, and the ledger will say `Other`. The information isn't lost — the reference note carries it — but it isn't in the enum, and no query can find it.

This is deliberate and it is a limitation, not a design. `CARD` currently encodes two facts at once: the contributor used a card, *and* Stripe settled it. Those are the same fact today because Stripe is the only processor, so the constraint costs nothing to enforce and gives the ledger a word that means exactly one thing.

**It is also the first thing that breaks.** §10 preserves a connected non-Stripe processor by making `paymentRail` an enum rather than a boolean. The day that lands, a third rail exists whose payments the system *does* witness — so it is not `OFFLINE` in any meaningful sense, and `STRIPE ⟺ CARD` is too strong, because a card settled by that processor is a card.

What to do then, stated now so it isn't rediscovered under deadline:

- Rail splits into *witnessed* rails (`STRIPE`, the new one) and *attested* rails (`OFFLINE`). That distinction is what §5's ledger marker actually draws, and what rail has meant all along.
- The constraint relaxes from `rail = STRIPE` to `rail IN (witnessed rails)`, and `CARD` becomes legal on any of them.
- `OFFLINE + CARD` stays rejected. A host-attested card is still a claim nobody verified, and that is the case the rule exists for.
- Rows already written are unaffected. Nothing about this is a backfill.

**None of this is built now** and none of it changes §11. The point is that the constraint is load-bearing for a model with one processor in it, and should be revisited as part of adding a second one rather than treated as a fixed property of the schema.

---

## 3. What tender may never do

This is the load-bearing section. Everything else here is a form field and a column.

**No money figure reads `tender`.** Not `raised`, not `prizePoolBaseCents`, not `finalRaisedCents`, not the prize ladder, not a fee estimate, not an eligibility check, not a state transition. Drop the column and every dollar in the system is unchanged.

**Tender never opens a second door to `paid`.** It is written inside a transaction that is already confirming a contribution, never in a transaction of its own. If recording a method can advance a square's state, this change has invented a second confirmation path and the state machine in money doc §2 no longer holds.

**Fees are a rail question, not a tender question.** Board-v2 §5 already calls estimated proceeds an estimate because processing cost varies by payment method — that variance is Stripe vs. offline, which rail already expressed. Zelle and cash cost the same nothing. No fee logic gains a branch.

---

## 4. Recording

The Record donation form gains a required method picker and an optional reference.

```
Method     ( ) Cash   ( ) Venmo   ( ) Zelle   ( ) Check   ( ) Other
Reference  ________________________        (optional)
```

**The picker is the board's payment handles, plus Cash, Check, and Other.** Same rule as SYSTEM-FLOW §9.7 — never offer a method the host can't actually receive. If she has Venmo and CashApp on this board, Zelle does not appear.

**Read the handles live, not at campaign start.** Invariant 16 locks square count, price, and the drawing terms at first confirmed contribution. It does not lock payment handles. A host who adds Zelle in week three sees Zelle in the picker in week three, and her earlier rows are corrected through §6 rather than rewritten.

**No default selection.** A preselected Cash is how the ledger got here. The host picks, every time.

**Reference is free text and nothing else.** A check number, a Venmo memo, the last four of a confirmation code. Shown only for non-cash tenders. Never parsed, never validated, never matched against anything, never shown publicly. It exists for the one evening a number doesn't tie out.

Offline rows also carry `recordedByHostId` and `recordedAt`. On a board with more than one organizer, "who took this money" is the first question asked and the hardest to reconstruct later.

---

## 5. Ledger display

Method shows the tender label. One column, as today.

```
Contributor      Type               Method              Status
Janelle Harris   Entry + donation   Cash                confirmed
Felicia Barnes   Entry tickets      Zelle · recorded    confirmed
Maureen Gold     Entry tickets      Card                confirmed
Daaliyah Tate    Entry tickets      Card                released
```

**Offline rows carry a subdued marker.** Wording is a copy decision; the requirement is that a host can tell at a glance which rows the system witnessed and which rows rest on her own word. Tapping an offline row reveals who recorded it, when, and the reference.

**Nothing about this reaches the public board.** Money doc §10 gives the public two numbers. Tender is not a third.

---

## 6. Correcting the record

Every row on a live board predates this change. Some of them are wrong, and the host is the only person who knows how.

**Tender and reference are correctable inline. Rail, amount, and status are not correctable through this path.** That asymmetry is the entire safety argument: a correction that cannot touch a dollar or a state cannot break reconciliation, so it doesn't need a confirmation modal, a permission, or a close-flow gate.

Every correction writes an audit row — host, row, old value, new value, timestamp. Same shape and same reasoning as `SignupLog` in the sign-up addendum §3: small, and the difference between "the number changed" and "the number changed at 6am and here's who changed it."

---

## 7. Close

`CLOSING` does not read tender. Reconciliation resolves outstanding card checkouts against Stripe and outstanding cash per square, both rail-level operations, unchanged.

What close gains is a host-facing breakdown on the summary:

```
Confirmed              $3,650
  Card                 $2,300
  Zelle                $  610
  Venmo                $  410
  Cash                 $  330
```

This is the actual deliverable of the whole change. It is the list she works from when she deposits, and it is currently a number she has to reconstruct from memory.

Subtotals sum confirmed, unvoided rows only — the same population the ledger header already totals.

---

## 8. Data model

### Contribution / payment row

| Field | Type | Notes |
|---|---|---|
| `paymentRail` | Enum | `STRIPE` · `OFFLINE`. System-written. Replaces `paymentMethod` |
| `tender` | Enum? | Null only on pre-migration rows. §9 |
| `tenderReference` | String? | Max 64. Free text. Never parsed |
| `recordedByHostId` | String? | Offline rows only |
| `recordedAt` | DateTime? | Offline rows only |

### TenderCorrectionLog — new

| Field | Type | Notes |
|---|---|---|
| `id`, `contributionId`, `hostId` | | |
| `field` | Enum | `TENDER` · `REFERENCE` |
| `oldValue`, `newValue` | String? | |
| `createdAt` | DateTime | |

### Constraints

```sql
CHECK (
  (paymentRail = 'STRIPE'  AND tender = 'CARD')
  OR
  (paymentRail = 'OFFLINE' AND (tender IS NULL OR tender <> 'CARD'))
)
```

**Write the legal pairs out. Do not express this as an equality between two boolean tests.** An earlier version of this document used `(paymentRail = 'STRIPE') = (tender = 'CARD')`, which is correct only if `tender` is `NOT NULL`. It isn't — §9 leaves historical offline rows null on purpose. With a null tender the right-hand side is UNKNOWN, the equality is UNKNOWN, and Postgres passes a CHECK that isn't false. `STRIPE + NULL` walks straight through it: a Stripe row with no tender, which is the one row this constraint exists to prevent.

The enumerated form is what holds.

| Rail | Tender | |
|---|---|---|
| `STRIPE` | `CARD` | ✅ |
| `OFFLINE` | `CASH` · `VENMO` · `ZELLE` · `CASHAPP` · `PAYPAL` · `CHECK` · `OTHER` | ✅ |
| `OFFLINE` | `NULL` | ✅ — historical rows only, §9 |
| `STRIPE` | `NULL` | ❌ |
| `STRIPE` | any non-`CARD` | ❌ |
| `OFFLINE` | `CARD` | ❌ |

**The database and the application split the work, and the split is the point.**

The constraint permits `OFFLINE + NULL` because that combination is legal — a few hundred rows on live boards are already in it, and a `NOT NULL` column would make the migration in §9 impossible to run.

*Newly recorded* offline contributions requiring a tender is a different rule about a different population, and it lives in the application path that owns recording. The database cannot express it without a timestamp cutoff baked into a constraint, which would be a worse thing to own than the rule itself.

The two together give invariant 62: null is reachable only by history, and the set can only shrink.

---

## 9. Migration

Three steps, and the middle one is the only irreversible thing in this document.

1. Add `paymentRail`, backfill `stripe → STRIPE` and `cash → OFFLINE`. Mechanical, lossless.
2. Add `tender`, backfill `STRIPE → CARD` and leave every `OFFLINE` row **null**.
3. Drop `paymentMethod` only after every read site moves to `paymentRail`.

**Do not backfill offline rows to `CASH`.** It would be true for most of the Hampton data and false for the rest, and there would be no way afterward to tell which rows were asserted by a host and which were invented by a migration. Null renders as *recorded by host* and is honest about what is known.

**Null is a historical state, never a new one.** The recording path requires a value. The set of null rows can only shrink, one §6 correction at a time.

---

## 10. Deferred

The data model forbids none of these.

| Deferred | Preserved by |
|---|---|
| Per-tender subtotals in the live ledger header | Same query as the close breakdown |
| CSV export of the ledger | Nothing here is display-only in the database |
| A second witnessed rail — a connected non-Stripe processor | `paymentRail` is an enum, not a boolean. **Relaxing invariant 59 is part of that work — §2, the CARD seam** |
| Reference validation or matching against a payout feed | `tenderReference` is untyped on purpose |
| Per-tender fee accounting | No fee logic reads tender today. Adding it is a rail change |

---

## 11. Invariants

Appended to money doc §9. Continues from 57.

58. `paymentRail` is written by the system and never chosen by a human. Stripe confirmation writes `STRIPE`; every host-recorded contribution writes `OFFLINE`. There is no third value and no form field.
59. The only legal pairs are `STRIPE + CARD`, `OFFLINE +` any non-`CARD` tender, and `OFFLINE + NULL`. `STRIPE + NULL`, `STRIPE +` any non-`CARD` tender, and `OFFLINE + CARD` are rejected by check constraint, written as enumerated pairs and never as an equality between boolean tests. `CARD` never appears in the host picker. **This invariant is scoped to a single witnessed rail — see the CARD seam in §2.**
60. No dollar figure, state transition, fee calculation, eligibility check, or prize computation reads `tender`. Removing the column leaves every number in the system unchanged.
61. Writing `tender` never creates or advances a path to `paid`. It is written inside a transaction that is already confirming a contribution, never in one of its own.
62. `tender` is null only on rows predating this change. The column stays nullable and the constraint permits `OFFLINE + NULL`; the requirement that every *newly recorded* offline contribution carry a tender is enforced in the recording path, not in the database. The set of null rows can only shrink.
63. Tender and reference are correctable; rail, amount, and status are not correctable through this path. Every correction writes an audit row naming the host, both values, and the time.

---

## 12. Build order

| # | Step | Note |
|---|---|---|
| M0 | Schema — `paymentRail`, `tender`, `tenderReference`, `recordedBy*`, `TenderCorrectionLog`, check constraint. Backfill §9 steps 1–2 | Ships alone. No UI. The only irreversible step. **Assert all three rejected pairs in §8 actually fail at the database, `STRIPE + NULL` first** |
| M1 | Move every read of `paymentMethod` to `paymentRail`; drop the old column | Nothing user-visible changes. Do this before any new UI so there is one source of truth to build against |
| M2 | Record donation picker + reference field | First step that writes a tender |
| M3 | Ledger Method column, offline marker, recorded-by detail | The screen that prompted this |
| M4 | Inline correction + audit log | Lets the host fix the rows that predate M2 |
| M5 | Close-flow tender breakdown | §7. The actual payoff |

M0 and M1 are worth landing as their own PR. Every subsequent step reads `paymentRail`, and doing the rename underneath live UI work is how the Feb 26 class of problem happens.

---

## 13. Files

Paths below are named where the existing specs name them and left italic where they are not. **Locate the italic ones; do not guess.**

| File | Change |
|---|---|
| `prisma/schema.prisma` | §8, plus the M0 migration |
| *record-donation route / action* | Accept and persist tender, reference, recorded-by |
| *record-donation form component* | Method picker read live from board handles, reference field |
| *host ledger component* | Method column, offline marker, detail reveal, inline correction |
| *tender correction route* | **NEW** — tender and reference only. Rejects any other field |
| *close / finalization summary* | §7 breakdown. Read-only; touches no finalization math |
| *Stripe confirmation path* | Write `paymentRail = STRIPE`, `tender = CARD` |
| *cash / offline confirm path* | Write `paymentRail = OFFLINE` plus the recorded tender |
| `SYSTEM-FLOW.md` | §7 field table: replace `paymentMethod` with both fields. Rule 9 |

---

## 14. Open questions

1. **Offline reversal.** A bounced check and a reversed Zelle are real and have no representation here. The ledger already renders voided rows, but money doc invariant 4 makes `CONFIRMED` terminal and invariant 5 denies a refund state. Whether an offline reversal routes through void — and what that does to `raised` — is a money-doc question. **This document does not answer it and must not decide it.**
2. **"Entry tickets" on the ledger.** The tiered admission addendum §2 states flatly that an admission is never called a ticket where a human can read it, because the word is spoken for by the drawing ticket. The ledger's Type and Ticket $ columns use it anyway. Unrelated to this change, invisible on a no-prize board, and fires the day Phase B turns prizes on.
3. **Subtotals before close.** §7 puts the breakdown in the close flow. A host chasing money in week three may want it live in the ledger header. Same query; deferred until asked for.
4. **Multi-organizer attribution.** `recordedByHostId` assumes the recorder is a Host record. If a volunteer or check-in staffer ever records money, that is a permissions change, not a column change — and the sign-up addendum's invariant 32 says they don't.

---

*End of addendum.*
