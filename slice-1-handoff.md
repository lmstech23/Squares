# Slice 1 — Admission Model and Activation

**For:** Claude Code
**Version:** 3 — FROZEN, released to build Aug 27, 2026

**Read first, in this order:**

| Document | Authority over |
|---|---|
| `fundraiser-money-state-machine.md` | Money and drawing eligibility. Invariants 1–22. **Wins every conflict** |
| `fundraiser-admission-addendum.md` **v2.0** | Admission model and schema. Invariants **23–33** |
| `fundraiser-board-v2.md` | Fundraiser flows and screens, including §16 build order |

**Superseded numbering — corrected 2026-08-31.** This brief was written against admission addendum **v1.4**, where the range was 23–41. The addendum is now **v2.0**: the declaration model is gone, and invariants 23–41 were replaced by **23–33**. The deleted invariants covered the attendance picker, the per-supporter ceiling, the Manage-attendance screen and token auth — surface that no longer exists, so nothing is missing.

The original line here read *"These three are consistent with each other as of v1.4. Every invariant-range pointer reads 23–41."* That was true at v1.4 and is false now; it is corrected rather than deleted so the drift is visible.

If you find a contradiction, stop and report it rather than choosing.

---

## What this slice is

Schema, the preparation step at claim time, and making payment confirmation mint admission passes.

**Nothing here is visible to any user.** No forms, no screens, no scanner, no email. A board with an event behaves exactly as it does today from every UI in the app. The only observable difference is rows in new tables.

That is deliberate. Activation is where a mistake is expensive and silent, and it should be reviewable alone before anything is built on top of it.

---

## Build

### 1. Schema — addendum §2

`Event` · `EventSupporter` · `AdmissionGrant` · `AdmissionPass` · `CheckInLog` · `CheckinStaffAccess` · `AttendanceAccessToken`

Nothing is added to `Board` or `Square`. If the implementation seems to want a column on either, the model is being misread — stop and flag it.

**There is no `Ticket` table and none should be built.** A drawing ticket is derived — money doc §5. Earlier drafts of this brief spoke of it as a model; that was wrong.

**Constraints are load-bearing, not decoration.** All five in addendum §2:

```
Event.boardId                                     unique
EventSupporter (eventId, identityKey)             unique
AdmissionGrant.squareBatchId                      unique where not null
AdmissionPass (eventSupporterId, sequenceNumber)  unique
AdmissionPass.token                               unique
```

`identityKey` is the purchaser email, lowercased and trimmed.

`CheckinStaffAccess.tokenHash` and `AttendanceAccessToken.tokenHash` are hashed at rest. **No raw bearer token is ever stored anywhere**, including audit trails: `AdmissionPass.checkedInByCheckinStaffId` and `CheckInLog.byCheckinStaffId` are foreign keys to `CheckinStaffAccess.id`, never the credential itself.

`EventSupporter.passSequenceCursor` is monotonic. Minting draws `cursor+1 … cursor+N` under the row lock and advances it. **Values are never reused and `void` is terminal** — see addendum §2 and invariant 40.

### 2. `src/lib/admission.ts`

The only module permitted to create, void, or count passes. Nothing else touches `AdmissionPass` directly.

```
resolveSupporter(eventId, email, name, phone, tx)      find or create, normalized key
createGrant(supporterId, squareBatchId, declared, tx)
declareAttendance(supporterId, count, tx)              validate; mint or void if active
activateSupporter(supporterId, tx)                     CAS pending -> active, then mint
remainingAllowance(supporterId)                        ceiling - declaredCount
```

**Every writer takes a transaction handle, without exception.** None is ever called outside one. `remainingAllowance` is the only read and the only one without `tx`.

`declareAttendance` rejects a count below the supporter's `used` pass total, and voids highest-sequence `active` passes first when lowering.

### 3. Preparation at claim time — addendum §4

In the same transaction that creates the `pending` or `reserved_cash` squares, on boards with an event: resolve or create the supporter, accept the optional `declaredAttendance` parameter **only** when the supporter row was just created, clamp it to the ceiling, and write the grant against `squareBatchId`.

No UI supplies that parameter yet. Absent, a new supporter gets `declaredCount = 0`. Correct — no declaration, no admission. Slice 2 wires the picker to the same parameter and nothing server-side changes.

### 4. Release cron — addendum §4

When a batch is released: if its grant has no remaining live squares, delete the grant; if the supporter is `pending` with no grants left, delete the supporter. **Active supporters are never touched.** Without this, abandoned claims inflate the host's headcount forecast permanently.

### 5. Activation joins the confirmation transaction

Both payment paths, one shared code path:

- `src/app/api/webhooks/stripe/route.ts` — batch confirmation
- the existing cash confirm route — **locate it, do not guess the path**

```
square           -> paid       (existing, unchanged)
supporter        -> active     (new, if not already)
mint N passes    -> N = declaredCount, sequence from passSequenceCursor
```

