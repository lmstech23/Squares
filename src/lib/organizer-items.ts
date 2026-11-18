// Your Daali's read model — Daali Slice 1, S1.6.
//
// Auth spec, "Your Daali and the organizer-item read model": /home lists what
// an organizer runs as common OrganizerItems, and gets them only from here.
// The layer hides where each item is stored. Today one provider projects
// fundraiser-type Boards as Fundraisers; later a standalone Fundraiser and
// Event provider replace it, and /home does not change.
//
// READ-ONLY. Selects only. Never writes, migrates or backfills, and never
// creates a Host: an organizer with no Host simply has no legacy items.
//
// `updatedAt` IS `createdAt`. The spec maps both from "the board's own
// timestamps", but boards has no updated_at column; ruled Oct 11 to use
// created_at for both, and to label the card's date "Created".

import { prisma } from "@/lib/prisma";

export type OrganizerItem = {
  /** Stable and namespaced, e.g. "fundraiser:legacy:<boardId>". */
  id: string;
  type: "FUNDRAISER" | "EVENT" | "RAFFLE";
  title: string;
  status: "DRAFT" | "LIVE" | "CLOSED";
  role: "OWNER" | "COLLABORATOR";
  publicUrl: string | null;
  manageUrl: string;
  createdAt: Date;
  updatedAt: Date;
  /** Internal only, never rendered. */
  source: { kind: "LEGACY_BOARD"; id: string };
};

export type OrganizerItemProvider = (userId: string) => Promise<OrganizerItem[]>;

/** The fields of a fundraiser Board the projection reads, and nothing more. */
export type LegacyFundraiserRow = {
  boardId: string;
  gameName: string;
  slug: string;
  status: string;
  createdAt: Date;
  ownerUserId: string | null;
};

/**
 * open → LIVE; closing, closed → CLOSED; pending_payment → DRAFT; expired →
 * not listed. Anything else is unknown: omitted, never guessed (spec, "Rules
 * for the bridge").
 */
const STATUS: Record<string, OrganizerItem["status"] | "OMIT"> = {
  open: "LIVE",
  closing: "CLOSED",
  closed: "CLOSED",
  pending_payment: "DRAFT",
  expired: "OMIT",
};

export type Projection = { item: OrganizerItem } | { omit: "expired" } | { omit: "unknown-status"; status: string };

/** One fundraiser Board as an OrganizerItem, for this user. PURE. */
export function projectLegacyFundraiser(row: LegacyFundraiserRow, userId: string): Projection {
  const mapped = STATUS[row.status];
  if (mapped === undefined) return { omit: "unknown-status", status: row.status };
  if (mapped === "OMIT") return { omit: "expired" };
  return {
    item: {
      id: `fundraiser:legacy:${row.boardId}`,
      type: "FUNDRAISER",
      title: row.gameName,
      status: mapped,
      role: row.ownerUserId === userId ? "OWNER" : "COLLABORATOR",
      publicUrl: `/board/${row.slug}`,
      manageUrl: `/host/boards/${row.boardId}`,
      createdAt: row.createdAt,
      updatedAt: row.createdAt,
      source: { kind: "LEGACY_BOARD", id: row.boardId },
    },
  };
}

/**
 * Fundraiser Boards the user owns (Host.supabaseUserId = userId) or helps run
 * as an accepted collaborator (an active grant). Game Day boards are never
 * projected.
 */
export const legacyFundraiserProvider: OrganizerItemProvider = async (userId) => {
  const boards = await prisma.board.findMany({
    where: {
      boardType: "fundraiser",
      OR: [
        { host: { supabaseUserId: userId } },
        { collaborators: { some: { status: "active", host: { supabaseUserId: userId } } } },
      ],
    },
    select: {
      boardId: true,
      gameName: true,
      slug: true,
      status: true,
      createdAt: true,
      host: { select: { supabaseUserId: true } },
    },
  });

  const items: OrganizerItem[] = [];
  for (const b of boards) {
    const projected = projectLegacyFundraiser(
      { boardId: b.boardId, gameName: b.gameName, slug: b.slug, status: b.status, createdAt: b.createdAt, ownerUserId: b.host.supabaseUserId },
      userId
    );
    if ("item" in projected) items.push(projected.item);
    else if (projected.omit === "unknown-status") {
      // No monitoring client exists in this repo; the server log is where
      // error events land today.
      console.error(`organizer-items: board ${b.boardId} has unknown status "${projected.status}"; omitted`);
    }
  }
  return items;
};

/** Every provider registered in this release. */
const PROVIDERS: OrganizerItemProvider[] = [legacyFundraiserProvider];

/** Everything the organizer runs, newest first. */
export async function listOrganizerItems(userId: string): Promise<OrganizerItem[]> {
  const lists = await Promise.all(PROVIDERS.map((p) => p(userId)));
  return lists.flat().sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
}
