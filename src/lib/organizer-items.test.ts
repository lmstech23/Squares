import { test, describe, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Your Daali's read model, Daali Slice 1 S1.6 (Auth spec, "Your Daali and the
// organizer-item read model"). NO DATABASE: `@/lib/prisma` is mocked, and the
// mock allows exactly one call — board.findMany — so a provider that wrote, or
// touched any other table, would fail here. The real-database version is
// home.local.test.ts.

type Row = {
  boardId: string;
  gameName: string;
  slug: string;
  status: string;
  createdAt: Date;
  host: { supabaseUserId: string | null };
};

let rows: Row[] = [];
let calls: { op: string; arg: unknown }[] = [];

const prismaMock = new Proxy(
  {},
  {
    get(_t, model: string | symbol) {
      if (typeof model !== "string" || model === "then") return undefined;
      return new Proxy(
        {},
        {
          get(_u, method: string | symbol) {
            if (typeof method !== "string" || method === "then") return undefined;
            return async (arg: unknown) => {
              calls.push({ op: `${model}.${method}`, arg });
              if (model === "board" && method === "findMany") return rows;
              throw new Error(`read model touched prisma.${model}.${method}`);
            };
          },
        }
      );
    },
  }
);
mock.module("@/lib/prisma", { namedExports: { prisma: prismaMock } });

const { projectLegacyFundraiser, legacyFundraiserProvider, listOrganizerItems } = await import("./organizer-items.ts");

const ME = "user-me";
const row = (boardId: string, status: string, created: string, owner: string | null = ME): Row => ({
  boardId,
  gameName: `Title ${boardId}`,
  slug: `slug-${boardId}`,
  status,
  createdAt: new Date(created),
  host: { supabaseUserId: owner },
});

beforeEach(() => {
  rows = [];
  calls = [];
});

describe("projectLegacyFundraiser — the spec's table", () => {
  const base = { boardId: "b1", gameName: "Spring Book Drive", slug: "spring", createdAt: new Date("2026-10-01T00:00:00Z"), ownerUserId: ME };

  test("status: open → LIVE; closing, closed → CLOSED; pending_payment → DRAFT", () => {
    const status = (s: string) => {
      const p = projectLegacyFundraiser({ ...base, status: s }, ME);
      return "item" in p ? p.item.status : p.omit;
    };
    assert.equal(status("open"), "LIVE");
    assert.equal(status("closing"), "CLOSED");
    assert.equal(status("closed"), "CLOSED");
    assert.equal(status("pending_payment"), "DRAFT");
  });

  test("expired is not listed; an unknown status is omitted, never guessed", () => {
    assert.deepEqual(projectLegacyFundraiser({ ...base, status: "expired" }, ME), { omit: "expired" });
    assert.deepEqual(projectLegacyFundraiser({ ...base, status: "archived" }, ME), { omit: "unknown-status", status: "archived" });
  });

  test("every field", () => {
    const p = projectLegacyFundraiser({ ...base, status: "open" }, ME);
    assert.ok("item" in p);
    assert.deepEqual(p.item, {
      id: "fundraiser:legacy:b1",
      type: "FUNDRAISER",
      title: "Spring Book Drive",
      status: "LIVE",
      role: "OWNER",
      publicUrl: "/board/spring",
      manageUrl: "/host/boards/b1",
      createdAt: base.createdAt,
      updatedAt: base.createdAt, // boards has no updated_at (ruled Oct 11)
      source: { kind: "LEGACY_BOARD", id: "b1" },
    });
  });

  test("role: OWNER for the owner, COLLABORATOR for anyone else", () => {
    const p = projectLegacyFundraiser({ ...base, status: "open", ownerUserId: "someone-else" }, ME);
    assert.ok("item" in p && p.item.role === "COLLABORATOR");
  });
});

describe("legacyFundraiserProvider and listOrganizerItems", () => {
  test("asks only for fundraiser Boards the user owns or helps run with an active grant", async () => {
    await legacyFundraiserProvider(ME);
    assert.deepEqual(calls.map((c) => c.op), ["board.findMany"]);
    const { where } = calls[0].arg as { where: Record<string, unknown> };
    assert.deepEqual(where, {
      boardType: "fundraiser",
      OR: [
        { host: { supabaseUserId: ME } },
        { collaborators: { some: { status: "active", host: { supabaseUserId: ME } } } },
      ],
    });
  });

  test("drops expired and unknown statuses; newest first; reads only", async () => {
    rows = [
      row("old", "open", "2026-01-01T00:00:00Z"),
      row("exp", "expired", "2026-09-01T00:00:00Z"),
      row("new", "closed", "2026-10-01T00:00:00Z"),
      row("mid", "pending_payment", "2026-05-01T00:00:00Z", "other-owner"),
      row("odd", "archived", "2026-10-05T00:00:00Z"),
    ];
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...a: unknown[]) => void errors.push(a);
    try {
      const items = await listOrganizerItems(ME);
      assert.deepEqual(
        items.map((i) => [i.source.id, i.status, i.role]),
        [
          ["new", "CLOSED", "OWNER"],
          ["mid", "DRAFT", "COLLABORATOR"],
          ["old", "LIVE", "OWNER"],
        ]
      );
    } finally {
      console.error = original;
    }
    assert.equal(errors.length, 1, "the unknown status raises one error event");
    assert.ok(calls.every((c) => c.op === "board.findMany"));
  });
});

// "Your Daali components receive OrganizerItem[] and nothing else. They never
// import Board types, Prisma Board queries or Board status values."
describe("/home components never reach Board code", () => {
  const root = join(import.meta.dirname, "..");
  const homeDir = join(root, "app", "(daali)", "home");
  const files = [...readdirSync(homeDir).map((f) => join(homeDir, f)), join(root, "components", "daali", "OrganizerItemCard.tsx")];

  test("no Prisma client import, no Board query, no getHost, and the card takes the item type only", () => {
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      assert.doesNotMatch(src, /@prisma\/client/, f);
      assert.doesNotMatch(src, /prisma\.board/, f);
      assert.doesNotMatch(src, /getHost(OrNull)?\s*\(/, f);
    }
    const card = readFileSync(files[files.length - 1], "utf8");
    assert.match(card, /import type \{ OrganizerItem \} from "@\/lib\/organizer-items"/);
    assert.doesNotMatch(card, /@\/lib\/prisma/);
  });
});
