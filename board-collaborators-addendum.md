# Board Collaborators — Addendum

**Status:** **READY FOR FREEZE** — product decisions applied. Invariants 91–109.
**Version:** 2.1 — cash-void sync, test renumber 44–60, environment-blocked annotation, numbering frozen
**Companion to:** `SYSTEM-FLOW.md` (authority on app behavior) · `fundraiser-money-state-machine.md` (authority on money) · `fundraiser-donations-addendum.md` (authority on the ledger) · `fundraiser-admission-addendum.md` · `fundraiser-signup-addendum.md` · `fundraiser-launch-readiness-addendum.md`

Adds board-scoped delegation so the person who creates a fundraiser is not required to be the person operating it.

---

## Rule of this document

Adds **who may act on a board**. Does not change what any action does.

Every capability granted here routes through an existing, unmodified path. A manager confirming cash runs the same transition, writes the same ledger record, and satisfies the same invariants as an owner confirming cash. **Delegation adds an actor, never an exception.**

This document owns invariants **91–109**, continuing after the launch readiness addendum's 71–90. Numbering is frozen and registered in `invariant-registry.md`.

---

## 0. What the code actually does today

This section exists because the requirement is small in concept and large in the repo.

### Authorization is inlined, everywhere

Every host route repeats the same four lines:

```ts
const board = await prisma.board.findUnique({ where: { boardId } });
if (!board || board.hostId !== host.id) {
  return NextResponse.json({ error: "Board not found." }, { status: 404 });
}
```

`src/lib/auth.ts` exports `getHost()`, which answers *"who is this?"* There is **no helper that answers "may this person act on this board?"** — that question is re-implemented at every call site.

**Consequence:** adding a second role means editing every host route, and the failure mode of missing one is a route that silently stays owner-only. A manager who can do eight of nine things and gets a 404 on the ninth will assume the app is broken.

**§3 makes this a prerequisite, not a side effect.** One helper, one query, every route through it.

### Cash confirmation has no audit trail today

`POST /api/host/boards/[id]/confirm-cash` flips the square and writes:

```ts
await prisma.paymentReference.create({
  data: { squareId, stripeSessionId: null, amount: board.squarePrice, method: "cash" },
});
```

**No actor. No reference to the host who confirmed it.** With one owner this was recoverable — there was only one person it could have been. With managers it is not, and the requirement asks for exactly the field that is missing.

This is a gap in shipped code, not a gap in the specs. It needs fixing whether or not delegation ships.

### Three access mechanisms already exist, and this is the fourth

| Mechanism | Who | Authorization | Accounts |
|---|---|---|---|
| Host session | Board owner | Supabase auth → `Host.supabaseUserId` | Yes |
| `CheckinStaffAccess.tokenHash` | Gate staff | Bearer token, board-scoped | No |
| `SupporterAccessToken` | Contributors | Bearer token, supporter-scoped | No |
| Cash PIN | Players reserving cash | Shared 4-digit secret | No |
| **`BoardCollaborator`** | **Managers** | **Supabase auth + live grant row** | **Yes** |

The bearer-token mechanisms exist because gate staff and contributors have no accounts and cannot be made to create them at a tailgate. **Managers are different: they are hosts.** They already have, or can get, an authenticated identity through the existing OTP flow, which is why this requirement can insist on identity rather than possession.

**The cash PIN must not become the delegation path.** It is a shared secret that gates *reserving* a square, is printed on the host dashboard, and is given to anyone paying cash. It authorizes nothing on the management side and must never be extended to.

---

## 1. Roles

Two for launch.

| Role | Meaning |
|---|---|
| **OWNER** | The creator. Full control. Exactly one per board |
| **MANAGER** | Operational management. Zero or more per board |

**Scope: fundraiser boards only.** Decided. Invites may be created only on `boardType = "fundraiser"`, and no Game Day surface changes. Board v2's promise that Game Day is unchanged in every respect holds.

The **backfill still covers every board** — one `OWNER` row each, Game Day included — because two authorization paths is the bug, not one uniform table. `requireBoardAccess` resolves identically for a Game Day board; the difference is that no second collaborator can ever exist on one.

