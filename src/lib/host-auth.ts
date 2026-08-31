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
import { getHost } from "@/lib/auth";

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
export async function authorizeBoardEvent(boardId: string): Promise<BoardEventAuth> {
  const host = await getHost();
  if (!host) return { error: "Unauthorized", status: 401 };

  const board = await prisma.board.findUnique({
    where: { boardId },
    select: { boardId: true, hostId: true, event: { select: { id: true } } },
  });

  if (!board || board.hostId !== host.id) {
    return { error: "Board not found.", status: 404 };
  }
  if (!board.event) {
    return { error: "This board has no event.", status: 400 };
  }
  return { hostId: host.id, boardId: board.boardId, eventId: board.event.id };
}
