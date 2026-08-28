# SYSTEM-FLOW.md — admission edits to port

**Do not overwrite `SYSTEM-FLOW.md`.** The repo's copy is dated May 4, 2026 and contains the entire double-grid feature — board type picker, `gridType`, `rowPairs` / `colPairs`, Standard versus Double win logic, and a rule inserted mid-list. Any copy circulating in project knowledge or a zip is dated Feb 26 and predates all of it. Replacing the file destroys working code by ignoring the documented flow, which is exactly what the check-before-pushing rule exists to prevent.

Apply these three edits by hand, onto the repo's current copy.

---

## Edit 1 — Quick Summary, new paragraph

Insert immediately before the existing `**Rules:**` line.

> **Fundraiser boards:** A second board type with its own flow, specified in `fundraiser-board-v2.md`. Money and drawing eligibility are governed by `fundraiser-money-state-machine.md`. Optional event admission is governed by `fundraiser-admission-addendum.md`.
>
> This document does not cover fundraiser flows, and the document-first rule is satisfied for fundraiser work by writing in v2 first. See v2 §17. Backfilling fundraiser flows into this document is a deferred ticket and blocks nothing. This document remains the authority for Game Day.

---

## Edit 2 — Board Management, Cash Reserve Panel

Append after the existing confirm/release bullets.

> **On a fundraiser board with an event attached, confirming does more than flip the square:**
>
> ```
> square              -> paid
> event supporter     -> active
> admission passes    -> minted (N = declaredCount)
> ```
>
> Two writes on a no-prize board. On a prize board, drawing eligibility also becomes active — but that is a *derived property* of the square reaching `paid`, not a separate row to write. There is no `Ticket` table. See money doc §5 and admission addendum §4.
>
> A developer who reads "confirm sets paid" and implements exactly that ships a gate that admits nobody. Game Day boards are unaffected.

---

## Edit 3 — Key Database Fields, new subsection

Append after the existing `Square` table.

> ### Fundraiser and admission tables
>
> Not duplicated here. `Board` and `Square` gain **no** admission columns, and there is no `Ticket` table.
>
> Fundraiser: see `fundraiser-board-v2.md` §3.
> Admission: `Event`, `EventSupporter`, `AdmissionGrant`, `AdmissionPass`, `CheckInLog`, `VolunteerAccess`, `AttendanceAccessToken` — see `fundraiser-admission-addendum.md` §2.

---

## Rule numbering

The repo's copy inserted a grid-type rule mid-list, so its document-first and check-before-pushing rules sit one position later than in older copies. **Cite these rules by name in every document.** Any numbered citation is stale by construction — v2 §17 and the admission docs have been corrected to use names.