**`Board.hostId` remains the owner pointer and does not move.** It answers *"whose Stripe account does this money settle to, and whose credit was spent."* Those are account-level facts about a person, not permissions.

**Authorization never reads `Board.hostId`.** It reads `BoardCollaborator`. Every board — including every board that already exists — gets an `OWNER` collaborator row in the migration.

That backfill matters more than it looks. The alternative is `hostId === host.id OR an active collaborator row exists`, evaluated at every call site, which is two code paths where one will eventually diverge. One uniform query has one behavior.

---

## 2. Capabilities

Roles are not checked at call sites. **Capabilities are**, and roles map to capability sets in one place. A third role later becomes a row in a table rather than a search for every `role === 'MANAGER'` in the codebase.

| Capability | OWNER | MANAGER |
|---|---|---|
| `board.view` — dashboard, grid, status | ✅ | ✅ |
| `contributors.view` — contributor and donor list, contact details | ✅ | ✅ |
| `payments.view` — per-contribution payment status | ✅ | ✅ |
| `reporting.view` — totals, breakdown, operational reporting | ✅ | ✅ |
| `cash.confirm` — confirm receipt of an existing reservation | ✅ | ✅ |
| `cash.record` — record a new walk-up contribution | ✅ | ✅ |
| `cash.release` — release an unpaid reservation | ✅ | ✅ |
| `cash.void` — void a mis-keyed cash donation *(donations §7)* | ✅ | ✅ |
| `attendee.manage` — roster, passes, dietary, donate-admissions flag | ✅ | ✅ |
| `volunteer.view` — volunteer-interest responses | ✅ | ✅ |
| `volunteer.manage` — sheets, slots, signups, when built | ✅ | ✅ |
| `board.edit` — title, description, contact details, goal | ✅ | ✅ |
| `staff.manage` — issue and revoke check-in staff links | ✅ | ✅ |
| `board.close` — trigger `CLOSING` and finalization | ✅ | ❌ |
| `draw.run` | ✅ | ❌ |
| `payout.configure` — Stripe destination, payment handles | ✅ | ❌ |
| `terms.set` — prices, prize percent, dates, and the invariant 16 list | ✅ | ❌ |
| `board.delete` | ✅ | ❌ |
| `collaborators.manage` — invite, revoke, change roles | ✅ | ❌ |
| `ownership.transfer` | ✅ | ❌ |

### The denials that were not in the requirement, and why

Three capabilities the requirement did not mention. Each is denied for launch by decision.

**`board.close` — owner only.** Closing runs `CLOSING`, resolves every outstanding payment, and writes `finalRaisedCents`, `finalPrizeBasisCents`, and `finalPrizePoolCents` — three permanently immutable numbers. The requirement says a manager may not alter finalized totals; closing is the act that *creates* them, which is the same authority one step earlier.

Operationally this is fine: the manager resolves cash all campaign long, and the owner presses the button. If it turns out to be wrong, the fix is a capability flip, not a redesign.

**`draw.run` — owner only.** Irreversible, idempotent-by-409, and determines who receives money.

**`collaborators.manage` — owner only, including inviting other managers.** The requirement forbids a manager granting *owner-level* access and is silent on manager-level. Silence resolves to no. A manager who can add managers can add themselves an ally, and the delegation graph becomes something nobody drew.

**`staff.manage` — granted.** Decided. Issuing check-in staff links is exactly the day-to-day work a manager is invited to do, and it does not breach admission §8's reservation of entitlement creation to the host: a check-in staff link is not entitlement. Staff *consume* passes and never create them (signup invariant 41, admission invariant 32). Granting the link does not add a single pass to the event.

### Capabilities MANAGER holds that touch money

Worth naming plainly, because "operational" can sound smaller than it is. A manager can **record new money into the ledger** and **mark money as received**. That is real financial authority over the campaign total, deliberately granted, and it is why §6's audit trail is a hard requirement rather than a nice-to-have.

What a manager cannot do is **move money** — the Stripe destination is owner-only, and Daali never holds funds in the first place.

---

## 3. The authorization helper

One function. Every host route through it. No exceptions.

```ts
// src/lib/board-access.ts
type Capability = 'board.view' | 'cash.confirm' | /* ... */;

async function requireBoardAccess(
  boardId: string,
  capability: Capability
): Promise<{ host: Host; board: Board; role: BoardRole }>
```

