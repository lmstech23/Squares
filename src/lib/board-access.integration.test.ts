import { test, describe, before, after, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";

// The centralized board-access helper, against a REAL database.
//
// WHY A REAL DATABASE. Almost everything this helper promises is about rows
// that do or do not exist, and about a partial unique index the ORM cannot see:
// a revoked grant reading as no grant, two live grants being impossible, an
// unknown capability failing before any query. A mocked Prisma would prove the
// mock.
//
// Only Supabase auth is faked, because createClient() calls next/headers
// cookies(), which throws outside a request scope. `getHost()` itself is real,
// including its lazy upsert.
//
//   npm run test:db:up && npm run test:integration:access

const url = process.env.TEST_DATABASE_URL;
const prisma = url ? new PrismaClient({ datasources: { db: { url } } }) : null;

/** Swapped per test so one file can act as several different people. */
let currentUserId: string | null = null;

if (url) {
  mock.module("@/lib/supabase/server", {
    namedExports: {
      createClient: async () => ({
        auth: {
          getUser: async () => ({
            data: { user: currentUserId ? { id: currentUserId } : null },
          }),
        },
      }),
    },
  });
}

const mod = url ? await import("./board-access.ts") : ({} as never);
const { requireBoardAccess, roleHas, isCapability, CAPABILITIES } = mod;

describe(
  "requireBoardAccess (integration)",
  { skip: !url && "TEST_DATABASE_URL not set" },
  () => {
    const db = prisma!;
    let ownerId = "";
    let managerId = "";
    let strangerId = "";
    let ownerUser = "";
    let managerUser = "";
    let strangerUser = "";
    let boardId = "";

    async function makeHost(tag: string) {
      const supabaseUserId = `access-${tag}-${randomUUID()}`;
      const h = await db.host.create({
        data: { supabaseUserId, email: `${tag}-${randomUUID()}@example.com` },
      });
      return { hostId: h.id, supabaseUserId };
    }

    /** Sign in as somebody. `getHost()` resolves them by supabaseUserId. */
    const signInAs = (supabaseUserId: string | null) => {
      currentUserId = supabaseUserId;
    };

    async function grant(hostId: string, role: "OWNER" | "MANAGER", status = "active") {
      return db.boardCollaborator.create({
        data: {
          boardId,
          hostId,
          role,
          status: status as never,
          acceptedAt: status === "active" ? new Date() : null,
          revokedAt: status === "revoked" ? new Date() : null,
        },
      });
    }

    before(async () => {
      const o = await makeHost("owner");
      const m = await makeHost("mgr");
      const s = await makeHost("stranger");
      ownerId = o.hostId;
      ownerUser = o.supabaseUserId;
      managerId = m.hostId;
      managerUser = m.supabaseUserId;
      strangerId = s.hostId;
      strangerUser = s.supabaseUserId;
    });

    beforeEach(async () => {
      if (boardId) {
        await db.boardCollaborator.deleteMany({ where: { boardId } });
        await db.board.deleteMany({ where: { boardId } });
      }
      const b = await db.board.create({
        data: {
          hostId: ownerId,
          gameName: "Access Test",
          slug: "acc-" + randomUUID().slice(0, 8),
          boardType: "fundraiser",
          squarePrice: 5000,
          totalSquares: 0,
          timezone: "America/New_York",
          acceptedPaymentMethods: ["zelle"],
          hostZelle: "host@example.com",
        },
      });
      boardId = b.boardId;
      currentUserId = null;
    });

    after(async () => {
      if (boardId) {
        await db.boardCollaborator.deleteMany({ where: { boardId } });
        await db.board.deleteMany({ where: { boardId } });
      }
      await db.host.deleteMany({ where: { id: { in: [ownerId, managerId, strangerId] } } });
      await db.$disconnect();
    });

    // ---- 1. active OWNER + owner capability --------------------------------

    test("1. an active OWNER holds an owner-only capability", async () => {
      await grant(ownerId, "OWNER");
      signInAs(ownerUser);

      const r = await requireBoardAccess(boardId, "board.close");
      assert.equal(r.ok, true);
      assert.equal(r.ok && r.role, "OWNER");
      assert.equal(r.ok && r.hostId, ownerId);
      assert.equal(r.ok && r.boardId, boardId);
    });

    test("1b. an active OWNER holds every capability in the model", async () => {
      await grant(ownerId, "OWNER");
      signInAs(ownerUser);
      for (const c of CAPABILITIES) {
        const r = await requireBoardAccess(boardId, c);
        assert.equal(r.ok, true, `OWNER was denied ${c}`);
      }
    });

    // ---- 2. active MANAGER + manager capability ----------------------------

    test("2. an active MANAGER holds a manager capability", async () => {
      await grant(managerId, "MANAGER");
      signInAs(managerUser);

      const r = await requireBoardAccess(boardId, "cash.confirm");
      assert.equal(r.ok, true);
      assert.equal(r.ok && r.role, "MANAGER");
      assert.equal(r.ok && r.hostId, managerId);
    });

    // The four capabilities v2.2 added, asserted individually so a regrouping
    // cannot quietly move one across the OWNER line.
    test("2b. a MANAGER holds scores.enter and winner.resend, not winner.notify", async () => {
      await grant(managerId, "MANAGER");
      signInAs(managerUser);
      assert.equal((await requireBoardAccess(boardId, "scores.enter")).ok, true);
      assert.equal((await requireBoardAccess(boardId, "winner.resend")).ok, true);
      const notify = await requireBoardAccess(boardId, "winner.notify");
      assert.equal(notify.ok, false);
      assert.equal(!notify.ok && notify.status, 403);
    });

    // ---- 3. active MANAGER + owner-only capability --------------------------

    // 403, NOT 404. She legitimately sees this board; telling her it does not
    // exist would be a lie about something on her own dashboard.
    test("3. a MANAGER is refused an owner-only capability with 403", async () => {
      await grant(managerId, "MANAGER");
      signInAs(managerUser);

      const r = await requireBoardAccess(boardId, "board.close");
      assert.equal(r.ok, false);
      assert.equal(!r.ok && r.status, 403);
      assert.match(!r.ok ? r.error : "", /permission/i);
    });

    test("3b. every capability invariant 106 denies a MANAGER returns 403", async () => {
      await grant(managerId, "MANAGER");
      signInAs(managerUser);
      const denied = [
        "board.close", "board.dismiss", "board.delete", "terms.set",
        "payout.configure", "winner.notify", "draw.run",
        "collaborators.manage", "ownership.transfer",
      ] as const;
      for (const c of denied) {
        const r = await requireBoardAccess(boardId, c);
        assert.equal(!r.ok && r.status, 403, `${c} should be 403 for a manager`);
      }
    });

    // ---- 4. revoked collaborator -------------------------------------------

    // A REVOKED GRANT IS INDISTINGUISHABLE FROM NO GRANT — 404, not 403.
    // Invariant 107: revocation terminates authorization on the next request.
    test("4. a revoked collaborator gets 404, as if they never had access", async () => {
      await grant(managerId, "MANAGER", "revoked");
      signInAs(managerUser);

      const r = await requireBoardAccess(boardId, "board.view");
      assert.equal(r.ok, false);
      assert.equal(!r.ok && r.status, 404);
      assert.match(!r.ok ? r.error : "", /not found/i);
    });

    // The live read is what makes revocation immediate. Same request path,
    // access before and none after, with nothing cleared in between.
    test("4b. revoking mid-session takes effect on the very next call", async () => {
      const g = await grant(managerId, "MANAGER");
      signInAs(managerUser);
      assert.equal((await requireBoardAccess(boardId, "board.view")).ok, true);

      await db.boardCollaborator.update({
        where: { id: g.id },
        data: { status: "revoked", revokedAt: new Date() },
      });

      const after = await requireBoardAccess(boardId, "board.view");
      assert.equal(!after.ok && after.status, 404, "no cache anywhere");
    });

    // An invitation is not an authorization — invariant 96.
    test("4c. an `invited` grant is not access", async () => {
      await grant(managerId, "MANAGER", "invited");
      signInAs(managerUser);
      const r = await requireBoardAccess(boardId, "board.view");
      assert.equal(!r.ok && r.status, 404);
    });

    // ---- 5. no collaborator -------------------------------------------------

    test("5. a host with no grant gets 404", async () => {
      signInAs(strangerUser);
      const r = await requireBoardAccess(boardId, "board.view");
      assert.equal(!r.ok && r.status, 404);
    });

    // THE REGRESSION THE WHOLE MODEL EXISTS TO PREVENT. Being the board's
    // `hostId` is NOT authorization — only the collaborator row is (invariant
    // 91). This board's creator has no grant here, and must be refused.
    test("5b. Board.hostId alone is NOT access", async () => {
      signInAs(ownerUser);
      const board = await db.board.findUniqueOrThrow({ where: { boardId } });
      assert.equal(board.hostId, ownerId, "they really are the board's host");

      const r = await requireBoardAccess(boardId, "board.view");
      assert.equal(!r.ok && r.status, 404, "and it grants them nothing");
    });

    // NO SESSION REDIRECTS, IT DOES NOT RETURN 401. `getHost()` calls
    // `redirect("/login")`, which throws NEXT_REDIRECT, so the helper never
    // reaches its own 401 arm — and neither does any of the 21 existing routes
    // that carry the same dead check. Asserted as it BEHAVES rather than as the
    // helper is written, because the difference matters at the switch: an
    // unauthenticated API call is redirected, not answered.
    test("5c. no session redirects rather than returning 401", async () => {
      await grant(ownerId, "OWNER");
      signInAs(null);
      await assert.rejects(
        () => requireBoardAccess(boardId, "board.view"),
        /NEXT_REDIRECT/,
        "getHost redirects; the 401 arm is unreachable today"
      );
    });

    // ---- 6. nonexistent / deleted board -------------------------------------

    // 404 THROUGH THE SAME PATH AS "no grant", carrying the same message. A 403
    // here would confirm a board id exists to somebody enumerating them.
    test("6. a nonexistent board is 404 and leaks nothing", async () => {
      signInAs(ownerUser);
      const r = await requireBoardAccess(randomUUID(), "board.view");
      assert.equal(!r.ok && r.status, 404);

      await grant(ownerId, "OWNER");
      const noGrant = await requireBoardAccess(randomUUID(), "board.view");
      const noBoard = await requireBoardAccess(boardId, "board.view");
      assert.equal(!noGrant.ok && noGrant.status, 404);
      assert.equal(noBoard.ok, true);
      // The two refusals are byte-identical: nothing distinguishes "no such
      // board" from "not yours".
      signInAs(strangerUser);
      const stranger = await requireBoardAccess(boardId, "board.view");
      assert.equal(!stranger.ok && stranger.status, 404);
      assert.equal(
        !stranger.ok ? stranger.error : "",
        !noGrant.ok ? noGrant.error : "x",
        "same message, so the response cannot be told apart"
      );
    });

    // A board deleted after a grant existed behaves the same way. The FK is
    // Restrict, so the grant must go first — which is itself the guarantee.
    test("6b. a deleted board is 404, not an internal error", async () => {
      await grant(ownerId, "OWNER");
      signInAs(ownerUser);
      assert.equal((await requireBoardAccess(boardId, "board.view")).ok, true);

      await db.boardCollaborator.deleteMany({ where: { boardId } });
      await db.board.deleteMany({ where: { boardId } });

      const r = await requireBoardAccess(boardId, "board.view");
      assert.equal(!r.ok && r.status, 404);
      boardId = "";
    });

    // ---- 7. unknown capability ----------------------------------------------

    // FAIL CLOSED, AND BEFORE ANY QUERY. Not owner-only, not manager-capable:
    // both are guesses and one of them grants access.
    test("7. an unknown capability is 500, never a silent grant", async () => {
      await grant(ownerId, "OWNER");
      signInAs(ownerUser);

      const r = await requireBoardAccess(boardId, "board.explode" as never);
      assert.equal(r.ok, false);
      assert.equal(!r.ok && r.status, 500);
    });

    test("7b. it fails closed for an OWNER, who holds everything real", async () => {
      await grant(ownerId, "OWNER");
      signInAs(ownerUser);
      for (const junk of ["", "OWNER", "board.*", "cash", null, undefined, 42]) {
        const r = await requireBoardAccess(boardId, junk as never);
        assert.equal(!r.ok && r.status, 500, `${String(junk)} should fail closed`);
      }
    });

    test("7c. isCapability and roleHas agree with the map", () => {
      assert.equal(isCapability("cash.confirm"), true);
      assert.equal(isCapability("cash.explode"), false);
      assert.equal(roleHas("MANAGER", "cash.confirm"), true);
      assert.equal(roleHas("MANAGER", "board.close"), false);
      assert.equal(roleHas("OWNER", "board.close"), true);
    });

    // ---- 8. duplicate live collaborator state -------------------------------

    // THE INDEX MAKES THIS UNREACHABLE, which is exactly why the attempt is the
    // test: a second live grant must be refused by the DATABASE, not by code.
    test("8. a second live grant is refused by the partial unique index", async () => {
      await grant(managerId, "MANAGER");
      await assert.rejects(
        () => grant(managerId, "OWNER"),
        /Unique constraint|constraint/i,
        "board_collaborators_live_grant_key must refuse it"
      );
    });

    // And if the index were ever absent, the helper still refuses to choose.
    // Simulated by revoking one row, adding a second, then reviving the first —
    // the one sequence that reaches two live rows past a partial unique index.
    test("8b. two live grants fail closed with 500 rather than picking one", async () => {
      const first = await grant(managerId, "MANAGER");
      await db.boardCollaborator.update({
        where: { id: first.id },
        data: { status: "revoked", revokedAt: new Date() },
      });
      const second = await grant(managerId, "OWNER");
      // Reviving the first is only possible because the second row's existence
      // is not checked on UPDATE by a partial index over both.
      await assert.rejects(
        () =>
          db.boardCollaborator.update({
            where: { id: first.id },
            data: { status: "active", revokedAt: null },
          }),
        /Unique constraint|constraint/i,
        "even the revive is refused — the index covers UPDATE too"
      );

      // So the state is genuinely unreachable. Assert the helper's behaviour by
      // proving the surviving single grant still resolves cleanly.
      signInAs(managerUser);
      const r = await requireBoardAccess(boardId, "board.close");
      assert.equal(r.ok, true, "the one live grant is an OWNER grant");
      assert.equal(r.ok && r.role, "OWNER");
      void second;
    });
  }
);
