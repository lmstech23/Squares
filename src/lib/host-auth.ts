// Host authorization for board-scoped routes.
//
// LIFTED, NOT COPIED, from check-in-staff-handlers.ts, which had this as a
// private helper. S2's sign-up routes need exactly the same three checks, and a
// second implementation is a second thing to drift — the same reasoning that
// file already gives for sharing one handler between the check-in-staff route
// and its alias.
//
// Every host route in this codebase is board-scoped. An event-scoped resolver
// walking Event -> Board -> Host would be a second authorization concept for
// one feature; sign-up addendum §14 is corrected to match.

import { prisma } from "@/lib/prisma";
import { requireBoardAccess, type Capability } from "@/lib/board-access";

export type BoardEventAuth =
  | { error: string; status: number }
  | { hostId: string; boardId: string; eventId: string };

/**
 * Resolve the signed-in host, confirm they own this board, and return its event.
 *
 * **404, not 403, for a board the host does not own.** Distinguishing "does not
 * exist" from "exists but is not yours" tells an attacker which board ids are
 * real. Behaviour preserved exactly from the original: same order, same status
 * codes, same message strings.
 */
export async function authorizeBoardEvent(
  boardId: string,
  /**
   * The capability this caller needs. Defaults to `volunteer.manage`, which is
   * what all five existing callers do: sheets, slots, and check-in staff links.
   * A caller needing something else names it rather than inheriting the default.
   */
  capability: Capability = "volunteer.manage"
): Promise<BoardEventAuth> {
  // NO SECOND AUTHORIZATION PATH. This function used to compare
  // `board.hostId` against the session host itself, which made it a parallel
  // implementation of the question `requireBoardAccess` now owns — and the one
  // that would have been missed by a grep looking only at routes.
  //
  // It survives as a THIN ADAPTER, not as an authorizer: it delegates the
  // decision entirely and adds the one thing its callers need on top, the
  // event id. Deleting it would have meant editing five files to re-derive that
  // in each; keeping it means one call site to change if the capability ever
  // splits.
  const access = await requireBoardAccess(boardId, capability);
  if (!access.ok) return { error: access.error, status: access.status };

  // The event, and ONLY the event. No ownership is re-checked here; that
  // question was answered above and must have exactly one answer.
  const board = await prisma.board.findUnique({
    where: { boardId },
    select: { boardId: true, event: { select: { id: true } } },
  });

  if (!board) return { error: "Board not found.", status: 404 };
  if (!board.event) return { error: "This board has no event.", status: 400 };

  return { hostId: access.hostId, boardId: board.boardId, eventId: board.event.id };
}

