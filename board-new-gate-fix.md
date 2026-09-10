# Fix — Cash hosts redirected to Stripe from New Board

**Environment:** beta.daali.app
**Severity:** High — blocks cash hosts on beta from creating new boards.
**Scope rule:** Board path only. **No Event behavior changes in this ticket.**

---

## 1. Observed vs expected

| | Cash host today | Cash host expected |
|---|---|---|
| `/host/boards` | Loads. Optional Connect Stripe banner | Same |
| `/host/boards/new` | **→ `/host/stripe`** | Form opens |
| `POST /api/boards` | Untested — see §3 | Accepts |

The dashboard showing the *optional* banner is what localizes this. Per
SYSTEM-FLOW §2 that copy is cash-host-only. The page guard one level down is
not reading payment preference at all.

> **Amended 2026-09-09.** This section originally said "the dashboard guard is
> correct and reading payment preference properly." **There is no dashboard
> guard.** It was deliberately removed on 2026-09-08 by `5eb144d` under
> `board-collaborators-addendum.md` v2.2 §4, so that an invited manager who has
> never set her own preference is not bounced off the board list before it
> renders. The dashboard's only redirect is `if (!host) redirect("/login")`.
> This premise was one day stale when the ticket was written. It is the reason
> Commit 2 was dropped — see §8.3.

---

## 2. No documentation change required

SYSTEM-FLOW §3A already specifies the correct behavior, and Rule 1 and Rule 5
already say Stripe is optional and board creation is never blocked. The document
is right; the code disagrees with it.

SYSTEM-FLOW's own opening line covers this case exactly: *if this document says
one thing and the code says another, fix the code.* The document-first rule is
already satisfied. Do not edit SYSTEM-FLOW as part of this ticket — there is no
design change here, only a code defect, and editing the spec to match broken
code is how the spec stops being an authority.

---

## 3. Both gates, not one

There are **two** independent Stripe checks between a host and a created board.
The ticket names the first. Fixing it alone makes the failure worse, not better:
the host reaches the form, fills in game name, teams, price, and payout split,
then gets a 403 on submit with their work still in the fields.

| Gate | Location | Status |
|---|---|---|
| #3 | `src/app/host/boards/new/page.tsx` | Confirmed broken |
| #4 | `src/app/api/boards/route.ts` | **Must be verified in the same change** |

Gate #4 has a known bad historical form. The `update-squares.sh` bundle in
project knowledge contains:

```js
// 2. Stripe readiness gate
if (!host.stripeChargesEnabled) {
  return NextResponse.json({ error: "Stripe account not ready..." }, { status: 403 });
}
```

No payment-preference check at all. `squares-fix-log-v2.docx` records this as
fixed on Feb 26. Gate #3 is recorded as fixed in that same log and demonstrably
is not, so **treat the log as unreliable evidence for gate #4** and read the
deployed route.

> **Resolved 2026-09-09.** Gate #4 did not hold a bad form — it held **nothing**.
> `349529a` deleted the entire block, comment included, on Feb 26. `POST
> /api/boards` has had no payment gate since. The tell was the route's step
> numbering jumping 1 → 3 across two blank lines.
>
> Two consequences. This section's argument for fixing both gates together was
> right for the wrong reason: fixing #3 alone would not have produced a 403 on
> submit, because there was nothing to 403. And Commit 1 does not *restore* a
> gate on that route — it **introduces** one on an endpoint ungated for six
> months. Low risk, since gate #3 blocks the UI path, but it is a new
> restriction on live traffic and warrants a preview deploy over a direct push.

---

## 4. The correct condition

Both gates evaluate the same thing:

```
paymentPreference is null          → /host/payment-setup   (not /host/stripe)
paymentPreference = "cash"         → allow
paymentPreference = "stripe"
    and stripeChargesEnabled       → allow
    and not stripeChargesEnabled   → /host/stripe   (API: 403)
```

Note the null branch. A host with no preference belongs at the payment-setup
screen, per SYSTEM-FLOW §1C step 2 — never at Stripe. Sending them to Stripe
silently decides a choice the product asks them to make.

`stripeAccountId` is **not** part of the condition. A cash host who started
Stripe onboarding and abandoned it is still a cash host and must not be blocked.
Readiness is `stripeChargesEnabled`; anything else is a proxy that drifts.

### Write it as an exhaustive switch over a parsed state

The bug is a denylist: *is Stripe unready* asked without first asking *does this
host use Stripe*. Rewriting it as a boolean with one more `&&` fixes today's
case and leaves the same shape for the next person.

Use the pattern already established in `src/domain/eventStatus.ts` [R1] —
allowlist the states that permit a thing, never denylist the ones that don't,
with an `assertNever` default.

**That pattern requires a finite union, and the column is not one.** Prisma
generates `paymentPreference: string | null` for a `String?` field, so a switch
directly on the column hands `string` to the default branch, `assertNever` fails
to narrow, and the build breaks. Three ways out, one of them wrong:

