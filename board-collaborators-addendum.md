# Board Collaborators — Addendum

**Status:** **READY FOR FREEZE** — product decisions applied. Invariants 91–109.
**Version:** 2.2 — capability additions, blast-radius correction, invite requirement, winner-SMS pinning, §0 correction. Amends 2.1; see the changelog below
**Companion to:** `SYSTEM-FLOW.md` (authority on app behavior) · `fundraiser-money-state-machine.md` (authority on money) · `fundraiser-donations-addendum.md` (authority on the ledger) · `fundraiser-admission-addendum.md` · `fundraiser-signup-addendum.md` · `fundraiser-launch-readiness-addendum.md`

Adds board-scoped delegation so the person who creates a fundraiser is not required to be the person operating it.

---

## Version 2.2 — what this amendment changes

Ruled 2026-09-08, after a verification pass against the repository at the freeze
commit `91c9a98`. **A freeze is not immutability**: changes are versioned,
evidenced and changelogged rather than made in passing, which is the standard
the donations addendum's v2.3 set. Every item below is a product ruling, and
every factual claim behind one was read from the code or the live database
catalog rather than from a document.

| # | Change | Section |
|---|---|---|
| 1 | **§0's cash-audit claim was false and is corrected in place.** `confirm-cash` already writes `recordedByHostId` and `confirmedByHostId`. Migration step 4 has shipped | §0, §9 |
| 2 | **Four capabilities added** — `scores.enter`, `winner.notify`, `winner.resend`, `board.dismiss`. `board.edit` is not overloaded | §2 |
| 3 | **Blast radius corrected: 27 files, 28 comparisons**, not 21 | §3 |
| 4 | **The manager board list is not gated on the manager's own `paymentPreference`** | §4 |
| 5 | **Direct grant is rejected. The full invite flow is required**, and invariants 96–100 are not deferred | §5 |
| 6 | **`HOST_REMOVED` requires a persistent actor id** when that endpoint is built | §8 |
| 7 | **The backfill gate reads the database catalog**, not the ORM | §9 |
| 8 | **Winner SMS pins the recipient at first send** | §9.1 *(new)* |

**Invariant 106 is amended** by item 2 — its denial list gains `winner.notify`
and `board.dismiss`. No new invariant numbers were allocated by this amendment;
see the note at the end of §10.

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

### Cash confirmation now has an audit trail — corrected in v2.2

**This section previously read "Cash confirmation has no audit trail today" and
was false when the package was frozen.** It described a `PaymentReference` write
carrying no actor. `POST /api/host/boards/[id]/confirm-cash` writes both actor
fields today, at `route.ts:202-203`:

```ts
recordedByHostId: host.id,
confirmedByHostId: host.id,
```

`recordCashDonation` in `lib/contributions.ts:311-312` does the same. **Migration
step 4 in §9 — "add `confirmedByHostId` to the existing cash-confirm path" —
has shipped**, and §9's table is annotated accordingly.

Corrected in place rather than quietly deleted, because the claim was read as
fact and repeated: a section asserting a gap the code does not have sends
someone to fix something that is already fixed, and casts doubt on the sections
that are still accurate. Verified by reading the route, not the spec.

**What remains true** is the reason the section existed. With one owner an
actorless record was recoverable — there was only one person it could have
been. With managers it is not, and the actor fields are what make §8's audit
trail possible. They are now populated; delegation gives them meaning.

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

Grouped by **domain**, so a reader extending one can see which they are in
rather than scanning 24 undifferentiated rows. The groups are documentation, not
a second axis of authorization: **the check is always the capability**, never the
group, and a capability's role column is the whole of its meaning.

#### Board and reporting

| Capability | OWNER | MANAGER |
|---|---|---|
| `board.view` — dashboard, grid, status | ✅ | ✅ |
| `contributors.view` — contributor and donor list, contact details | ✅ | ✅ |
| `payments.view` — per-contribution payment status | ✅ | ✅ |
| `reporting.view` — totals, breakdown, operational reporting | ✅ | ✅ |
| `board.edit` — title, description, contact details, goal | ✅ | ✅ |
| `board.close` — trigger `CLOSING` and finalization | ✅ | ❌ |
| `board.dismiss` — hide a board from the host dashboard **(new in v2.2)** | ✅ | ❌ |
| `board.delete` | ✅ | ❌ |
| `terms.set` — prices, prize percent, dates, and the invariant 16 list | ✅ | ❌ |
| `payout.configure` — Stripe destination, payment handles | ✅ | ❌ |