Behavior:

1. `getHost()` — existing, unchanged. No session → redirect or 401.
2. Read `BoardCollaborator` for `(boardId, host.id)` with `status = 'active'`. **No row → 404, not 403.** The existing routes already return "Board not found" for a board you don't own, and that is correct — a 403 confirms the board exists to someone who should not know.
3. Role lacks the capability → **403**. This one is a real 403: the person legitimately sees the board and is being told this specific action is not theirs.
4. Return host, board, and role.

**The grant is read live on every request.** No role claim in a JWT, no session cache, no `useMemo` on the client that outlives a revocation. This single property is what makes §7's revocation immediate, and it is the thing most likely to be optimized away by someone reducing database round-trips.

**Refactor scope.** Every route under `src/app/api/host/boards/[id]/` and every page under `src/app/host/boards/[id]/`. The inline `board.hostId !== host.id` check is deleted from each and replaced with one call. **A route that still contains that comparison after this lands is a bug**, and it should be checked by grep in review, not by memory.

---

## 4. The manager's board list

Board access is worthless if the manager cannot find the board.

`/host/boards` currently lists boards where `hostId = host.id`. It becomes:

```sql
SELECT b.* FROM "Board" b
JOIN "BoardCollaborator" c ON c."boardId" = b.id
WHERE c."hostId" = ? AND c.status = 'active'
```

Uniform for both roles, because owners have collaborator rows too.

**Board cards show a role badge**, so a manager who also owns boards can tell them apart at a glance:

```
Hampton Homecoming Tailgate          [ Manager ]
$3,650 raised · 12 cash to confirm
```

Owner cards carry no badge — owning is the default and a badge on every card is noise.

### What a manager sees around the list, and does not

A manager is a normal `Host` record with their own account. The page furniture stays account-level:

- **Credit badge** — their own credits, unaffected by boards they manage. Managing consumes nothing.
- **New Board** — available. It creates a board they own. Managing does not change that.
- **Stripe banner** — reflects their own connection state, which is irrelevant to boards they manage, since contributions settle to the **owner's** connected account.

That last one is worth a line of host-facing copy on a managed board, because it is the question a manager will ask on day one:

> Contributions go to [Owner name]'s account. You manage the board; you don't receive the money.

---

## 5. Invitation and acceptance

### The link is an invitation. It is never an authorization.

That sentence is the requirement, and everything below implements it.

```
owner generates invite
    ↓  link, one-time, expiring
invitee opens it
    ↓  not signed in? → existing OTP login, then return here
invitee accepts while authenticated
    ↓  one transaction
BoardInvite → accepted        (token consumed, terminal)
BoardCollaborator → active    (bound to Host.id)
    ↓
authorization now reads the collaborator row.
The link grants nothing from this moment on.
```

**Replaying the link after acceptance fails.** Forwarding it to someone else fails. Screenshotting it changes nothing. Possession is the mechanism for *offering* access and is discarded the instant access exists.

### BoardInvite

| Field | Type | Notes |
|---|---|---|
| `id`, `boardId` | | |
| `role` | enum | `MANAGER`. `OWNER` is not invitable — that is ownership transfer, §11 |
| `tokenHash` | String | **Unique. Hashed at rest**, like `CheckinStaffAccess.tokenHash`. The raw token is shown to the owner once and never stored |
| `boundEmail` | String? | Optional. When set, only a host with that verified identity may accept |
| `createdByHostId` | String | |
| `expiresAt` | DateTime | Default **7 days**. Not capped at campaign close — a manager may be needed after close for roster and payouts |
| `acceptedByHostId` | String? | |
| `acceptedAt` | DateTime? | Set once. Terminal |
| `revokedAt` | DateTime? | Owner may cancel an unaccepted invite |

**Email binding, default on when the owner supplies an email.** An unbound link pasted into a group chat is claimed by whoever taps first, and the owner has no way to know it went to the wrong person. Binding costs the owner one field she is already typing and removes that entire class of mistake. Unbound remains available for "text this to Renee right now."

