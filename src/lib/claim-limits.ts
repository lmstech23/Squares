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
export const MAX_PER_CLAIM = 10;