#### Money

| Capability | OWNER | MANAGER |
|---|---|---|
| `cash.confirm` — confirm receipt of an existing reservation | ✅ | ✅ |
| `cash.record` — record a new walk-up contribution | ✅ | ✅ |
| `cash.release` — release an unpaid reservation | ✅ | ✅ |
| `cash.void` — void a mis-keyed cash donation *(donations §7)* | ✅ | ✅ |

#### Event: admission and volunteers

| Capability | OWNER | MANAGER |
|---|---|---|
| `attendee.manage` — roster, passes, dietary, donate-admissions flag | ✅ | ✅ |
| `volunteer.view` — volunteer-interest responses | ✅ | ✅ |
| `volunteer.manage` — sheets, slots, signups, when built | ✅ | ✅ |
| `staff.manage` — issue and revoke check-in staff links | ✅ | ✅ |

#### Game Day outcome

| Capability | OWNER | MANAGER |
|---|---|---|
| `scores.enter` — enter or correct Game Day period scores **(new in v2.2)** | ✅ | ✅ |
| `winner.resend` — resend a winner SMS to the pinned recipient *(invariant 117)* **(new in v2.2)** | ✅ | ✅ |
| `winner.notify` — determine a period winner and send the first SMS **(new in v2.2)** | ✅ | ❌ |
| `draw.run` | ✅ | ❌ |

#### Delegation

| Capability | OWNER | MANAGER |
|---|---|---|
| `collaborators.manage` — invite, revoke, change roles | ✅ | ❌ |
| `ownership.transfer` | ✅ | ❌ |

**24 capabilities across five groups: the 20 from v2.1, plus the four marked
(new in v2.2).** `draw.run` sits in the Game Day group and is NOT new — it was
in v2.1 and was only regrouped here. **Grouping is by domain, not by
provenance:** `board.dismiss` is one of the four new capabilities but belongs
under Board rather than Game Day, so the marker is on the row rather than the
heading. A heading that implied a whole group was new would misdescribe
`draw.run`, and one that grouped the new four together would put a dashboard
action beside three scoring ones.

**24 capabilities across five groups.** `board.dismiss` sits under Board rather
than beside `board.delete` in a "destructive" group, because it is recoverable
(dismiss addendum K10); it is owner-only on adjacency to delete, which §"The
four capabilities added in v2.2" states outright.

### The four capabilities added in v2.2

Three Game Day operational capabilities and one dashboard action, all found
unmapped by the verification pass. **`board.edit` is not overloaded to cover
them** — it means the board's terms and contact details, and scores are neither.

**`scores.enter` — MANAGER.** Verified non-terminal: `api/boards/[id]/scores`
performs an unconditional update of both score arrays with no per-period lock,
no append-only history, and no side effects. Its guards are entry
*preconditions* — the board must be `closed` with ten numbers assigned — not a
freeze. Writing a score determines no winner, sends nothing, and moves no payout
state. It is the manager's job at a table with a phone.

**`winner.notify` — OWNER.** It writes the winner lock and texts a real person,
and neither is undoable. This is the one Game Day action with the shape of
`board.close`: it creates a fact rather than recording one.

**`winner.resend` — MANAGER**, and only because §9.1 pins the recipient.
Before that change resend re-read `playerPhone` from the square at send time, so
it was not a repeat of a send but a **new send to whatever number the square
currently held** — an authority to text an arbitrary recipient, which is not a
manager capability. Production verification made the change free: 22 boards, 22
empty maps, zero notifications ever sent, so there is no legacy state to
migrate. **Were the pinning not to ship, `winner.resend` reverts to OWNER.**

**`board.dismiss` — OWNER.** Recoverable per dismiss addendum K10, so this is
not a data-risk denial. It is owner-only on **adjacency to delete**: dismiss and
delete are the two actions that remove a board from where its owner expects to
find it, and a manager should not be able to make a board disappear from the
owner's dashboard. It is listed here rather than left as a special
authorization exception, because §3 admits no exceptions.

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