- Make it a Prisma **enum** (`enum PaymentPreference { cash stripe }`). Correct,
  and the right follow-up — but it is a migration, and this is a hotfix.
- **Parse at the boundary** into a union the switch can narrow. Authorized here.
- Casting with `as` to silence the error. **Do not.** It defeats the whole reason
  for the switch: the build stops warning at exactly the moment it would help.

**An unrecognized value is not the same fact as an unset one.** A host who never
chose, and a row holding `"card"` or `"CASH"` or an empty string, both need to
land somewhere safe — but only one of them is normal. Collapsing the second into
the first routes the host correctly and destroys the only evidence that something
is writing garbage into the column.

So the parse carries four states, and `UNRECOGNIZED` carries the offending value
with it:

```ts
type PaymentPreferenceState =
  | { kind: 'UNSET' }
  | { kind: 'CASH' }
  | { kind: 'STRIPE' }
  | { kind: 'UNRECOGNIZED'; raw: string }

function parsePaymentPreference(raw: string | null): PaymentPreferenceState {
  if (raw === null)     return { kind: 'UNSET' }
  if (raw === 'cash')   return { kind: 'CASH' }
  if (raw === 'stripe') return { kind: 'STRIPE' }
  return { kind: 'UNRECOGNIZED', raw }
}
```

The gate then switches exhaustively on `state.kind`:

```ts
function boardCreationGate(host): Gate {
  const state = parsePaymentPreference(host.paymentPreference)

  switch (state.kind) {
    case 'UNSET':
      return { allow: false, redirect: '/host/payment-setup' }

    case 'CASH':
      return { allow: true }

    case 'STRIPE':
      return host.stripeChargesEnabled
        ? { allow: true }
        : { allow: false, redirect: '/host/stripe' }

    case 'UNRECOGNIZED':
      logger.warn('unrecognized payment preference', {
        hostId: host.id,
        raw: state.raw,
      })
      return { allow: false, redirect: '/host/payment-setup' }

    default:
      return assertNever(state)
  }
}
```

`UNSET` and `UNRECOGNIZED` send the host to the same screen. Payment setup is
the safe destination for both because it is the one place that can repair the
state, and it asks a question rather than assuming an answer. They stay
**distinct cases** so the log fires only on the abnormal one.

Log server-side only. Do not surface the raw value to the host — "choose how
your players will pay" is the right thing for them to see either way.

Adding a fifth state later breaks the build at every gate, instead of falling
silently into whichever branch a boolean happens to land in.

**One shared function, imported by every consumer.** Two copies of this condition
is how they drifted apart in the first place — the dashboard guard is correct
today while the page guard is not, and that is only possible because they are
separate implementations of the same rule. Put it in `src/lib/`. Which consumers
move onto it, and in what order, is §8.

### Platform owner — characterize, do not change

**This is a characterization requirement, not a design decision.** Record what
the platform owner does today, before touching code, and assert it is identical
afterward. Do not extend owner bypass semantics, do not remove them, and do not
rationalize them if they look odd. A hotfix is the wrong place to decide what
owner status ought to mean.

The collision that makes this necessary: R5 sends a null preference to
`/host/payment-setup`, and if the owner account has no preference set, the new
gate would route it somewhere it may not go today. Whether that is a change
depends entirely on current behavior, which nobody has written down.

Record before writing code — in the same environment the regression tests will
run, since owner status may be determined by an env allowlist and therefore
differ between Preview and Production:

| Observation | Record |
|---|---|
| How owner status is determined | Column, env allowlist, or hardcoded id. Not documented anywhere in the project |
| The owner's `paymentPreference` value | Including null |
| `/host/boards` | Renders, or redirects where |
| `/host/boards/new` | Form, or redirects where |
| `POST /api/boards` | Status code, and credit delta |

That table is the baseline. If the new gate would move the owner off any of
those, the gate needs an owner check placed to preserve it — **preserving
observed behavior, not improving it.** File anything that looks wrong as a
separate ticket.

### The API cannot redirect

§4's condition table is written for the page gate.
For gate #4, `null`, `UNRECOGNIZED`, and `stripe`-unready are all refusals, but
they mean different things and should not collapse into one message. Return a 403
whose body names the destination the client should send the host to, so the form
can route rather than show a dead error.

## 5. The Fundraiser picker — do not gate it

**This fix gives cash hosts their first-ever access to the Game Day / Fundraiser
picker**, because the picker lives inside `/host/boards/new`, behind the broken
gate. That is correct and requires no additional gating.

### Correction to an earlier draft

An earlier version of this section recommended gating the Fundraiser option on
`stripeChargesEnabled`. **That recommendation was wrong and is withdrawn.** It
generalized from `fundraiser-money-state-machine.md`, which is Stripe-centric
throughout, and treated cash squares as an edge case in a card system.