**Acceptance is idempotent by constraint.** `acceptedAt` is set inside the same transaction that creates the collaborator row, conditional on it being null. Two simultaneous taps produce one collaborator and one 409 — the same shape as the draw-idempotency rule.

**A second invite for someone who already has an active grant is a no-op with a clear message**, not a duplicate row. The partial unique index in §7 enforces it at the database level regardless.

---

## 6. The two cash actions

The requirement asks these be distinguished. They are genuinely different operations and only one of them creates money from nothing.

### 6.1 Confirm an existing contribution

```
reserved_cash → paid
```

A record already exists. Someone reserved squares and is now handing over the money. The contribution was created at reservation with `pricePaidCents` already written (board v2: price is fixed at claim, not at payment).

**Unchanged in every respect** — money doc §4, per-square resolution, invariant 7, partial batches allowed. The only change is that the actor may now be a manager, and the actor is recorded.

### 6.2 Record a new walk-up contribution

No record exists. Someone walks up at the tailgate with cash and nothing was reserved.

Two sub-cases, and they are not the same:

| | Creates | Ledger |
|---|---|---|
| **Walk-up square purchase** | Squares, allocated and confirmed in one transaction | `Contribution` with `squareAmountCents > 0`, `paymentMethod = cash`, status `confirmed` |
| **Walk-up donation** | Nothing but money | `Contribution` with `donationAmountCents > 0`, no squares — donations addendum §7 |

**Both go through the Contribution ledger. Neither bypasses an invariant.**

A walk-up square purchase is `OPEN → CONFIRMED` in one host-initiated transaction — it does not pass through `reserved_cash`, because there is nothing to hold: the money is already in her hand. The square still receives `pricePaidCents` and `priceSource` from `effectivePrice()` (launch readiness invariant 75), still mints its admission pass in the same transaction (admission invariant 25), still becomes drawing-eligible in the same transaction (invariant 9), and is still blocked entirely when square sales are paused (launch readiness invariant 73).

**Walk-up recording is blocked once the board leaves `OPEN`**, same as every other new contribution (donations invariant 66). The close flow is where outstanding cash gets resolved, not where new cash gets invented.

### 6.3 The distinction that will be got wrong

**`recordedByHostId` and `isHostEntry` are independent and must never be conflated.**

| Field | Answers |
|---|---|
| `recordedByHostId` | **Who typed it in.** An audit fact |
| `isHostEntry` | **Whose money it is.** A drawing-eligibility fact — invariant 15 |

A manager recording a walk-up purchase for a parent sets `recordedByHostId` and leaves `isHostEntry` false. **That parent's square is fully drawing-eligible.** Setting `isHostEntry` because a host typed the record would silently disqualify every walk-up contributor at a cash-heavy tailgate — which is most of them — and nobody would notice until someone asked why their number was not in the pool.

The inverse also holds: **a manager's own contribution sets both.** Owners and managers are the board's insiders, and invariant 15 exists so an insider cannot hold a ticket that wins. Extending it to managers is not optional — without it, delegation creates a way to add drawing-eligible insiders to a board, which is a hole in the draw's integrity rather than a permissions detail. This is invariant 101 below, and it should be **automatic, never a checkbox.**

**Retroactivity is deliberately not applied.** Someone who contributed in September and is made manager in October keeps the eligible tickets they already held — eligibility activates in the confirmation transaction (invariant 9) and is never revoked afterward. Silently deleting someone's tickets because they agreed to help is worse than the alternative, and the alternative is disclosure: any winner who is an owner or manager at draw time is **marked as such in the public audit**, next to the existing organizer-contribution line. Deferred until the draw ships in Phase B — see §12.

---

## 7. Revocation

**Immediate, and it does not touch history.**

```
BoardCollaborator.status:   invited → active → revoked
```

`revoked` is terminal for that row. Re-inviting the same person later creates a **new** row, which preserves the record that they managed the board from August to October — a fact the audit needs and an `UPDATE` would erase.

**Uniqueness that permits re-invitation:**

```sql
CREATE UNIQUE INDEX ON "BoardCollaborator" ("boardId", "hostId")
  WHERE status <> 'revoked';
```

One active or pending grant per person per board, unlimited revoked history. The predicate references only its own table's columns, so Postgres accepts it — unlike the cross-table partial index the signup addendum discovered would not migrate.

