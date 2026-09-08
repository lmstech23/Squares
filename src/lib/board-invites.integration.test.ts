import { test, describe, before, after, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";
import { safeReturnPath } from "./login-return.ts";

// Manager invitations, against a REAL database.
//
// Almost everything here is about rows and races: an invite consumed exactly
// once, a partial unique index refusing a second grant, a bound invite refusing
// an identity it cannot verify. A mocked Prisma would prove the mock.
//
//   npm run test:db:up && npm run test:integration:invites

const url = process.env.TEST_DATABASE_URL;
const prisma = url ? new PrismaClient({ datasources: { db: { url } } }) : null;

// Swapped per test so one file can act as the owner, the manager, or a stranger.
// Registered before the routes are imported, or they bind the real client.
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

const mod = url ? await import("./board-invites.ts") : ({} as never);
const { acceptInvite, revokeCollaborator, hashInviteToken, generateInviteToken } = mod;

// THE REAL ROUTES, for the revocation slice. The library is already covered
// above; what these prove is that the surface an owner actually clicks reaches
// it, with the right capability and the right emails.
const collaboratorsRoute = url
  ? await import("../app/api/host/boards/[id]/collaborators/route.ts")
  : ({} as never);
const invitesRoute = url
  ? await import("../app/api/host/boards/[id]/invites/route.ts")
  : ({} as never);

describe(
  "board invites (integration)",
  { skip: !url && "TEST_DATABASE_URL not set" },
  () => {
    const db = prisma!;
    let ownerId = "";
    let reneeId = "";
    let strangerId = "";
    let boardId = "";
    const RENEE = "renee@example.com";
    const STRANGER = "someone.else@example.com";

    const supabaseIds = new Map<string, string>();

    async function makeHost(tag: string) {
      const supabaseUserId = `inv-${tag}-${randomUUID()}`;
      const h = await db.host.create({
        data: { supabaseUserId, email: `${tag}-${randomUUID()}@example.com` },
      });
      supabaseIds.set(h.id, supabaseUserId);
      return h.id;
    }

    /** Sign in as a fixture host, for the route-level tests. */
    const signInAs = (hostId: string | null) => {
      currentUserId = hostId ? supabaseIds.get(hostId)! : null;
    };

    const callRoute = async (
      fn: (r: Request, c: { params: Promise<{ id: string }> }) => Promise<Response>,
      body?: Record<string, unknown>
    ) => {
      const req = new Request("http://test/api", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const res = await fn(req, { params: Promise.resolve({ id: boardId }) });
      return { status: res.status, json: await res.json() };
    };

    /** An invitation as the create route writes one. Returns the RAW token. */
    async function invite(
      opts: { boundEmail?: string | null; expiresAt?: Date } = {}
    ) {
      const token = generateInviteToken();
      await db.boardInvite.create({
        data: {
          boardId,
          role: "MANAGER",
          tokenHash: hashInviteToken(token),
          boundEmail: opts.boundEmail ?? null,
          createdByHostId: ownerId,
          expiresAt: opts.expiresAt ?? new Date(Date.now() + 7 * 864e5),
        },
      });
      return token;
    }

    const accept = (token: string, hostId: string, verifiedEmail: string | null) =>
      db.$transaction((tx) =>
        acceptInvite(tx, { tokenHash: hashInviteToken(token), hostId, verifiedEmail })
      );

    const grantsFor = (hostId: string) =>
      db.boardCollaborator.findMany({ where: { boardId, hostId } });

    before(async () => {
      ownerId = await makeHost("owner");
      reneeId = await makeHost("renee");
      strangerId = await makeHost("stranger");
    });

    beforeEach(async () => {
      if (boardId) {
        await db.boardInvite.deleteMany({ where: { boardId } });
        await db.boardCollaborator.deleteMany({ where: { boardId } });
        await db.board.deleteMany({ where: { boardId } });
      }
      const b = await db.board.create({
        data: {
          hostId: ownerId,
          gameName: "Invite Test",
          slug: "inv-" + randomUUID().slice(0, 8),
          boardType: "fundraiser",
          squarePrice: 5000,
          totalSquares: 0,
          timezone: "America/New_York",
          acceptedPaymentMethods: ["zelle"],
          hostZelle: "host@example.com",
        },
      });
      boardId = b.boardId;
      await db.boardCollaborator.create({
        data: { boardId, hostId: ownerId, role: "OWNER", status: "active", acceptedAt: new Date() },
      });
    });

    after(async () => {
      if (boardId) {
        await db.boardInvite.deleteMany({ where: { boardId } });
        await db.boardCollaborator.deleteMany({ where: { boardId } });
        await db.board.deleteMany({ where: { boardId } });
      }
      await db.host.deleteMany({ where: { id: { in: [ownerId, reneeId, strangerId] } } });
      await db.$disconnect();
    });

    // ====================================================================
    // REVOCATION THROUGH THE REAL API, not the library directly.
    //
    // The library is covered above. What these prove is that the surface an
    // owner actually clicks reaches it: the right capability, the right emails
    // for invariant 119, and the guards that keep a board from losing its owner.
    // ====================================================================

    /** A manager on this board, invited at `email` and having accepted. */
    async function seatManager(hostId: string, email: string | null) {
      const token = await invite({ boundEmail: email });
      const r = await accept(token, hostId, email);
      assert.equal(r.ok, true, "fixture manager should have been seated");
      return db.boardCollaborator.findFirstOrThrow({
        where: { boardId, hostId, status: "active" },
      });
    }

    test("R1. an OWNER sees active managers, and not their own row", async () => {
      await seatManager(reneeId, RENEE);
      signInAs(ownerId);

      const r = await callRoute(collaboratorsRoute.GET);
      assert.equal(r.status, 200);
      assert.equal(r.json.collaborators.length, 1, "the manager, not the owner");
      assert.equal(r.json.collaborators[0].role, "MANAGER");
      assert.equal(r.json.collaborators[0].invitedAs, RENEE);
    });

    test("R2. revoking through the route ends access immediately", async () => {
      const grant = await seatManager(reneeId, RENEE);
      signInAs(ownerId);

      const r = await callRoute(collaboratorsRoute.DELETE, { collaboratorId: grant.id });
      assert.equal(r.status, 200);

      const after = await db.boardCollaborator.findUniqueOrThrow({ where: { id: grant.id } });
      assert.equal(after.status, "revoked");
      assert.ok(after.revokedAt);
      assert.equal(after.revokedByHostId, ownerId);
    });

    // HISTORY SURVIVES — invariant 108. The row is updated, never deleted.
    test("R3. the revoked row is preserved, not removed", async () => {
      const grant = await seatManager(reneeId, RENEE);
      signInAs(ownerId);
      await callRoute(collaboratorsRoute.DELETE, { collaboratorId: grant.id });

      const rows = await db.boardCollaborator.findMany({ where: { boardId, hostId: reneeId } });
      assert.equal(rows.length, 1, "still there");
      assert.equal(rows[0].id, grant.id, "the same row");
      assert.ok(rows[0].acceptedAt, "and it still records when they joined");
    });

    // INVARIANT 119 THROUGH THE ROUTE. The emails come from the invitation they
    // ACCEPTED, which is the only address this board has reason to believe is
    // theirs — never Host.email.
    test("R4. revoking cancels their unaccepted BOUND invitation, in one go", async () => {
      const grant = await seatManager(reneeId, RENEE);
      const stale = await invite({ boundEmail: RENEE });
      signInAs(ownerId);

      const r = await callRoute(collaboratorsRoute.DELETE, { collaboratorId: grant.id });
      assert.equal(r.status, 200);
      assert.equal(r.json.invitesRevoked, 1, "and the owner is told");

      const dead = await accept(stale, reneeId, RENEE);
      assert.equal(!dead.ok && dead.reason, "unusable", "cannot regain access");
    });

    // THE LIMIT, THROUGH THE ROUTE. A bearer link has no recipient identity, so
    // revocation cannot reach it, and no attempt is made to guess — §7.
    test("R5. an unrelated unbound bearer invite is untouched", async () => {
      const grant = await seatManager(reneeId, RENEE);
      const bearer = await invite();
      signInAs(ownerId);

      const r = await callRoute(collaboratorsRoute.DELETE, { collaboratorId: grant.id });
      assert.equal(r.json.invitesRevoked, 0);

      const still = await db.boardInvite.findFirstOrThrow({
        where: { boardId, boundEmail: null },
      });
      assert.equal(still.revokedAt, null, "the bearer link still works");
      const used = await accept(bearer, strangerId, STRANGER);
      assert.equal(used.ok, true);
    });

    // Another manager's bound invitation is not collateral damage.
    test("R6. only THEIR invitation is cancelled", async () => {
      const grant = await seatManager(reneeId, RENEE);
      const other = await invite({ boundEmail: STRANGER });
      signInAs(ownerId);

      await callRoute(collaboratorsRoute.DELETE, { collaboratorId: grant.id });

      const r = await accept(other, strangerId, STRANGER);
      assert.equal(r.ok, true, "the other invitation still works");
    });

    // A BOARD MUST NOT LOSE ITS OWNER. The partial unique index would accept a
    // second OWNER once the first went revoked, so this guard is the only thing
    // standing there.
    test("R7. the owner's own row cannot be revoked", async () => {
      signInAs(ownerId);
      const own = await db.boardCollaborator.findFirstOrThrow({
        where: { boardId, hostId: ownerId, role: "OWNER" },
      });
      const r = await callRoute(collaboratorsRoute.DELETE, { collaboratorId: own.id });
      assert.equal(r.status, 409);
      assert.match(r.json.error, /ownership transfer/i);

      const after = await db.boardCollaborator.findUniqueOrThrow({ where: { id: own.id } });
      assert.equal(after.status, "active");
    });

    // A MANAGER HOLDS NO `collaborators.manage` — invariant 106. She would
    // otherwise be able to remove the others and be revoked by nobody.
    test("R8. a MANAGER cannot list or revoke collaborators", async () => {
      const grant = await seatManager(reneeId, RENEE);
      signInAs(reneeId);

      const list = await callRoute(collaboratorsRoute.GET);
      assert.equal(list.status, 403);

      const del = await callRoute(collaboratorsRoute.DELETE, { collaboratorId: grant.id });
      assert.equal(del.status, 403);

      const after = await db.boardCollaborator.findUniqueOrThrow({ where: { id: grant.id } });
      assert.equal(after.status, "active", "nothing moved");
    });

    test("R9. a stranger gets 404, not 403", async () => {
      await seatManager(reneeId, RENEE);
      signInAs(strangerId);
      const r = await callRoute(collaboratorsRoute.GET);
      assert.equal(r.status, 404);
    });

    test("R10. revoking twice is refused the second time", async () => {
      const grant = await seatManager(reneeId, RENEE);
      signInAs(ownerId);
      assert.equal(
        (await callRoute(collaboratorsRoute.DELETE, { collaboratorId: grant.id })).status,
        200
      );
      const again = await callRoute(collaboratorsRoute.DELETE, { collaboratorId: grant.id });
      assert.equal(again.status, 409);
    });

    // The invite route no longer pre-checks for an existing manager. A
    // redundant invitation is ALLOWED to be created; the duplicate is refused
    // authoritatively at acceptance by the partial unique index.
    test("R11. inviting an existing manager is allowed, and blocked at acceptance", async () => {
      await seatManager(reneeId, RENEE);
      signInAs(ownerId);

      const created = await callRoute(invitesRoute.POST, { boundEmail: RENEE });
      assert.equal(created.status, 200, "the invitation is created, not refused");

      const token = created.json.url.split("/invite/")[1];
      const r = await accept(token, reneeId, RENEE);
      assert.equal(!r.ok && r.reason, "already-collaborator");
      assert.equal((await grantsFor(reneeId)).length, 1, "still one grant");
    });

    // ---- the milestone ------------------------------------------------------

    test("a valid invitation is accepted and creates ONE active MANAGER grant", async () => {
      const token = await invite({ boundEmail: RENEE });
      const r = await accept(token, reneeId, RENEE);
      assert.equal(r.ok, true);
      assert.equal(r.ok && r.boardId, boardId);

      const grants = await grantsFor(reneeId);
      assert.equal(grants.length, 1);
      assert.equal(grants[0].role, "MANAGER");
      assert.equal(grants[0].status, "active");
      assert.ok(grants[0].acceptedAt);
      assert.equal(grants[0].invitedByHostId, null, "the grant records no inviter; the invite does");
    });

    test("acceptance stamps the invite with who accepted it", async () => {
      const token = await invite();
      await accept(token, reneeId, RENEE);
      const inv = await db.boardInvite.findFirstOrThrow({ where: { boardId } });
      assert.ok(inv.acceptedAt);
      assert.equal(inv.acceptedByHostId, reneeId);
    });

    // ATOMIC. If the grant cannot be created the acceptance must roll back, or
    // an invite is spent for nothing and the recipient is stuck.
    test("a failed grant rolls the acceptance back — the invite stays usable", async () => {
      // Renee already manages this board, so the insert violates the index.
      await db.boardCollaborator.create({
        data: { boardId, hostId: reneeId, role: "MANAGER", status: "active", acceptedAt: new Date() },
      });
      const token = await invite({ boundEmail: RENEE });

      await assert.rejects(
        () =>
          db.$transaction(async (tx) => {
            const r = await acceptInvite(tx, {
              tokenHash: hashInviteToken(token),
              hostId: reneeId,
              verifiedEmail: RENEE,
            });
            if (!r.ok) throw new Error("ROLLBACK:" + r.reason);
            return r;
          }),
        /ROLLBACK:already-collaborator/
      );

      const inv = await db.boardInvite.findFirstOrThrow({ where: { boardId } });
      assert.equal(inv.acceptedAt, null, "not burned");
      assert.equal((await grantsFor(reneeId)).length, 1, "still exactly one grant");
    });

    // ---- replay and concurrency ---------------------------------------------

    test("replay after acceptance is refused and changes nothing", async () => {
      const token = await invite();
      await accept(token, reneeId, RENEE);

      const again = await accept(token, strangerId, STRANGER);
      assert.equal(again.ok, false);
      assert.equal(!again.ok && again.reason, "unusable");
      assert.equal((await grantsFor(strangerId)).length, 0);
    });

    // THE RACE. Two people, one link, at the same instant. The conditional
    // claim is what makes exactly one win.
    test("concurrent double acceptance produces exactly one grant", async () => {
      const token = await invite();

      const [a, b] = await Promise.allSettled([
        accept(token, reneeId, RENEE),
        accept(token, strangerId, STRANGER),
      ]);

      const results = [a, b].map((s) =>
        s.status === "fulfilled" ? s.value : { ok: false, reason: "threw" as const }
      );
      const wins = results.filter((r) => r.ok);
      assert.equal(wins.length, 1, "exactly one acceptance succeeded");

      const all = await db.boardCollaborator.findMany({
        where: { boardId, hostId: { in: [reneeId, strangerId] } },
      });
      assert.equal(all.length, 1, "exactly one grant exists");
    });

    // ---- invariant 99: expired, revoked, accepted ---------------------------

    test("an expired invitation is refused", async () => {
      const token = await invite({ expiresAt: new Date(Date.now() - 1000) });
      const r = await accept(token, reneeId, RENEE);
      assert.equal(!r.ok && r.reason, "unusable");
      assert.equal((await grantsFor(reneeId)).length, 0);
    });

    test("a cancelled invitation is refused", async () => {
      const token = await invite();
      await db.boardInvite.updateMany({
        where: { boardId },
        data: { revokedAt: new Date(), revokedByHostId: ownerId },
      });
      const r = await accept(token, reneeId, RENEE);
      assert.equal(!r.ok && r.reason, "unusable");
      assert.equal((await grantsFor(reneeId)).length, 0);
    });

    test("an unknown token is refused", async () => {
      const r = await accept(generateInviteToken(), reneeId, RENEE);
      assert.equal(!r.ok && r.reason, "not-found");
    });

    // ---- invariant 98: bound identity ---------------------------------------

    test("a bound invitation refuses a different email", async () => {
      const token = await invite({ boundEmail: RENEE });
      const r = await accept(token, strangerId, STRANGER);
      assert.equal(!r.ok && r.reason, "wrong-identity");
      assert.equal(!r.ok && r.boundEmail, RENEE, "and names the invited address");
      assert.equal((await grantsFor(strangerId)).length, 0);
    });

    // PHONE OTP CANNOT SATISFY A BOUND INVITE. There is no verified email to
    // compare, and a bound field that is not enforced is worse than no binding.
    test("a bound invitation refuses a phone-authenticated session", async () => {
      const token = await invite({ boundEmail: RENEE });
      const r = await accept(token, reneeId, null);
      assert.equal(!r.ok && r.reason, "wrong-identity");
      assert.equal((await grantsFor(reneeId)).length, 0);
      const inv = await db.boardInvite.findFirstOrThrow({ where: { boardId } });
      assert.equal(inv.acceptedAt, null, "and the invite is not consumed");
    });

    test("binding is case- and whitespace-insensitive", async () => {
      const token = await invite({ boundEmail: RENEE });
      const r = await accept(token, reneeId, "  Renee@Example.COM  ");
      assert.equal(r.ok, true);
    });

    // FORWARDED UNBOUND LINK: whoever validly accepts first becomes the manager.
    // That is what leaving boundEmail null means — §5, invariant 96.
    test("an unbound link is a bearer invitation: the first acceptor wins", async () => {
      const token = await invite();
      const first = await accept(token, strangerId, STRANGER);
      assert.equal(first.ok, true);

      const second = await accept(token, reneeId, RENEE);
      assert.equal(!second.ok && second.reason, "unusable");
      assert.equal((await grantsFor(reneeId)).length, 0, "the intended recipient gets nothing");
    });

    // ---- existing grants -----------------------------------------------------

    test("someone who already manages the board cannot duplicate the grant", async () => {
      await db.boardCollaborator.create({
        data: { boardId, hostId: reneeId, role: "MANAGER", status: "active", acceptedAt: new Date() },
      });
      const token = await invite({ boundEmail: RENEE });
      const r = await accept(token, reneeId, RENEE);
      assert.equal(!r.ok && r.reason, "already-collaborator");
      assert.equal((await grantsFor(reneeId)).length, 1);
    });

    // ---- invariant 119 --------------------------------------------------------

    test("revoking a manager also cancels their unaccepted BOUND invitation", async () => {
      const token = await invite({ boundEmail: RENEE });
      await accept(token, reneeId, RENEE);
      // A second, still-unaccepted invitation for the same person.
      const stale = await invite({ boundEmail: RENEE });

      const grant = await db.boardCollaborator.findFirstOrThrow({
        where: { boardId, hostId: reneeId, status: "active" },
      });
      const out = await db.$transaction((tx) =>
        revokeCollaborator(tx, {
          collaboratorId: grant.id,
          boardId,
          revokedByHostId: ownerId,
          revokedEmails: [RENEE],
        })
      );
      assert.equal(out.revoked, true);
      assert.equal(out.invitesRevoked, 1);

      // THE POINT: the stale link cannot recreate the access just removed.
      const r = await accept(stale, reneeId, RENEE);
      assert.equal(!r.ok && r.reason, "unusable");
      const grants = await grantsFor(reneeId);
      assert.equal(grants.length, 1);
      assert.equal(grants[0].status, "revoked", "still revoked");
    });

    // THE LIMIT, ASSERTED SO IT IS NOT MISTAKEN FOR A BUG. An unbound invite has
    // no recipient identity, so revocation cannot reach it — §7, and the reason
    // the panel warns an owner who leaves the email blank.
    test("revoking does NOT cancel an unbound bearer link", async () => {
      const token = await invite({ boundEmail: RENEE });
      await accept(token, reneeId, RENEE);
      const bearer = await invite();

      const grant = await db.boardCollaborator.findFirstOrThrow({
        where: { boardId, hostId: reneeId, status: "active" },
      });
      const out = await db.$transaction((tx) =>
        revokeCollaborator(tx, {
          collaboratorId: grant.id,
          boardId,
          revokedByHostId: ownerId,
          revokedEmails: [RENEE],
        })
      );
      assert.equal(out.invitesRevoked, 0, "no bound invite matched");

      // It still works, for anyone — which is what a bearer link is.
      const r = await accept(bearer, strangerId, STRANGER);
      assert.equal(r.ok, true);
    });

    // Re-inviting after revocation is legitimate and creates a NEW row, so the
    // record that they managed the board from August to October survives.
    test("a fresh invitation after revocation works, as a new row", async () => {
      const first = await invite({ boundEmail: RENEE });
      await accept(first, reneeId, RENEE);
      const grant = await db.boardCollaborator.findFirstOrThrow({
        where: { boardId, hostId: reneeId, status: "active" },
      });
      await db.$transaction((tx) =>
        revokeCollaborator(tx, {
          collaboratorId: grant.id,
          boardId,
          revokedByHostId: ownerId,
          revokedEmails: [RENEE],
        })
      );

      const second = await invite({ boundEmail: RENEE });
      const r = await accept(second, reneeId, RENEE);
      assert.equal(r.ok, true);

      const grants = await grantsFor(reneeId);
      assert.equal(grants.length, 2, "a new row, not a revived one");
      assert.equal(grants.filter((g) => g.status === "active").length, 1);
      assert.equal(grants.filter((g) => g.status === "revoked").length, 1);
    });

    // ---- no Host is created, and no credits are minted ------------------------

    test("acceptance creates no Host row and mints no credits", async () => {
      const hostsBefore = await db.host.count();
      const creditRowsBefore = await db.creditTransaction.count();
      const renee = await db.host.findUniqueOrThrow({ where: { id: reneeId } });

      const token = await invite({ boundEmail: RENEE });
      await accept(token, reneeId, RENEE);

      assert.equal(await db.host.count(), hostsBefore, "no Host was created");
      assert.equal(
        await db.creditTransaction.count(),
        creditRowsBefore,
        "no credit ledger row"
      );
      const after = await db.host.findUniqueOrThrow({ where: { id: reneeId } });
      assert.equal(after.boardCredits, renee.boardCredits, "her balance did not move");
    });

    // ---- invariant 100 --------------------------------------------------------

    test("an OWNER invitation is unrepresentable", async () => {
      await assert.rejects(
        () =>
          db.boardInvite.create({
            data: {
              boardId,
              role: "OWNER",
              tokenHash: hashInviteToken(generateInviteToken()),
              createdByHostId: ownerId,
              expiresAt: new Date(Date.now() + 864e5),
            },
          }),
        /constraint/i,
        "board_invites_manager_only must refuse it"
      );
    });

    // ---- the token is hashed --------------------------------------------------

    test("the raw token never reaches the database", async () => {
      const token = await invite();
      const rows = await db.boardInvite.findMany({ where: { boardId } });
      assert.equal(rows.length, 1);
      assert.notEqual(rows[0].tokenHash, token);
      assert.equal(rows[0].tokenHash, hashInviteToken(token));
      assert.equal(JSON.stringify(rows[0]).includes(token), false, "not anywhere on the row");
    });
  }
);

// ============================================================================
// THE LOGIN RETURN PATH. Pure, so it lives here rather than needing a database.
//
// AN OPEN REDIRECT WOULD TURN A LOGIN LINK INTO A PHISHING TOOL, and the classic
// cause is a validator that asks "does it start with a slash".
// ============================================================================

describe("safeReturnPath", () => {
  const DEFAULT = "/host/boards";

  test("an invite path is allowed", () => {
    const p = "/invite/" + "a".repeat(43);
    assert.equal(safeReturnPath(p), p);
    assert.equal(safeReturnPath(encodeURIComponent(p)), p, "and survives one encoding");
  });

  test("absent or empty falls back", () => {
    assert.equal(safeReturnPath(null), DEFAULT);
    assert.equal(safeReturnPath(undefined), DEFAULT);
    assert.equal(safeReturnPath(""), DEFAULT);
  });

  // EVERY ONE OF THESE IS AN OPEN-REDIRECT ATTEMPT. `//evil.com` and `/\evil.com`
  // both start with a slash and both leave the site.
  test("open-redirect attempts are refused", () => {
    for (const attack of [
      "https://evil.com",
      "http://evil.com",
      "//evil.com",
      "/\\evil.com",
      "\\\\evil.com",
      "/invite/abc@evil.com",
      "javascript:alert(1)",
      "%2f%2fevil.com",
      "%68%74%74%70%73%3a%2f%2fevil.com",
      "%252f%252fevil.com",
      "/host/boards/../../evil",
      " //evil.com",
    ]) {
      assert.equal(safeReturnPath(attack), DEFAULT, `${attack} must not be followed`);
    }
  });

  // ALLOWLIST, NOT DENYLIST. Even a legitimate internal path that is not the
  // invite route falls back — a new destination is a deliberate line in the
  // validator, not a URL somebody discovered they could pass.
  test("other internal paths are not accepted either", () => {
    for (const p of ["/host/boards", "/board/abc123", "/host/boards/x/donations", "/"]) {
      assert.equal(safeReturnPath(p), DEFAULT);
    }
  });

  test("a malformed encoding falls back rather than throwing", () => {
    assert.equal(safeReturnPath("%E0%A4%A"), DEFAULT);
    assert.equal(safeReturnPath("%"), DEFAULT);
  });

  test("a token-shaped path with the wrong shape is refused", () => {
    assert.equal(safeReturnPath("/invite/short"), DEFAULT);
    assert.equal(safeReturnPath("/invite/" + "a".repeat(200)), DEFAULT);
    assert.equal(safeReturnPath("/invite/abc/../../host"), DEFAULT);
  });
});

void mock;
