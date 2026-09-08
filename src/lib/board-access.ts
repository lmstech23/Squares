// Who may act on a board, and whether this particular action is theirs.
//
// board-collaborators-addendum.md v2.2 §2 and §3. Invariants 91, 93, 94, 95.
//
// ONE FUNCTION. EVERY HOST ROUTE THROUGH IT. `getHost()` answers "who is this?"
// and has always existed; there was no helper answering "may this person act on
// this board?", so that question was re-implemented at 28 call sites as a bare
// comparison of the board host column against the session host id. Adding a
// second role meant editing every one of them, and the failure mode of missing
// one is a route that silently stays
// owner-only — a manager who can do eight things of nine assumes the app is
// broken.
//
// THE LITERAL COMPARISON IS DELIBERATELY NOT WRITTEN OUT ABOVE. Commit 3's
// acceptance check is that grepping the source for it returns zero, and a
// comment quoting it would keep that check red forever — the one file that
// replaced the pattern being the reason nobody can prove it is gone.
//
// NOTHING CONSUMES THIS YET. It ships alone; the 27-file switch is the next
// commit. That ordering is what lets this be reviewed as authorization logic
// rather than as a diff touching every route in the application.
//
// AUTHORIZATION IS THE COLLABORATOR ROW, NEVER `Board.hostId` — invariant 91.
// `Board.hostId` remains the record of who created the board and whose Stripe
// account money settles to. It stops being an answer to "may they act". This
// file never reads it, and that is asserted by a test rather than by intent.

import { getHost } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

/**
 * Every capability in the model — collaborators §2.
 *
 * A UNION TYPE, so an unknown capability is a compile error at the call site
 * rather than a runtime decision. The runtime check below exists anyway, for
 * the paths types do not cover: a value arriving from a request body, a JSON
 * config, or a caller that cast.
 */
export const CAPABILITIES = [
  // Board and reporting
  "board.view",
  "contributors.view",
  "payments.view",
  "reporting.view",
  "board.edit",
  "board.close",
  "board.dismiss",
  "board.delete",
  "terms.set",
  "payout.configure",
  // Money
  "cash.confirm",
  "cash.record",
  "cash.release",
  "cash.void",
  // Event: admission and volunteers
  "attendee.manage",
  "volunteer.view",
  "volunteer.manage",
  "staff.manage",
  // Game Day outcome
  "scores.enter",
  "winner.resend",
  "winner.notify",
  "draw.run",
  // Delegation
  "collaborators.manage",
  "ownership.transfer",
] as const;

export type Capability = (typeof CAPABILITIES)[number];
export type BoardRole = "OWNER" | "MANAGER";

/**
 * THE MAPPING, IN EXACTLY ONE PLACE — invariant 95.
 *
 * Capabilities are checked, never roles. No route asks `role === 'MANAGER'`;
 * it asks for the capability it needs, and a third role later becomes a key in
 * this object rather than a search through the codebase.
 *
 * OWNER HOLDS EVERYTHING, expressed as the full list rather than as a
 * short-circuit. `role === 'OWNER' && return true` would make the owner's
 * capability set unreadable and would silently grant any capability added
 * later — including one deliberately withheld from owners, which ownership
 * transfer will eventually need.
 *
 * MANAGER's list is the addendum's table, and the omissions are the point:
 * close, draw, notify a winner, dismiss, delete, set terms, configure payout,
 * manage collaborators, transfer ownership — invariant 106 as amended by v2.2.
 */
const ROLE_CAPABILITIES: Record<BoardRole, ReadonlySet<Capability>> = {
  OWNER: new Set(CAPABILITIES),
  MANAGER: new Set<Capability>([
    "board.view",
    "contributors.view",
    "payments.view",
    "reporting.view",
    "board.edit",
    "cash.confirm",
    "cash.record",
    "cash.release",
    "cash.void",
    "attendee.manage",
    "volunteer.view",
    "volunteer.manage",
    "staff.manage",
    "scores.enter",
    "winner.resend",
  ]),
};

/** Refuses a capability that is not in the model. Fails closed. */
export function isCapability(value: unknown): value is Capability {
  return (
    typeof value === "string" &&
    (CAPABILITIES as readonly string[]).includes(value)
  );
}

/** Does this role hold this capability? The only place the map is consulted. */
export function roleHas(role: BoardRole, capability: Capability): boolean {
  return ROLE_CAPABILITIES[role].has(capability);
}