### What revocation does and does not touch

| | |
|---|---|
| Board management authorization | **Terminated on the next request.** §3 reads the grant live |
| Their Supabase session | **Untouched.** They are still a host with their own boards |
| The board in their list | Gone — §4 filters on `status = 'active'` |
| Any invite link they hold | Already consumed at acceptance. Worthless either way |
| **Contributions they recorded or confirmed** | **Untouched. Never reassigned, never anonymized, never deleted** |
| **`BoardActionLog` rows naming them** | **Untouched.** Append-only |
| Passes they minted, cash they confirmed | Untouched. The money is real regardless of who is still on the team |

**Audit records reference `hostId` and never cascade.** No foreign key from a log or a contribution to `BoardCollaborator` may carry `ON DELETE CASCADE`, and revocation is a status change rather than a delete precisely so this cannot happen by accident. The record of who confirmed $340 in cash on October 2 has to survive that person leaving, which is the entire point of writing it down.

**Revoking the last manager is normal** and needs no confirmation dialog. **The owner's own collaborator row cannot be revoked** — that is ownership transfer, which is out of scope.

---

## 8. Audit trail

### On `Contribution`

The donations addendum specified `recordedByHostId`. Delegation splits it, because the person who records and the person who confirms are now routinely different people — the owner reserves squares for a parent, the manager takes the money at the gate.

| Field | Set when |
|---|---|
| `recordedByHostId` · `recordedAt` | A host or manager creates the record — reservation or walk-up. Null for contributor-initiated card checkouts |
| `confirmedByHostId` · `confirmedAt` | A host or manager confirms receipt. Null for card, where Stripe confirms |
| `voidedAt` · `voidedByHostId` · `voidReason` | Cash-donation void, donations §7. Void sets these fields and never changes `status`. Any authorized holder of `cash.void` may act, not only the recorder |

**Card contributions carry null actors and that is correct.** Nobody recorded them; a contributor paid and a webhook confirmed. A schema that demanded an actor here would produce a fabricated one.

### `BoardActionLog`

Append-only. For collaborator lifecycle and for actions with no natural home on the contribution row.

| Field | Type |
|---|---|
| `id`, `boardId`, `hostId` | |
| `action` | enum — `INVITE_CREATED` · `INVITE_ACCEPTED` · `INVITE_REVOKED` · `COLLABORATOR_REVOKED` · `CASH_RECORDED` · `CASH_CONFIRMED` · `CASH_RELEASED` · `CASH_VOIDED` · `TERMS_CHANGED` · `BOARD_CLOSED` · `DRAW_RUN` |
| `role` | The actor's role **at the time of the action**, denormalized |
| `targetId` | Contribution, square, or collaborator id |
| `metadata` | Json? |
| `createdAt` | |

**`role` is denormalized on purpose.** Reading it back through the collaborator table would report the actor's *current* role, so a revoked manager's October actions would render as "no access" — which is both wrong and exactly backwards from what an audit is for.

### Host-facing display

Owner-only, on the board panel. A manager can see the board's money; the record of *who touched what* belongs to the owner.

```
Cash activity

Oct 2, 4:12 PM   Renee M. (Manager)   Confirmed $50 · square #23
Oct 2, 4:09 PM   Renee M. (Manager)   Recorded walk-up $100 · squares #71, #72
Sep 28, 6:30 PM  You                  Reserved 3 squares · Dana W.
```

This is the difference between "the numbers look off" and "the numbers look off, and here is every entry with a name on it." At a fundraiser run by volunteers handling other people's cash, that is not a compliance feature — it is what keeps a disagreement from becoming an accusation.

**Nothing here is public.** The public audit (board v2 §10) is unchanged, with the single Phase B exception noted in §12.

---

### Owner notification on acceptance

**Decided: the owner is notified when an invite is accepted.** Email, once, at the moment the collaborator row is created.

It rides on the signup addendum's `NotificationDelivery` — unique `(notificationType, dedupeKey)` keyed on the invite id, with the same lease and fencing guards — rather than a new send path. Delivery **never blocks the acceptance transaction**: the grant commits, the send is attempted after, and a failed send is retried without touching authorization (signup invariant 45's shape, applied here).