One transaction, **three writes**. Drawing eligibility is not a fourth — it is derived from the square being `paid` and needs no write of its own.

If minting fails, the square does not go paid.

**Concurrency-safe at the database level, not by status check.** `SELECT ... FOR UPDATE` on the supporter, then a conditional `UPDATE ... WHERE status = 'pending'`. Only the transaction that flips the row mints. The unique `(eventSupporterId, sequenceNumber)` is the constraint behind it. Both are required — addendum §4.

### 6. Host-entry squares

Created already funded, so there is no later confirmation to hook. Preparation and activation happen in one transaction at creation, keyed on the host's own email from the `Host` record.

`declaredCount` starts at 0, so **a host square mints no passes**. The supporter is active and ready; she declares attendance from the event panel in Slice 2, where she is already authenticated and needs no token. She is subject to the same ceiling as anyone.

---

## Acceptance

Each maps to an invariant. A failure means the model is wrong, not the test.

| # | Case | Expected |
|---|---|---|
| 1 | Claim created, board has event | Supporter `pending`, grant written against `squareBatchId`, **zero** passes (inv. 24, 37) |
| 2 | Same claim retried / webhook replayed at claim time | Still one grant. Unique constraint holds |
| 3 | Card purchase, declared 3, first mint on a fresh supporter | Supporter active, exactly 3 passes, 3 unique tokens, cursor advanced to 3. Assert the **count and the cursor**, not literal sequence values |
| 4 | Cash reservation, declared 4, unconfirmed | Supporter `pending`, `declaredCount = 4`, zero passes |
| 5 | Host confirms that reservation | One transaction: square paid, supporter active, 4 passes. Drawing eligibility follows from the square |
| 6 | 3 squares reserved, declared 4, **1** confirms | All 4 passes minted (inv. 26) |
| 7 | **Two squares in one batch confirmed concurrently** | Supporter activates **once**. Exactly `declaredCount` passes. Never 2× (inv. 38) |
| 8 | Same as 7, forced constraint collision | Losing transaction rolls back cleanly. Its square is retryable. No orphans |
| 9 | Second purchase, same email | Same supporter row. No new allowance. `declaredAttendance` ignored and logged (inv. 28) |
| 10 | Second purchase, different email | Separate supporter, fresh allowance. Accepted weakness |
| 11 | Active supporter, later unpaid purchase | Stays active. Passes untouched (inv. 29) |
| 12 | Lower declaration 4 → 2, none used | Sequence 3 and 4 voided (highest first), 1 and 2 remain. Cursor unchanged |
| 13 | Lower declaration with a `used` pass | Voids `active` only. Never a `used` pass (inv. 27) |
| 14 | **Lower 4 → 2, then raise 2 → 4** | New passes at sequence **5 and 6**. Old 3 and 4 stay `void`. Their tokens never scan (inv. 40) |
| 14a | Raise declaration 2 → 4, nothing voided | 2 new passes at the next cursor values. Existing tokens unchanged |
| 14b | Attempt to lower below the `used` count | **Rejected**, not clamped. Used count returned. No passes voided (inv. 41) |
| 14c | Passes screen ordinal after 14 | Reads "Pass 1 of 4" through "Pass 4 of 4". No gap visible to the supporter |
| 15 | Declared 0 | Grant written, zero passes, supporter excluded from expected count |
| 16 | Claim abandoned, cron releases the batch | Grant deleted, pending supporter deleted, forecast returns to truth |
| 17 | Host square (`isHostEntry`) | Supporter resolved from host email, grant written, supporter **active**, `declaredCount = 0`, **zero passes**, **no** drawing ticket (inv. 15, 35, 39). She declares later from the event panel in Slice 2 |
| 18 | FreeEntry | Drawing entry, **no** grant, **no** passes (inv. 35) |
| 19 | Stripe webhook replayed after confirmation | No duplicate passes |
| 20 | Board reaches `CLOSED` then `DRAWN` | Passes unaffected, still `active` (inv. 36) |
| 21 | Board with no event | Every existing test still green. No admission rows anywhere |

Cases 7 and 8 need real concurrency — two transactions against the database, not two sequential calls with a mocked race. A sequential test will pass whether or not the guarantee exists, which makes it worse than no test.

Case 21 runs first and runs last.

---

## Not in this slice

Do not build, stub, or scaffold:

event block on the create form · attendance picker · passes screen · Manage attendance · the token email · check-in surface · QR generation · scanning · search · check-in · undo · roster · host event panel · gate allowance · host approval · standalone admission · refunds

`source`, `gateAllowanceTotal`, and the reserved enum values exist as columns and are never read. That is correct and intentional.

---

## Stop and ask if

- A change to `Board` or `Square` seems necessary, or a `Ticket` table seems necessary
- Activation cannot be made atomic with square confirmation
- Money doc invariants 1–22 appear to need amending
- The cash confirm path turns out not to share code with the Stripe path
- The three source documents contradict each other

The check-before-pushing rule applies. Walk the flow docs before pushing.