export type AccessDenial =
  /** No session. The caller redirects or returns 401. */
  | { ok: false; status: 401; error: string }
  /**
   * No live grant, OR the board does not exist. ONE OUTCOME, DELIBERATELY —
   * invariant 94. A 403 would confirm the board exists to somebody who should
   * not know that, and distinguishing "no board" from "no grant" is exactly the
   * distinction an enumeration attack is looking for.
   */
  | { ok: false; status: 404; error: string }
  /**
   * A live grant that does not carry this capability. A REAL 403: the person
   * legitimately sees this board and is being told this specific action is not
   * theirs. Telling them 404 here would be a lie about a board they can see.
   */
  | { ok: false; status: 403; error: string }
  /**
   * Something the model says cannot happen: an unknown capability, or more than
   * one live grant where a partial unique index permits one. FAIL CLOSED —
   * never resolve it by picking a row or guessing a default.
   */
  | { ok: false; status: 500; error: string };

export interface AccessGrant {
  ok: true;
  hostId: string;
  boardId: string;
  role: BoardRole;
}

export type AccessResult = AccessGrant | AccessDenial;

const NOT_FOUND = "Board not found.";

/**
 * May the signed-in host perform `capability` on `boardId`?
 *
 * READ LIVE, EVERY TIME — invariant 93. No cache, no memo, no role in a token
 * or a session. That single property is what makes revocation take effect on
 * the next request rather than at the next login, and it is the thing most
 * likely to be optimised away by someone counting database round-trips. If this
 * ever grows a cache, revocation silently stops working and nothing fails.
 *
 * Returns a discriminated result rather than throwing, so a route returns
 * `NextResponse.json({ error }, { status })` and a page calls `notFound()`.
 * Throwing would make the 404-not-403 rule depend on every caller's catch.
 */
export async function requireBoardAccess(
  boardId: string,
  capability: Capability
): Promise<AccessResult> {
  // FAIL CLOSED ON AN UNKNOWN CAPABILITY, before any query. Not owner-only, not
  // manager-capable — both are guesses, and one of them grants access. A
  // capability that is not in the model is a programming error, and the only
  // safe answer is that nobody has it.
  if (!isCapability(capability)) {
    console.error(`requireBoardAccess: unknown capability ${String(capability)}`);
    return { ok: false, status: 500, error: "Something went wrong." };
  }

  // `getHost()` DOES NOT RETURN NULL TODAY — it calls `redirect("/login")`, which
  // throws NEXT_REDIRECT. So this arm is unreachable as written, and it is kept
  // rather than deleted for two reasons: the addendum specifies "no session ->
  // redirect OR 401", and every existing host route already carries the same
  // dead `if (!host) return 401`. Deleting it here while 21 routes keep theirs
  // would make this file the odd one out and hide the fact from whoever changes
  // getHost later.
  //
  // NOTE FOR THE SWITCH: an unauthenticated API call is therefore REDIRECTED,
  // not answered 401 — pre-existing behaviour, not introduced here, and out of
  // scope for this commit.
  const host = await getHost();
  if (!host) return { ok: false, status: 401, error: "Unauthorized" };

  // THE ONLY AUTHORIZATION READ. Scoped to live grants: `revoked` is excluded
  // here rather than filtered afterwards, so a revoked row is indistinguishable
  // from no row at all — invariants 107 and 109.
  //
  // `invited` is excluded too. An invitation is not an authorization
  // (invariant 96); the row exists so acceptance has something to update, and
  // treating it as access would make the link itself the credential.
  //
  // findMany, not findFirst. The partial unique index permits exactly one live
  // grant per (board, host) — so asking for many and refusing two is how this
  // NOTICES the index being absent, rather than quietly taking whichever row
  // the planner returned first.
  const grants = await prisma.boardCollaborator.findMany({
    where: { boardId, hostId: host.id, status: "active" },
    select: { role: true },
  });

  if (grants.length === 0) {
    // NO GRANT AND NO SUCH BOARD ARE THE SAME ANSWER. There is deliberately no
    // board lookup here: querying one to "improve" the message would reintroduce
    // the distinction this rule exists to remove, and would read `Board.hostId`
    // into a file that must never authorize from it.
    return { ok: false, status: 404, error: NOT_FOUND };
  }

  if (grants.length > 1) {
    // UNREACHABLE WHILE `board_collaborators_live_grant_key` EXISTS, which is
    // why reaching it means the index does not. Fail closed: two live grants is
    // ambiguous authority, and picking one — the first, the highest role,
    // whichever — invents an answer the database refused to give.
    console.error(
      `requireBoardAccess: ${grants.length} live grants for host ${host.id} on board ${boardId} — ` +
        `board_collaborators_live_grant_key may be missing`
    );
    return { ok: false, status: 500, error: "Something went wrong." };
  }

  const role = grants[0].role as BoardRole;
  if (!roleHas(role, capability)) {
    return {
      ok: false,
      status: 403,
      error: "You do not have permission to do that on this board.",
    };
  }

  return { ok: true, hostId: host.id, boardId, role };
}