This is the only notification this addendum adds. Revocation is not notified — the manager finds out on their next request, and an email announcing removal is a conversation the owner should be having herself.

---

## 9. Schema and migration

### BoardCollaborator

| Field | Type | Notes |
|---|---|---|
| `id`, `boardId`, `hostId` | | |
| `role` | enum | `OWNER` · `MANAGER` |
| `status` | enum | `invited` · `active` · `revoked` |
| `invitedByHostId` | String? | Null for backfilled owners |
| `acceptedAt`, `revokedAt`, `revokedByHostId` | | |

### Constraints

```sql
-- one live grant per person per board, unlimited revoked history
CREATE UNIQUE INDEX ON "BoardCollaborator" ("boardId", "hostId")
  WHERE status <> 'revoked';

-- exactly one owner per board
CREATE UNIQUE INDEX ON "BoardCollaborator" ("boardId")
  WHERE role = 'OWNER' AND status = 'active';

BoardInvite.tokenHash                unique
```

### Migration

| # | Change | Notes |
|---|---|---|
| 1 | Create `BoardCollaborator`, `BoardInvite`, `BoardActionLog` + indexes | |
| 2 | **Backfill one `OWNER` row per existing board** from `Board.hostId`, `status = 'active'` | Every board, including Game Day |
| 3 | Add actor fields to `Contribution` (§8) | |
| 4 | **Add `confirmedByHostId` to the existing cash-confirm path** | §0. Do this even if delegation slips |
| 5 | Create `src/lib/board-access.ts` and refactor every host route | The large one |

**Backfill correctness gate:** after step 2, assert every board has exactly one active `OWNER` row whose `hostId` equals its `Board.hostId`. A board with zero owner rows becomes invisible to its own creator the moment step 5 lands, which is a total loss of access on live boards.

**Steps 1–4 are safe to land independently of step 5.** The tables sit unread and the actor fields start recording immediately. Step 5 is the switch, and it is the one that needs the grep.

---

## 10. Invariants

**91–109.** Registered in `invariant-registry.md`.

**Authorization**

91. Board authorization is determined solely by an active `BoardCollaborator` row. No route reads `Board.hostId` to decide whether a person may act.
92. Every board has exactly one active `OWNER` collaborator, enforced by partial unique index.
93. Authorization is read live on every request. No role is cached in a session, token, or client state.
94. A person with no active grant receives 404, never 403 — the existence of the board is not disclosed. A person with a grant lacking the capability receives 403.
95. Capabilities are checked, never roles. Role-to-capability mapping exists in exactly one place.

**Invitation**

96. An invite link is an invitation and never an authorization. Once accepted, possession of the link confers nothing.
97. `acceptedAt` is set once, in the same transaction that creates the collaborator row, conditional on being null. A second acceptance returns 409 and changes nothing.
98. An invite may be accepted only by an authenticated host, and only by the bound identity when `boundEmail` is set.
99. An expired, revoked, or already-accepted invite cannot produce a collaborator row.
100. `OWNER` is not an invitable role. There is no path from an invite to owner-level access.

**Money and delegation**

101. A contribution whose contributor is an active OWNER or MANAGER of that board sets `isHostEntry` and is never drawing-eligible. This is automatic and has no override. *(Invariant 15 extension.)*
102. `recordedByHostId` records who entered a contribution. `isHostEntry` records whose money it is. Neither is ever derived from the other.
103. Every host- or manager-recorded and every host- or manager-confirmed contribution stores the acting host and a timestamp. A cash confirmation without an actor is invalid.
104. A walk-up contribution creates a `Contribution` and satisfies every money, pricing, admission, and eligibility invariant that applies to a contributor-initiated one. There is no host-initiated bypass of the ledger.
105. Walk-up recording is blocked when the board is not `OPEN`, and blocked for squares when square sales are paused.
106. A MANAGER cannot close a board, run a draw, alter a finalized total, change payout destination, set or override locked terms, delete a board, manage collaborators, or transfer ownership.

**Revocation**

107. Revocation terminates authorization on the next request and requires no other cleanup.
108. Revocation never alters, reassigns, anonymizes, or deletes any historical record of that person's actions. No audit or ledger row cascades from a collaborator row.
109. `revoked` is terminal. Re-granting access creates a new collaborator row and preserves the prior one.

