// Per-transaction claim limit — money doc §12.
//
// PER TRANSACTION, NOT PER PERSON. There is no limit on how many squares
// someone may contribute overall: they can check out again. So the copy says
// "the most you can claim at once", never "limit reached", and the selector
// offers up to this many per checkout rather than describing a board rule.
//
// DELIBERATELY NOT `Board.maxSquaresPerPlayer`. That field is a Game Day
// per-player rule: `api/checkout/route.ts` enforces it only behind
// `!isFundraiser` (lines 270 and 374), it is hard-coded to 10 at creation
// (`api/boards/route.ts:420`), and no fundraiser form exposes it. Reading it in
// the fundraiser UI would honour a setting the fundraiser backend skips — a
// limit the contributor could exceed by checking out twice, presented as though
// the host had chosen it.
//
// "You can buy up to 10 in this checkout" is true.
// "This fundraiser limits you to 10 total" is not.
//
// Whether fundraiser boards should have a real per-supporter cap is an open
// product question — see PHASE-2-BACKLOG.md. Today the answer is accidentally
// "no", and nobody decided it.
//
// ============================================================================
// GAME DAY CHECKOUT ONLY. NOT A FUNDRAISER QUANTITY CEILING.
// ============================================================================
//
// Enforce this in ONE place: `api/checkout/route.ts`, behind `!isFundraiser`.
// Do not read it in a fundraiser UI, a fundraiser route, or `cash-reserve`.
//
// A FUNDRAISER'S ONLY CEILING IS INVENTORY. A contributor who wants 20 is the
// best thing that can happen to a campaign, and the claim sheet tells her so —
// "97 tickets are left". Capping her at 10 turns a donor away from giving
// money, on a screen that just promised she could.
//
// This was live. `checkout/route.ts` carried a hardcoded `squareIds.length > 10`
// ABOVE the line that computes `isFundraiser`, so it could not be scoped even in
// principle and rejected fundraiser checkouts of 11 or more with a 400. It went
// unnoticed because the claim sheet's preset buttons stopped at 10, so nobody
// could enter a number that reached it. Removing those presets uncapped the path
// into it, which is how it surfaced. Fixed 2026-09-03.
//
// Two consequences worth keeping in view:
//   - `cash-reserve` has never had this limit, so the same modal accepted 11 for
//     cash and refused it for card. Symmetry now means BOTH accept it.
//   - the limit is per TRANSACTION, so it never bounded a Game Day player's
//     total anyway; `Board.maxSquaresPerPlayer` is that rule, also `!isFundraiser`.
export const MAX_PER_CLAIM = 10;