`fundraiser-signup-addendum.md` §5 contains a section headed **"Cash and direct
payment"** specifying a designed non-card collection path:

```
reserve squares → check the box → pay the organizer directly
    → reservation stays unconfirmed, no access
    → host taps Confirm Cash → supporter goes active
    → email with SupporterAccessToken link
```

Two further signals that this is designed for, not tolerated: `fundraiser-board-v2.md`
§15 lists cash mode PIN and reserve/confirm among the pieces fundraiser leaves
unchanged, and §14 gives cash squares a defined platform-fee fallback — no
collectable fee, falls back to one credit. Nobody specifies fee behavior for a
path they consider invalid.

**`paymentPreference = "cash"` does not mean "cannot accept money."** It means
the money arrives on a different rail.

### Why no gate is needed

After gate #3 and #4 are fixed, every host who can reach the picker already has
a usable rail:

| Preference | Stripe ready | Reaches picker | Rail |
|---|---|---|---|
| `cash` | no | yes | Cash / direct, auto-enabled at creation |
| `stripe` | yes | yes | Card |
| `stripe` | no | no — → `/host/stripe` | — |
| null | no — → `/host/payment-setup` | — | — |

The two states with no rail are gated upstream by the very condition this ticket
implements. There is no reachable path to a fundraiser that cannot collect, so
there is nothing for a picker gate to prevent.

### The one thing to verify — V1

That table depends on SYSTEM-FLOW §3C's auto-cash-mode branch — *"if the host
chose Cash during onboarding, every board they create automatically has cash
mode turned on"* — applying to **fundraiser** boards, not only Game Day ones.

"Every board" reads inclusively, but that sentence predates the fundraiser
branch in `POST /api/boards`. If auto-cash-mode sits inside a Game Day-only code
path, a cash host gets a fundraiser board with no cash mode and no PIN — which
is exactly the unusable path this section argues is unreachable.

**V1: read the fundraiser branch of `POST /api/boards` and confirm auto-cash-mode
applies.** If it does not, that is a separate defect. Report it; do not fix it
here and do not gate the picker in response to it.

### The eventual rule, recorded not built

Fundraiser payment gating should eventually be **capability-based**, evaluated at
launch rather than at creation:

- the card rail requires Stripe readiness;
- the direct rail follows its own enablement state;
- launching a fundraiser requires **at least one valid rail**.

Note that "Direct Payments" as a named capability with its own enablement state
does not currently exist in the project documents. What exists is cash mode
(`cashModeEnabled`, `cashPin`, `cashLiabilityAccepted`) plus the payout handles
in SYSTEM-FLOW §3B, which are specified for paying winners *out*. Defining that
capability is the prerequisite for the rule above.

**This is a separate ticket.** Nothing in it is implemented here.

---

## 6. Determine regressed vs never-applied

Worth ten minutes before writing the fix, because the two have different
follow-ups.

```bash
git log -p --follow -- src/app/host/boards/new/page.tsx
git log -p --follow -- src/app/api/boards/route.ts
```

If the conditional gate was committed and later reverted, find the commit that
reverted it and understand why — something reverted it once and can revert it
again, and the regression test in §7 is the only thing that would catch it.

If it was never applied, the Feb 26 fix log has an entry marked done that was
not done, which means the other four entries in that log deserve the same
verification.

---

## 7. Regression tests

Ticket's three, plus the cases that separate a real fix from a lucky one. Each
runs against **both** gate #3 (navigate) and gate #4 (submit the form).

| # | State | Expected |
|---|---|---|
| R1 | `cash`, `stripeChargesEnabled = false` | Form opens. Board creates. **Primary case — the test account.** |
| R2 | `stripe`, `stripeChargesEnabled = false` | → `/host/stripe`. API 403. Gate still works |
| R3 | `stripe`, `stripeChargesEnabled = true` | Form opens. Board creates |
| R4 | `boardCredits = 0` | Form opens. Credit behavior stays downstream and unchanged |
| R5 | `paymentPreference = null` | → `/host/payment-setup`, **not** `/host/stripe` |
| R6 | `cash`, `stripeAccountId` set, `stripeChargesEnabled = false` | Form opens. Abandoned onboarding does not re-gate a cash host |
| R7 | Platform owner | **Characterization.** Identical to the §4 baseline table, field for field. Not "works" — *unchanged* |
| R8 | `cash` host creates a board | Cash mode on, PIN generated, liability pre-accepted — SYSTEM-FLOW §3C |
| R9 | `cash` host reaches the picker | Both Game Day and Fundraiser offered. **Picker behavior unchanged by this ticket** |
| R10 | `cash` host creates a **fundraiser** board | Cash mode on, **PIN null** — §5 V1. **Amended:** originally read "PIN generated," which is Game Day semantics. Fundraiser boards set `cashPin: null` by design per v2 §6C — a PIN exists so a host can hand a code to someone standing in front of her, and on a fundraiser nobody is. **Passed 2026-09-09** |
| R11 | `paymentPreference` set to an unrecognized value | → `/host/payment-setup`. **A log entry exists** carrying host id and raw value. Raw value not shown to the host |