**Refactor scope — count of record: 27 files, 28 comparisons.** Corrected in
v2.2 from an earlier figure of 21, which described only the inline half.

| Group | Files | Notes |
|---|---|---|
| Inline `board.hostId !== host.id` in routes and pages | **21** | |
| Callers of `authorizeBoardEvent` | **5** | `signup-sheet`, `signup-slots`, `signup-slots/[slotId]`, `signup-slots/reorder`, `check-in-staff-handlers.ts` |
| The helper's own comparison, `lib/host-auth.ts:37` | **1** | |
| | **27 files** | **28 comparisons** |

**The two groups are disjoint** — no file uses both mechanisms — so the counts
add rather than overlap. The 28th comparison is the second one inside
`check-in-staff-handlers.ts`, which carries **two comparisons behind two public
endpoints**: `check-in-staff` and `volunteer-access` both delegate into it.

### What the grep rule actually says — v2.2

> **No `Board.hostId` comparison may be used as a substitute for board
> capability authorization.**

It does not prohibit an ownership check whose domain rule is ownership itself.
Two things were being conflated, and the distinction is the difference between a
clean sweep and a mechanical one:

| | |
|---|---|
| **Board authorization** | "may this person act on this board?" — always a capability, never `Board.hostId` |
| **Ownership as a domain fact** | "is this board mine?" — a legitimate question with a legitimate answer |

**One documented exception exists.** `POST /api/host/credits/checkout` is
ACCOUNT-scoped: it sells the signed-in host platform credits for their own
account through a platform-level Stripe session, credits their own
`boardCredits`, and works with no board at all. Its optional `boardId` exists
only so the webhook can auto-activate a board waiting to be paid for, and the
question it asks is literally *"is this pending board mine?"*

It was briefly gated on `payout.configure`, which was wrong twice: that
capability means where a board's CONTRIBUTIONS settle, and the check sat inside
`if (body.boardId)` — protecting the rarer path while leaving the common one
ungated. **Ruled 2026-09-08: restore the ownership comparison.** Buying credits
requires no `BoardCollaborator` capability, and no capability was invented to
satisfy a grep.

The route carries a comment saying so. **A future grep-to-zero pass must not
replace it.**

**A route that still contains that comparison after this lands is a bug**, and
it is checked by grep in review, not by memory. **But grep counts files, and one
file here hides two comparisons behind two endpoints** — so both public
check-in-staff endpoints are tested by hand rather than trusted to a zero count.

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
- **No payment-preference gate.** Added v2.2, and it is a removal, not an addition — see below.
- **New Board** — available. It creates a board they own. Managing does not change that.
- **Stripe banner** — reflects their own connection state, which is irrelevant to boards they manage, since contributions settle to the **owner's** connected account.

That last one is worth a line of host-facing copy on a managed board, because it is the question a manager will ask on day one:

> Contributions go to [Owner name]'s account. You manage the board; you don't receive the money.

### The board list is not gated on the manager's own payment preference

`src/app/host/boards/page.tsx:12` currently redirects to `/host/payment-setup`
whenever the **session host's** `paymentPreference` is null:

```ts
if (!host.paymentPreference) redirect("/host/payment-setup");
```

**That gate must move to the board-creation path.** A manager who has never set
her own preference — because she has never created a board, which is the whole
point of being invited to manage someone else's — would be redirected away from
the list before it renders, and could never reach a board she has a valid grant
on. Her own account state would gate access to another person's board.

**Knowing how you get paid is a precondition for creating a board, not for
viewing one you were invited to manage.** `/host/boards/new/page.tsx:9` already
enforces it correctly for creation and is unchanged.

The three board pages — `page.tsx`, `donations/page.tsx`, `volunteers/page.tsx`
— read `board.cashModeEnabled`, a board column set once at creation, and are
already correct under delegation. `isCashHost` appears in none of them.
Verified 2026-09-08 by reading every `paymentPreference` and `isCashHost` call
site; **no API route reads `paymentPreference` to decide behaviour on an
existing board.**

