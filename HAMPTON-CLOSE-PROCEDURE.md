# Hampton close procedure — manual

Board: `hr6uevwx` — QT'13 Homecoming 2026
Campaign ends: **Friday, October 16, 2026, 11:59:59 PM America/New_York** — read from `Board.campaignEndsAt` on 2026-09-07
Event date: October 3, 2026 — **see "Unresolved configuration" below; the board record disagrees**
Close owner: **[TO BE ASSIGNED]**
Reconciliation should begin before the campaign end time, not after.

---

## Unresolved configuration — settle before the link goes out

Two fields on `hr6uevwx` do not agree with the event this procedure is written for. Both are read from the board record on 2026-09-07 and neither has been changed.

| | Stored on the board | Stated for this pilot |
|---|---|---|
| Event start | **Sat Oct 24, 2026, 10:00 AM ET** | October 3, 2026 |
| Campaign ends | Fri Oct 16, 2026, 11:59:59 PM ET | — |

If the event is genuinely **October 3**, then the campaign end of **October 16** falls *thirteen days after the event* and the board would keep selling admission to something that already happened. Both fields need correcting together.

If the event is genuinely **October 24**, the stored dates are internally consistent — campaign closes eight days ahead of the event — and it is this document's header that is wrong.

**Do not guess.** Whoever owns the pilot settles which date is real.

**There is a deadline on fixing it.** The event date locks at the first confirmed contribution. `hr6uevwx` currently has **zero** confirmed contributions, so it is still editable through the host edit panel. After the first ticket sells it is frozen and correcting it becomes a support exception.

Also unset on this board: `Event.name` and `Event.venue` are both `NULL`. Not blocking — the board name is used as a fallback — but the venue is what a parent looks for on the pass.

---

## Rule

Do not rely on scheduled close for this pilot. The close owner closes the campaign by hand.

Before finalizing:

1. Confirm every direct-payment reservation where payment was received.
2. Release every reservation where payment was not received.
3. Verify no unresolved reservations remain.
4. Complete the campaign close.

---

## Why manual

Daali cannot know whether money moved through an external rail — Zelle, Venmo, Cash App, PayPal — until the host reconciles it. A direct-payment entry reservation may already have been paid outside the platform. It is therefore never auto-released at scheduled close, unlike a reserved square, where a release provably means no money moved.

---

## What happens if the cron reaches the board first

Nothing is lost. Stated explicitly so nobody panics or works around it:

- Step 0 moves the board to `closing` and sales stop immediately (`close-board.ts:78-84`).
- Step 3 finds the unresolved reservations, returns `blockedBy`, and returns early (`:121-129`).
- `finalRaisedCents` and `status: closed` seal together in one update guarded on `finalRaisedCents: null` (`:158-161`). Neither happens while reservations are outstanding.
- `closeDueBoards` re-enters boards already in `closing` on every pass (`:187-194`), so reconciliation resumes with no host action needed.

The board sits safely in `closing` until someone resolves the list.

---

## The actual risk, and why manual close is still the rule

A scheduled close notifies nobody. `closeDueBoards` counts outcomes and returns them; failures go to `console.error` (`:196-213`). There is no host-facing notification channel in the codebase.

So the danger is not corruption. It is silence: a campaign that ended overnight, sitting in `closing`, with a host who has no idea anything is waiting on them.

A host-initiated close does tell them. It returns 409 with the blocking counts (`close-campaign/route.ts:57-77`) and the panel button reads "Finishing up" (`fundraiser-panel.tsx:304-334`). That is the entire reason this procedure is manual.

---

## Known gap, deliberately unbuilt

Host notification on scheduled close. Not built for this pilot. Revisit before any pilot with a host who is not actively watching the dashboard.

---

*Line references are to the code as of the commit that added this file. If a line number does not land where it says, trust the function name over the number.*