---

## 11. Required tests

> **Environment-blocked tests: none.** Every test in this section is executable in the current environment. Walk-up recording, cash confirmation, and manager-contribution eligibility all run through the cash path, and the authorization, invite, revocation, and audit tests never touch Stripe.
>
> This suite is therefore the one that can be fully green before a non-production environment exists, and it should be.


44. **Manager sees the board.** Accept an invite; assert the board appears in the manager's list with a Manager badge, and that boards they neither own nor manage do not.
45. **Every route.** For each host route, assert manager access matches §2 exactly — permitted routes succeed, denied routes 403. **This is a table-driven test over the route list, not one test per route**, so a new route added without a capability fails it by default.
46. **Non-collaborator gets 404.** An authenticated host with no grant hits a board route. Assert 404 and that the response body reveals nothing about the board.
47. **Link is not authorization.** Accept an invite, then replay the same link, then have a second host open it. Assert both fail and no second collaborator row exists.
48. **Bound invite.** With `boundEmail` set, a different host attempts acceptance. Assert rejected and the invite stays unaccepted.
49. **Concurrent acceptance.** Two simultaneous taps. Assert exactly one collaborator row and one 409.
50. **Revocation is immediate.** Manager holds an open dashboard. Owner revokes. Assert the manager's very next request fails, with no logout and no cache flush.
51. **Revocation preserves history.** Manager confirms cash, then is revoked. Assert the contribution keeps `confirmedByHostId`, the log rows survive, `raised` is unchanged, and the passes minted remain valid.
52. **Re-invitation.** Revoke, re-invite, accept. Assert two collaborator rows, one revoked and one active, and that the partial unique index permitted it.
53. **Walk-up square purchase.** Manager records a $50 walk-up. Assert one `Contribution` confirmed, square `paid` with correct `pricePaidCents` and `priceSource`, one admission pass minted, **drawing-eligible**, `isHostEntry` false, `recordedByHostId` set to the manager.
54. **Manager's own contribution.** Manager records a contribution for herself. Assert `isHostEntry` true, **not** drawing-eligible, counts toward `raised`, and is marked in the public audit.
55. **Walk-up blocked when paused.** Square sales paused for a missing regular price. Assert a walk-up square purchase is rejected and a walk-up donation succeeds.
56. **Walk-up blocked after close.** Board at `closing`, `closed`, and `drawn`. Assert rejection at every status, via direct API call.
57. **Cash confirm audit.** Manager confirms a reservation. Assert `confirmedByHostId`, `confirmedAt`, and a `CASH_CONFIRMED` log row carrying `role = MANAGER`.
58. **Log role is historical.** Manager acts, is revoked, is re-invited as a manager again. Assert the original log row still reads MANAGER and was not recomputed.
59. **Owner-only actions.** Manager attempts close, draw, payout change, terms edit, delete, invite, and ownership transfer. Assert 403 on each and that nothing changed.
60. **Backfill.** Post-migration, assert every board has exactly one active OWNER row matching its `Board.hostId`, and that every existing owner can still reach every one of their boards.

---

## 12. Deferred

Decided at freeze: fundraiser-only scope, `staff.manage` granted, close and draw owner-only, owner notified on acceptance, no collaborator cap, ownership transfer deferred.

| Deferred | Preserved by |
|---|---|
| **Ownership transfer** | `Board.hostId` and the OWNER row are separable. Touches Stripe destination and credit attribution and deserves its own review |
| **Does the public audit mark an owner or manager who wins?** | Draw is Phase B. §6.3 recommends yes, alongside the existing organizer line. Not needed until B3 |
| Collaborator cap | No cap enforced. Adding one is a validation, not a schema change |
| Roles beyond OWNER and MANAGER | Capabilities are already the check; a third role is a row in the mapping |
| Game Day collaborators | Backfill already covers Game Day boards. Enabling is lifting one condition on invite creation |
| Revocation notice to the removed manager | Deliberately absent. The owner should have that conversation herself |

---

**Status: ready for freeze.**

*Open the numbering registry first; nothing here is implementable without it.*