**Stage placement, resolved.** The board-list join and this redirect's removal
ship in the **first usable manager release**, whichever stage number that lands
under. The addendum and the build brief disagree on the label; the milestone is
what governs — *a manager signs in as herself, sees the boards she manages,
opens one, and performs allowed manager actions.* A join that returns managed
boards behind a redirect that hides the list is not that milestone.

---

## 5. Invitation and acceptance

### Direct grant is rejected — v2.2

**The full invite and acceptance flow is required. Invariants 96–100 are not
deferred**, and no direct-grant shortcut may be introduced to get a manager onto
a board sooner.

This is not a preference about ceremony. It follows from what the `hosts` table
can actually key on, read from the live catalog on 2026-09-08:

- **`supabase_user_id` is the only unique column**, besides the primary key.
  `hosts_supabase_user_id_key` is the sole unique index.
- **`email` is not unique**, and is not reliably an email. Both creation paths —
  `lib/auth.ts:22` and `app/auth/callback/route.ts:19` — write
  `user.email ?? user.phone ?? user.id` into it, so it may hold an email, a
  phone number, or a UUID.
- **There is no `phone` column at all.**
- **A pre-provisioned row would be stranded.** `getHost()` creates the Host row
  lazily on first authenticated request, keyed on `supabaseUserId`. A row
  written ahead of that has no `supabaseUserId` to match and is never found
  again; the invitee signs in and gets a second, empty row.

So there is **no stable pre-authentication identifier to bind a grant to**. A
direct grant would have to key on the email field, which is neither unique nor
necessarily an email — it would silently grant board access to whoever happens
to hold a colliding value, or to nobody at all.

The invite flow solves this by binding **after** authentication: the invitee
proves an identity through the existing OTP flow, and the collaborator row is
created against the `Host.id` that identity resolves to. That is the only point
at which a durable identity exists.

**Board Management is not delivered until a real manager can get onto a board
using her own authenticated identity.** The foundation commits — collaborator
schema, `board-access.ts`, the authorization switch — establish authorization;
they do not establish access. The invite flow is what makes a manager exist.

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

### `SignupLog` and `HOST_REMOVED` — v2.2

`SignupLog.actorType` is `SUPPORTER | HOST`. Under delegation an owner and a
manager both log as `HOST`, so the sign-up audit cannot say **who** removed a
helper — which is the one question an audit of a removal exists to answer.

**This is currently unreachable and does not block delegation.** `HOST_REMOVED`
is an enum value with no endpoint behind it, for anyone: `signup-rules.ts:296`
says so, and `signups.ts:319` is the only writer, reached only through paths a
supporter drives. Nobody can remove a helper today.

**The requirement is bound to the endpoint, not to a date — invariant 118.**
Whoever builds the removal route adds a persistent actor id in the same change.
**Shipping that endpoint without one is a defect**, not a follow-up.

**Extending `ActorType` to `OWNER | MANAGER` is not the fix.** §8 names the
human, not the role — a role is what someone held at a moment, and the audit
question is which person acted. `BoardActionLog` denormalizes `role` alongside
`hostId` for exactly this reason, and a removal record needs the same pair.

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
| 4 | ~~Add `confirmedByHostId` to the existing cash-confirm path~~ | **SHIPPED.** `confirm-cash/route.ts:202-203` and `contributions.ts:311-312` write both actor fields. Verified 2026-09-08 |
| 5 | Create `src/lib/board-access.ts` and refactor every host route | The large one |

**Backfill correctness gate — reads the database catalog, not the ORM.**
Strengthened in v2.2. After step 2, assert on the RESULTING STATE:

1. Exactly one active `OWNER` row per board.
2. Every such row's `hostId` equals its board's `Board.hostId`.
3. The count of active `OWNER` rows equals the count of boards.
4. Both partial unique indexes exist in `pg_index`.

**Catalog, not ORM**, and not a re-read through the same client that wrote the
rows. The standing warning applies: `migrate diff` reports zero drift whether or
not an index exists, and a generated client reports what the schema file claims
rather than what the database holds. Every assertion above is a query against
`pg_index` and the tables themselves.

**This is the first migration in the sequence to touch rows in live production
use.** Steps 1 and 3 create tables and columns nothing reads yet; step 2 writes
a row for every board that exists, and step 5 then makes those rows the only
thing standing between a host and her own board. A board with zero owner rows
becomes invisible to its creator the moment step 5 lands — a total loss of
access on live boards, discovered by the owner rather than by the deploy.

