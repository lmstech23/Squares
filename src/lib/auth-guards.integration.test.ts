import { test, describe, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";

// The Host creation guard against a REAL database, Daali Slice 1 S1.2.
//
//   T17   an anonymous user gets no Host row and no credits.
//   T19b  an existing Host whose user has no display name, no profile and no
//         confirmed phone still resolves to the same Host, unchanged, and still
//         passes requireBoardAccess on their fundraiser.
//   and   a new non-anonymous user still gets a Host with the 2-credit column
//         default.
//
// `@/lib/prisma` is mocked to a client built from TEST_DATABASE_URL and nothing
// else, so this can never reach the ambient DATABASE_URL. Run it with
//   TEST_DATABASE_URL=postgresql://postgres:daali@localhost:55432/daali_test
// after `npm run test:db:up`.

const url = process.env.TEST_DATABASE_URL;
const prisma = url ? new PrismaClient({ datasources: { db: { url } } }) : null;

let currentUser: { id: string; is_anonymous?: boolean; email?: string; phone_confirmed_at?: string } | null = null;

if (url) {
  mock.module("@/lib/prisma", { namedExports: { prisma } });
  mock.module("@/lib/supabase/server", {
    namedExports: {
      createClient: async () => ({
        auth: { getUser: async () => ({ data: { user: currentUser } }) },
      }),
    },
  });
}

const auth = url ? await import("./auth.ts") : ({} as never);
const access = url ? await import("./board-access.ts") : ({} as never);

describe(
  "Host creation guard (integration)",
  { skip: !url && "TEST_DATABASE_URL not set" },
  () => {
    const db = prisma!;
    const userIds: string[] = [];
    let legacyHostId = "";
    let legacyUser = "";
    let boardId = "";

    const newUser = (tag: string) => {
      const id = `guard-${tag}-${randomUUID()}`;
      userIds.push(id);
      return id;
    };

    before(async () => {
      legacyUser = newUser("legacy");
      const h = await db.host.create({
        data: { supabaseUserId: legacyUser, email: `${legacyUser}@example.com`, name: null, boardCredits: 5 },
      });
      legacyHostId = h.id;
      const b = await db.board.create({
        data: {
          hostId: legacyHostId,
          gameName: "Guard Test",
          slug: "grd-" + randomUUID().slice(0, 8),
          boardType: "fundraiser",
          squarePrice: 5000,
          totalSquares: 0,
          timezone: "America/New_York",
          acceptedPaymentMethods: ["zelle"],
          hostZelle: "host@example.com",
        },
      });
      boardId = b.boardId;
      // Authority is the grant, not Board.hostId — board creation writes this.
      await db.boardCollaborator.create({
        data: { boardId, hostId: legacyHostId, role: "OWNER", status: "active", acceptedAt: new Date() },
      });
    });

    after(async () => {
      if (boardId) {
        await db.boardCollaborator.deleteMany({ where: { boardId } });
        await db.board.deleteMany({ where: { boardId } });
      }
      await db.host.deleteMany({ where: { supabaseUserId: { in: userIds } } });
      await db.$disconnect();
    });

    test("T17: an anonymous user gets no Host row and no credits", async () => {
      const id = newUser("anon");
      currentUser = { id, is_anonymous: true };
      assert.equal(await auth.getHostOrNull(), null);
      assert.equal(await db.host.count({ where: { supabaseUserId: id } }), 0);
      // And through the API-facing surface: 401, still nothing written.
      const r = await access.requireBoardAccess(boardId, "board.view");
      assert.equal(r.ok, false);
      assert.equal(await db.host.count({ where: { supabaseUserId: id } }), 0);
    });

    test("a new non-anonymous user still gets a Host with the 2-credit default", async () => {
      const id = newUser("new");
      currentUser = { id, email: `${id}@example.com` };
      const host = await auth.getHostOrNull();
      assert.ok(host);
      assert.equal(host.supabaseUserId, id);
      assert.equal(host.boardCredits, 2);
      assert.equal(await db.host.count({ where: { supabaseUserId: id } }), 1);
    });

    test("T19b: an existing Host with no name, profile or phone is unchanged and still manages their fundraiser", async () => {
      const before = await db.host.findUniqueOrThrow({ where: { id: legacyHostId } });
      assert.equal(await db.organizerProfile.count({ where: { userId: legacyUser } }), 0);

      currentUser = { id: legacyUser, email: `${legacyUser}@example.com` }; // no phone_confirmed_at
      const host = await auth.getHostOrNull();
      assert.equal(host?.id, legacyHostId);

      const r = await access.requireBoardAccess(boardId, "board.edit");
      assert.equal(r.ok, true);

      const afterRow = await db.host.findUniqueOrThrow({ where: { id: legacyHostId } });
      assert.deepEqual(afterRow, before, "the Host row is not rewritten");
    });
  }
);