R11 needs the row written directly — no UI produces this state, which is the
point. Set it to `"card"` in a scratch account, confirm both the routing and the
log line, then reset it.

R6 is the one most likely to be missed by a fix that reaches for
`stripeAccountId`. R8 confirms the fix did not disturb the auto-cash-mode branch
sitting in the same route, and R10 extends that check to the fundraiser branch.
R9 exists to catch a well-meaning implementer adding a Stripe gate to the picker
that this ticket explicitly does not want.

---

## 8. Implementation procedure

### 8.1 Surgical-edit rules

From STATUS Rules 3 and 4, and the Feb 26 incident recorded in
`squares-fix-log-v2.docx` — where a `cat >` overwrite destroyed the boards page,
deleting the credit badge, Stripe banner, board status sections, and the
payment-setup redirect, and the live site had to be reverted through Vercel:

- Surgical edits only. No full-file rewrites through the terminal.
- One file at a time, output verified before moving to the next.
- `src/app/host/boards/page.tsx` is the file that incident destroyed. It is not
  touched in Commit 1 at all.

### 8.2 Commit 1 — shared gate + the two broken consumers

Record the platform-owner baseline (§4) **before** editing anything. It cannot be
reconstructed after the change.

1. `src/lib/` — `parsePaymentPreference()` and `boardCreationGate()`.
2. `src/app/host/boards/new/page.tsx` — gate #3 calls the shared function.
3. `src/app/api/boards/route.ts` — gate #4 calls the shared function, returning
   403 with the destination in the body (§4).

Nothing else. The dashboard is untouched, the Fundraiser picker is untouched, the
Event path is untouched.

**Run R1–R11. Stop on the first failure.** Do not proceed to 8.3 with a failing
test, and do not "fix forward" past one — a red test here means the gate
semantics are wrong, and stacking a refactor on top makes the cause harder to
find.

### 8.3 Commit 2 — DROPPED, do not execute

> **Dropped 2026-09-09, before execution.** This section instructed: *"Move the
> guard in `src/app/host/boards/page.tsx` onto the shared function. That guard is
> currently correct — this commit changes no behavior."*
>
> **Both premises are false.** There is no guard on that page. The
> payment-preference redirect was deliberately removed on 2026-09-08 by `5eb144d`
> under `board-collaborators-addendum.md` v2.2 §4:
>
> ```
> -  if (!host.paymentPreference) redirect("/host/payment-setup");
> ```
>
> v2.2 §4 removed it so that a manager invited to someone else's board — who has
> never set her own preference, because she has never created a board, which is
> the entire point of being invited — is not redirected away from the board list
> before it renders. Her own account state would otherwise gate her access to
> another person's board.
>
> Executing this section would re-introduce that redirect and bounce every
> invited manager off the board list. It is not a no-op consolidation; it is the
> exact regression v2.2 §4 exists to prevent.
>
> **Nothing remains to consolidate.** v2.2 §4 said the gate "must move to the
> board-creation path," and Commit 1 completed that. The rule now has one
> implementation, enforced on both creation surfaces and nowhere else — the end
> state this section wanted, reached from the opposite direction.
>
> Commit 1 stands alone. §8.4 was designed for exactly that.

### 8.4 Revert boundary

The two commits are separable on purpose, and that property is the reason for the
split.

If Commit 2 regresses anything, **revert Commit 2 alone.** The cash-host fix in
Commit 1 stays deployed. Cash hosts keep working, and the consolidation gets
retried later with the failure understood.

This does not hold if the two are squashed on merge. **Merge them as two
commits** — a squash trades away the ability to drop the risky half while keeping
the fix, which is the whole reason the work was split.

> **Outcome 2026-09-09.** Satisfied in the degenerate case: Commit 2 was never
> written. Commit 1 (`1be9026`) stands alone with no dependency on it, which is
> the property this split was designed to guarantee.
>
> This section is now **historical rather than actionable**, and is kept
> deliberately: it records why the work was split, which is the reason dropping
> Commit 2 cost nothing.

## 9. Out of scope

Event path · `/events` · `currentOrganizer` · the credit system · pricing ·
any other entry in the Feb 26 fix log.

**The Fundraiser picker is explicitly out of scope and must not change.** Do not
add a Stripe gate to it. Do not add a rail check to it. §5 explains why, and R9
tests for it. The capability-based rail rule described at the end of §5 is a
separate ticket and nothing in it is implemented here.

**Do not touch anything under `src/app/events`, `src/app/e`, or
`src/app/api/events`.** `scripts/check-event-isolation.sh` should still exit 0
after this change; if it does not, this ticket left its lane.