---

## 9.1 Winner notification: the recipient is pinned at first send — v2.2

`winnerNotifiedByPeriod` maps a period label to a locked `squareId`. The lock
pins the **square**; it does not pin the **phone**.
`resend-winner-sms/route.ts:76-87` re-reads `playerPhone` from that square at
send time, so editing the square's phone between the first send and a resend
sends to the new number. **Resend is therefore not a repeat of a send but a new
send to whatever number the square currently holds.**

**The stored value becomes structured**, carrying at minimum:

| Key | Meaning |
|---|---|
| locked `squareId` | Unchanged. The winner, fixed at notification |
| phone used | The number the first notification actually went to |

- `notify-winner` writes both atomically as the notification record.
- `resend-winner-sms` requires an existing record, sends **only** to the stored
  phone, and **never re-reads `playerPhone` as the destination** — invariant 117.
- Existing winner-lock semantics are preserved, including the un-notified-period
  guard: no record → 400, use the notify endpoint first.
- The map is not otherwise redesigned.

**No legacy branch is required.** Verified against production on 2026-09-08:
**22 boards, 22 empty `{}` maps, zero non-empty.** The column is
`jsonb NOT NULL DEFAULT '{}'`, and `notify-winner` has never run in production —
consistent with STATUS.md recording SMS as code-complete and awaiting compliance
approval. The shape change is free.

**A defensive invalid-shape guard is retained anyway.** A record without a
stored phone fails and tells the host to use the notify endpoint. **It does not
fall back to reading the square** — that fallback is the behaviour being
removed, and a guard that restores it under an error condition would reinstate
it precisely when something is already wrong.

**The shape itself is implementation-defined and is deliberately not frozen
here.** The binding requirement is only that the stored value carries, at
minimum, the locked `squareId` and the phone used for the initial notification.
An implementation may add fields later — a send timestamp, a provider message id
— without another product amendment. Freezing an object schema in this document
would make a routine addition a spec change.

**After the structured notification shape lands, `notify-winner` and
`resend-winner-sms` are the authoritative writer/reader pair for that shape.
Neither route may continue treating the stored value as the former string-only
`squareId` form.** There is no dual-read period and no compatibility shim,
because production holds no rows in the old form: 22 boards, 22 empty maps.

**Both routes consume the same map, so they change together**, and this ships as
its own correctness commit rather than inside the authorization switch. A shape
change buried in a 27-site refactor is one nobody can review.

**This is what makes `winner.resend` a MANAGER capability.** Without the
pinning it is an authority to text an arbitrary recipient, and it reverts to
OWNER.

**Steps 1–4 are safe to land independently of step 5.** The tables sit unread and the actor fields start recording immediately. Step 5 is the switch, and it is the one that needs the grep.

---

## 10. Invariants

**91–109, and 117–118.** Registered in `invariant-registry.md`.

**v2.2 amends 106** — its denial list gains `winner.notify` and `board.dismiss`,
the two capabilities added in §2 that resolve to OWNER. Per the registry's own
rule, amending an invariant consumes no new number; the registry row is marked
**Amended (§2)** and points here.

**Two new invariants were allocated on 2026-09-08**, from the next free number,
with nothing renumbered:

**Winner SMS**

117. A winner resend sends only to the phone number recorded at the time of the
     initial notification. The destination is fixed at first notification and is
     never re-read from the square. §9.1.

**Sign-up audit**

118. A `HOST_REMOVED` helper-removal audit record identifies the person who
     performed the action. Recording only the actor role does not satisfy this.
     §8.

**118 is binding on an endpoint that does not exist yet.** `HOST_REMOVED` has no
route for any role, so nothing violates it today — and nothing may ship that
removal route without satisfying it. An invariant with no current call site is
not dormant; it is a condition on the next person to write one.

Next free number: **119**.

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
106. A MANAGER cannot close a board, run a draw, alter a finalized total, change payout destination, set or override locked terms, delete a board, manage collaborators, or transfer ownership. **Amended v2.2:** nor notify a winner (`winner.notify`) nor dismiss a board (`board.dismiss`).

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
