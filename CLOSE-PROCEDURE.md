# Close procedure — boards selling direct-payment entry tickets

Applies to any pilot board that accepts direct-payment (Zelle, Venmo, Cash App, PayPal) entry ticket reservations.

Close owner: _______________________

Reconciliation begins before the campaign end time, not after. The campaign end date lives on the board record; this document does not restate it, because a procedure that carries a date goes stale and then gets trusted anyway.

---

## Rule

Do not rely on scheduled close. The close owner closes the campaign by hand.

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

Host notification on scheduled close. Not built for the pilot. Revisit before any pilot with a host who is not actively watching the dashboard.

---

*Line references are to the code as of the commit that added this file. If a line number does not land where it says, trust the function name over the number.*