---

## 10. Handoff

**Send this ticket to Claude Code on its own**, in its own session — not bundled
with the Event integration package.

The two pieces of work have opposite scope rules. This one must not touch
`/events`; the Event integration must not touch the Board gates. Separate
sessions are the cheapest way to guarantee that, because neither set of
instructions is in context to be misapplied to the other.
`scripts/check-event-isolation.sh` exiting 0 is the cross-check in both
directions.

**Order is a judgment call, with one thing in its favor.** This ticket is the
smaller and more urgent change, and it ends with a working test account. Running
it first makes the Event acceptance run easier to read: a failure there is then
an Event failure, not an ambiguity about which of two broken things caused it.

---

## 11. Follow-ups this ticket creates

These outlive the ticket. Give each one a home before this closes, or they leave
with it.

**F1 — V1 / R10's result.** If auto-cash-mode turns out to be Game Day-only, a
cash host gets a fundraiser board with no rail and no PIN. That is a real defect,
and §5 deliberately declines to fix it here. Whatever R10 returns needs recording
somewhere — including a pass, since a pass is what retires the concern.

**F2 — the capability-based rail rule.** §5 records the eventual shape: card rail
requires Stripe readiness, direct rail follows its own enablement state, launch
requires at least one valid rail. It cannot be built yet. **Direct Payments as a
named capability with its own enablement state does not exist in the project
material** — what exists is cash mode plus the payout handles, which are
specified for paying winners *out*. Defining that capability is the prerequisite.

One design question to carry into it: the rule evaluates at **launch**, and
fundraiser invariant 16 locks event terms at the first confirmed contribution. So
decide explicitly whether a rail check can still fail after money has moved. A
board that loses its only rail mid-campaign is a state worth deciding on
deliberately rather than discovering.

**F3 — audit the Feb 26 fix log.** If §6's archaeology shows gate #3 was never
actually applied, then `squares-fix-log-v2.docx` contains an entry marked done
that was not done. Four other entries rest on the same authority:

| Entry | Claim to re-verify |
|---|---|
| `api/host/payment-preference/route.ts` | Writes the preference, no longer a stub |
| `api/boards/route.ts` | Reads cash-host status from the preference, not hardcoded |
| `host/boards/page.tsx` | Redirect + credit badge + banner + status groupings restored |
| `api/cron/release-expired/route.ts` | Built, and actually running on the 5-minute schedule |

The cron entry is the one worth checking first — it fails silently. A gate that
misroutes gets reported by a host within a day; a cron that never runs leaves
squares locked and abandoned checkouts uncleaned, and the only symptom is a board
that fills more slowly than it should.

---

## 12. Execution record — 2026-09-09

**Commit 1 landed as `1be9026`. Commit 2 dropped (§8.3). Not yet pushed.**

### §4 platform-owner baseline

Owner status is `process.env.PLATFORM_OWNER_ID` (`constants.ts:19`) compared to
`host.id`, set to one shared value across Development, Preview and Production —
so §4's environment-divergence caution does not apply.

**Neither gate consults `isPlatformOwner`, before or after the change.** It is
read only on the credit path (`route.ts:464`) and for the dashboard banner
(`page.tsx:50`). The collision §4 anticipated does not arise: the owner's
preference is `cash`, not null. No owner check was needed, and none was added.

Production distribution: cash 3, stripe 1, null 2.

**OB1 — CLOSED 2026-09-09. There is no platform owner account.** The revealed
`PLATFORM_OWNER_ID` matches **no** current `hosts.id`. Since both checks are
strict `host.id === PLATFORM_OWNER_ID`, `isPlatformOwner` is false for every
host on every request, at both call sites. **The bypass is unreachable in
production.** Tracked as F5. Not altered by this hotfix.

**R7 — N/A for this change.** Commit 1 neither introduces nor removes
owner-bypass behavior: neither gate consults `isPlatformOwner`, and no owner
check was added. There is no owner behavior left to characterize, so the test
has no subject. The configuration defect predates this ticket.

**Two corrections to what this section originally recorded.** Both were wrong
and are kept visible rather than silently rewritten.

1. **The owner nomination was wrong.** This section identified `c94cbd1c…` by
   signature — 19 boards, 0 credits, 14 transactions. That signature is fully
   explained by 10 fundraiser boards on Path 0, which has no credit gate, plus 9
   game boards each debiting a credit. Checked per board, that host is **9 game
   boards against 9 debits**: every one paid. It is the account *least*
   consistent with owner status. The inference was labelled as inference and was
   still wrong; OB1 catching it is the process working.
2. **The `POST /api/boards` baseline row was wrong.** It recorded "200, credit
   delta 0, no `CreditTransaction`, board created open with `activatedAt`" —
   that is Path 1, which never executes. Actual behavior is Path 2 or Path 3 by
   balance: a credit is consumed and a `board_created` row written, or the board
   lands in `pending_payment` awaiting payment. **Had preview run against the
   original row, R7 would have read as a regression introduced by Commit 1.** It
   would not have been.

Corrected baseline, for whenever F5 is resolved: `/host/boards` renders with no
gate and shows the Connect-Stripe banner · `/host/boards/new` gated by
preference like any host · `POST /api/boards` takes Path 0/2/3, never Path 1.

**Ledger note.** Exactly one activated game board across all six hosts lacks a
`board_created` debit (`3dfac93b…`, 2026-05-29). It is **not** bypass evidence:
its `activatedAt` is six hours after `createdAt`, whereas Path 1 writes both in
one transaction, and that host's other two boards match to the millisecond. The
credit ledger has been edited outside the application on at least two accounts —
one holds 2 credits against a last recorded `balanceAfter` of 0 — so it cannot
carry weight either way. Feeds the existing free-credit ledger inconsistency
item.

### §6 archaeology — regressed twice, then deleted

Not "never applied." Both gates were fixed and unfixed, with different endings:

| Date | Commit | Event |
|---|---|---|
| Feb 25 | `e685189` | gate #3 fixed |
| Feb 25 | `da77045` | gate #4 fixed, same condition |
| Feb 25 | `b771c68` | **both reverted** — "remove dead `paymentPreference` refs" |
| Feb 26 | `2324cba` | gate #3 redirect removed entirely |
| Feb 26 | `349529a` | gate #3 restored correctly; **gate #4 deleted outright** |

The cause is named in the commit that did it. `b771c68` stripped a one-day-old
fix from two files while removing what it read as dead references. They were not
dead — they *were* the fix. Nothing caught it because nothing tested it.

**That is the finding worth keeping.** The defect class here is not a bad gate
condition; it is a correct fix with no test, deleted by a cleanup pass that could
not tell load-bearing code from residue. The 13-test gate suite added in Commit 1
is what prevents a third occurrence, and it matters more than the gate itself.

### R1–R11 — R1–R6 and R8–R11 pass, R7 N/A

`tsc --noEmit` clean · `npm run build` clean · 299 tests, 298 pass, 0 fail, 1
skipped (documented integration-DB signal) · new gate suite 13/13.

**R7 is N/A**, not passing — see the §4 baseline above. The platform-owner
bypass is unreachable in production, so there is no owner behavior to
characterize. Tracked as F5.

**Verification level, stated plainly:** R1–R11 are framed in §7 as
navigate-and-submit against a running app. They were executed as unit-level
equivalents against the shared function both gates now call, plus code reads for
creation-time side effects (R8–R10) and the diff for R9. That proves gate
semantics and that nothing adjacent moved. **It does not substitute for opening
`/host/boards/new` on the cash test account against a deployed build.**

### Release sequence — approved

Two reasons this does not go straight to `main`: the verification gap above, and
§3's finding that Commit 1 *introduces* a gate on an endpoint ungated for six
months rather than restoring one. A new restriction on live traffic earns a
preview pass.

1. ~~**Verify `PLATFORM_OWNER_ID`**~~ **— DONE.** Matches no `hosts.id`; the
   bypass is unreachable. OB1 closed, R7 N/A, F5 opened. Nothing further gates
   the deploy on owner identity.
2. **Put `1be9026` on a branch, deploy Preview.** Branch created. Note this
   project has **never** had a non-Production deployment — every deployment in
   its history targets Production. `vercel deploy` without `--prod` is the route
   that yields a genuine Preview without re-aliasing production. Preview shares
   the **production** `DATABASE_URL`, so step 4 writes real data.
3. **Browser-check three states** against §7:
   - cash test account → `/host/boards/new` opens
   - null-preference account → `/host/payment-setup` (asserted *not*
     `/host/stripe` — this is R5, and the destination is the whole point)
   - Stripe-unready account → `/host/stripe` — **no account currently exists in
     this state.** The only `stripe` host has charges enabled. Either flip a
     zero-board cash account to `stripe` temporarily and reset it, or accept R2
     as unit-tested only
   - ~~platform owner~~ — removed, no such account exists
4. **Submit one real board creation** on the cash test account, through the
   actual form. This is the only step that exercises gate #4 end to end; every
   other check stops at the page gate, and gate #4 is the newly introduced one.
5. **Remove the test board** under the protocol below, or leave it.
6. **Merge Commit 1 only.**
7. **Leave Commit 2 dropped, not deferred.** §8.3 records why. Nothing is
   waiting on it.
8. **Delete the stale ticket draft** from Downloads.

Steps 1 and 4 are the two that cannot be skipped. Step 1 because a preview pass
read against the wrong owner account proves nothing; step 4 because the unit
suite and the page-gate checks both stop short of the route that had no gate at
all.

### Preview pass — final record, 2026-09-10

Preview deployment `squares-26ieorcmn-daaliyah-tates-projects.vercel.app`, built
from `1be9026`. First non-Production deployment in this project's history;
`beta.daali.app` was not re-aliased.

| Test | Result |
|---|---|
| **R5** | **Preview browser PASS.** Null-preference host reaches the payment-preference screen — "How do you want to collect?", Credit & Debit Cards / Direct Payments — instead of `/host/stripe`. **The actual defect, confirmed fixed against a deployed build** |
| R1 / R4 | Preview navigate PASS — `c94cbd1c…` opens `/host/boards/new`. **Page level only.** That account is `chargesEnabled=true`, so it passes every version of the gate including the broken ones; it distinguishes nothing |
| R2 / R3 | Unit-tested. No account exists in the required state, or it is not the operator's to sign into |
| **Gate #4** | **ACCEPTED VERIFICATION GAP.** Semantics proven by the 13-test suite. Deployed request wiring on that route **not exercised end to end.** Recorded as a gap, not an inferred pass |

**Step 4 was not run, by decision.** Creating a production board on a live
19-board account to close a checkbox is not a trade worth making. No artifact was
created, so no cleanup was required.

**Data integrity.** Baseline 22 boards before, 22 after, delta zero — no board
created, none removed. No host row modified. `fb3f4fdb…` remains
`paymentPreference = null`: the picker was reached and left without selecting.
That preservation is load-bearing — it is the only null-preference account
available, no UI can set a preference back to null, and choosing an option would
have permanently consumed the only account able to re-run R5.

**§1's title and severity were amended before merge.** Tracing the deployed
conditional, `"cash" !== "cash"` short-circuits, so **no cash host was ever
blocked.** The affected population is null-preference hosts. The original
diagnosis came from reading the dashboard's optional-Stripe banner as
cash-host-only per SYSTEM-FLOW §2, when its real condition is
`!isPlatformOwner && !host.stripeAccountId` and never reads `paymentPreference`.
Compounded by F5: with the owner bypass unreachable, `isPlatformOwner` is always
false, so that banner shows to **every** host without a `stripeAccountId` —
including precisely the null-preference hosts that were actually broken. The
signal read as "cash host" was firing on the broken population.

**Commit 1 was unaffected by the correction.** `UNSET → /host/payment-setup` was
always the real defect and is what the fix addresses.

### Closing the gate #4 gap — a test, not a person

The accepted gap gets closed by a route-handler integration test for
`POST /api/boards`: mocked cash host → 200, null-preference host → 403 carrying
the correct `destination`. No DB write, no browser.

It catches the three wiring faults the manual test would have caught — a bad
import, a gate placed after body parsing, a malformed 403 body — and unlike a
manual pass it runs on every commit forever.

**This is the same lesson as `b771c68`:** a correct fix with no test was deleted
by a cleanup pass that could not tell load-bearing code from residue. The durable
protection is a test, not a careful person.

### Production-data safety protocol — BINDING

**Preview reads and writes the production database.** There is one
`DATABASE_URL` across Production, Preview and Development. `c94cbd1c…` alone
holds 19 boards including 10 fundraisers, at least one live. Every account
loaded during step 3 belongs to a real person.

**No existing board may be edited, activated, deleted, or reused.**

**Step 3 is navigate-only.** Load the URL, observe the destination, leave. No
form submissions, no payment links, no clicks that write.

**Step 4 — identify by set difference, never by predicate.** Before creating,
record the test title, the timestamp, the host id, and the **complete set of
board ids on that host**. Create one **brand-new Game Day board** — not a
fundraiser, which avoids fundraiser-specific dependent rows. Snapshot the id set
again. The test board is the delta, and **the delta must be exactly one id.**
Zero or more than one means something wrote concurrently: **stop, and do not
clean up.**

**Step 5 — surgical or not at all.** Enumerate every row referencing that board
id and report them before deleting anything. If everything cascades, delete the
board by **that one id**. If anything survives independently, report and wait.

**Never delete by title, host, date range, status, or "latest board."** Those
predicates match live boards.

**If the test board cannot be uniquely identified, leave it and report.** A
stray test board is housekeeping. A deleted live fundraiser is someone's
cancelled event.

### Implementation notes beyond the spec

- `stripeChargesEnabled` is `Boolean?` — genuinely three-valued. The gate treats
  null as not-ready, with a test. The §4 sketch did not anticipate this.
- `stripeAccountId` is absent from the gate's input type, so §4's warning against
  consulting it is enforced by the compiler rather than by review.
- Gate #4 returns 403 with `{ error, reason, destination }` so the form can route.
- `assertNever` was defined locally. `src/domain/eventStatus.ts`, `assertNever`,
  and `scripts/check-event-isolation.sh` ship with the Event package and do not
  exist in this repo yet; §10 puts that work in a separate session. Lane
  compliance was verified against the diff directly — no path under
  `src/app/events`, `src/app/e`, or `src/app/api/events` is touched.

### Follow-up status

**F1 — retired.** V1/R10 pass. Auto-cash-mode is not Game Day-only: fundraiser
boards set `cashModeEnabled: true` unconditionally at `route.ts:446-448`, with
`cashPin: null` by design per v2 §6C. The `isCashHost && boardType === "game"`
branch at `route.ts:543` is the Game Day PIN path and says so in its own comment.
A cash host does not get an unusable fundraiser. The picker correctly stays
ungated, and §5's argument holds.

**F3 — live, and worse than anticipated.** `squares-fix-log-v2.docx` marks both
gates fixed on Feb 26; both entries are false. The log's failure mode is not
sloppy record-keeping — it recorded fixes that were real and then reverted the
same week. **It is a record of intent, not of verified state**, and every entry
needs verification against the repo rather than trust.

Two entries retired in this session:

| Entry | Verified |
|---|---|
| `api/host/payment-preference/route.ts` | Not a stub. Writes the preference, accepts only `"cash"`/`"stripe"`, 400s otherwise — which is why R11's state cannot be produced by any UI |
| `api/cron/release-expired/route.ts` | Built and scheduled `*/5 * * * *` in `vercel.json`. Running |

Remaining: the `host/boards/page.tsx` restoration claim, and the
`api/boards/route.ts` cash-host-status claim.

**F4 — new.** `release-expired` excludes fundraiser boards. Reported separately;
tracked here so it is not lost with this ticket.

**F5 — new. Platform owner bypass configuration is dead.**

- `PLATFORM_OWNER_ID` matches no current `Host.id`.
- Both owner checks compare against `host.id` — `api/boards/route.ts:483` and
  `host/boards/page.tsx:50`.
- No host can currently receive owner bypass behavior.

To decide:

- Whether the feature is still intended.
- If intended, **which identifier space is authoritative.** `hosts.id`,
  `hosts.supabase_user_id` and `auth.users.id` are three distinct values, and
  the constant is compared against the only one generated locally, which appears
  nowhere in Supabase. A value copied from Supabase would match
  `supabase_user_id` and never `id`. Restore deliberately.
- If obsolete, remove the constant and both dead comparisons.

**Treat any restoration as a billing/credit behavior change requiring its own
test plan.** The bypass has been unreachable for months; switching it back on
changes who is charged for board creation.

Predates this ticket and is independent of it. **`PLATFORM_OWNER_ID` is not to
be altered as part of this hotfix.**

### Housekeeping

Two copies of this document existed in Downloads with different hashes, and the
one matching the given filename was an 8,549-byte earlier draft lacking §4's
owner table, §5, V1, and the Commit 1/Commit 2 split. Delete stale drafts. A
ticket that instructs by section number fails badly against the wrong revision.

---

## 13. Rollback

**Five commits shipped as one release.** To take all of it back:

```bash
git revert --no-commit 6556241 03ae1b6
git revert --no-commit -m 1 100873a
git commit -m "revert: board-creation gate and route regression tests"
```

`-m 1` on the merge commit is required and is the parent that matters: it keeps
`main`'s history and undoes the branch's contribution. The two plain reverts must
come first — `6556241` (typecheck fix) and `03ae1b6` (route wiring test) sit on
top of the merge and depend on the code it introduced.

`b739d55`, the ticket import, is documentation and is **not** in the sequence.
Reverting the fix should not delete the record of why it was made.

**What reverting restores.** The pre-fix gate: `/host/boards/new` sends any host
whose `paymentPreference` is not exactly `"cash"` to `/host/stripe` when Stripe
is not charge-enabled, and `POST /api/boards` has no payment gate at all. That is
the state production ran in from 2026-02-26 to 2026-09-10, so it is survivable —
but null-preference hosts go back to being unable to onboard, which is the defect
this release exists to fix.

**What it does not touch.** `PLATFORM_OWNER_ID` and the dead owner bypass (F5)
are untouched by this release and unaffected by reverting it.

### Verification at release

Captured directly, no pipe:

```
TSC_EXIT=0
BUILD_EXIT=0
npm test  ->  307 tests, 306 pass, 0 fail, 1 skipped
```

The one skip is the documented integration-database signal — it means the
concurrency suite did not run, not that it failed.

### Where `npm test` actually runs — nowhere but a developer machine

**There is no CI in this repository.** No `.github/workflows`, no other CI
configuration, and Vercel's build command is `next build`, which does not run
tests. No `engines` field pins a Node version. Local Node is v22.19.0, where
`--experimental-test-module-mocks` is supported — verified by the tests running,
not by consulting a version table.

The consequence is worth stating rather than leaving implied: the route wiring
test does **not** run on every commit. It runs when someone types `npm test`.
Against `b771c68` — a correct fix deleted by a cleanup pass — the test is the
durable half, but the half that *invokes* it is still a careful person. Adding CI
would close that, and is not in this ticket.
