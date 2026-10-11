// Local auth fixtures for Daali Slice 1 — LOCAL SUPABASE STACK ONLY.
//
//   node --env-file=.env.local --experimental-strip-types scripts/seed-local-auth.mts
//
// Shaped like production (19 users today: 9 with email, 10 phone-only, Boards
// linked by Supabase user id) but entirely fictional: example.com addresses
// and 555-01xx numbers. The numbers people sign in with are the fixed test-OTP
// numbers in supabase/config.toml. No real user data is copied, ever.
//
//   phone-1   phone only, Host with no name, a Game Day board, no profile
//   phone-2   phone only, Host with no name, a fundraiser, BACKFILL profile (no name)
//   phone-3   phone only, named Host, a fundraiser, BACKFILL profile with the name
//   email-1   email only, named Host, a fundraiser, BACKFILL profile with the name
//   email-2   email only, no Host, no profile
//   both-1    email and phone, no Host, no profile
//   S1.6 — complete accounts (name, confirmed email, confirmed phone):
//   signup-1  a NEW Daali account: SIGNUP profile, no Host, no Boards
//   owner-1   owns fundraisers in every status (open, closing, closed,
//             pending_payment, expired) plus a Game Day board
//   collab-1  owns nothing; MANAGER on owner-1's open fundraiser
//   flag-1    legacy_boards_visible; owns a Game Day board and a fundraiser
//
// Collaborator grants across fixtures: phone-2 is MANAGER on email-1's
// fundraiser, phone-3 on phone-2's, collab-1 on owner-1's open fundraiser.
//
// Open Board-manager invites on owner-1's open fundraiser (S1.6, T17b), with
// FIXED, FICTIONAL tokens so local tests can open them:
//   /invite/fixture-invite-unbound-0000000001   unbound
//   /invite/fixture-invite-bound-00000000000002 bound to invitee.bound@example.com
//   /invite/fixture-invite-existing-000000003   unbound, for an existing account
//
// REFUSES ANY TARGET THAT IS NOT THIS MACHINE: the Supabase URL and the
// database host must both be loopback. Re-running replaces the fixtures (each
// is found by its email or phone and removed first, with its boards, invites,
// grants, Host and profile); nothing else is touched.

import { createClient } from "@supabase/supabase-js";
import { PrismaClient, type BoardStatus } from "@prisma/client";
import { hashInviteToken } from "../src/lib/board-invites.ts";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const dbUrl = process.env.DATABASE_URL ?? "";

const loopback = (u: string) => {
  try {
    return ["127.0.0.1", "localhost", "[::1]"].includes(new URL(u).hostname);
  } catch {
    return false;
  }
};
if (!loopback(supabaseUrl) || !loopback(dbUrl) || !serviceKey) {
  console.error("Refusing: NEXT_PUBLIC_SUPABASE_URL and DATABASE_URL must both be loopback (the local stack).");
  process.exit(2);
}

type FixtureBoard = {
  /** Slug suffix: the board's slug is `fixture-<key>` for the first board, `fixture-<key>-<slug>` after. */
  slug?: string;
  type: "game" | "fundraiser";
  title?: string;
  status?: BoardStatus;
};

type Fixture = {
  key: string;
  email?: string;
  phone?: string;
  host?: { name: string | null; boards: FixtureBoard[] };
  profile?: { displayName: string | null; createdVia?: "BACKFILL" | "SIGNUP"; legacyBoardsVisible?: boolean };
};

export const FIXTURES: Fixture[] = [
  { key: "phone-1", phone: "+15555550101", host: { name: null, boards: [{ type: "game" }] } },
  { key: "phone-2", phone: "+15555550102", host: { name: null, boards: [{ type: "fundraiser" }] }, profile: { displayName: null } },
  { key: "phone-3", phone: "+15555550103", host: { name: "Pat Morgan", boards: [{ type: "fundraiser" }] }, profile: { displayName: "Pat Morgan" } },
  { key: "email-1", email: "organizer.one@example.com", host: { name: "Erin Lee", boards: [{ type: "fundraiser" }] }, profile: { displayName: "Erin Lee" } },
  { key: "email-2", email: "no.name@example.com" },
  { key: "both-1", email: "both.methods@example.com", phone: "+15555550104" },
  {
    key: "signup-1",
    email: "new.signup@example.com",
    phone: "+15555550108",
    profile: { displayName: "Casey Rivers", createdVia: "SIGNUP" },
  },
  {
    key: "owner-1",
    email: "owner.many@example.com",
    phone: "+15555550109",
    host: {
      name: "Morgan Avery",
      boards: [
        { type: "fundraiser", title: "Spring Book Drive", status: "open" },
        { slug: "closing", type: "fundraiser", title: "Winter Coat Collection", status: "closing" },
        { slug: "closed", type: "fundraiser", title: "Fall Garden Fund", status: "closed" },
        { slug: "draft", type: "fundraiser", title: "Summer Camp Scholarships", status: "pending_payment" },
        { slug: "expired", type: "fundraiser", title: "Expired Drive", status: "expired" },
        { slug: "game", type: "game", title: "Morgan's Super Bowl Squares", status: "open" },
      ],
    },
    profile: { displayName: "Morgan Avery" },
  },
  { key: "collab-1", email: "helper.one@example.com", phone: "+15555550110", host: { name: "Riley Helper", boards: [] }, profile: { displayName: "Riley Helper" } },
  {
    key: "flag-1",
    email: "legacy.tester@example.com",
    phone: "+15555550111",
    host: {
      name: "Taylor Quinn",
      boards: [
        { type: "fundraiser", title: "Neighborhood Library Fund", status: "open" },
        { slug: "game", type: "game", title: "Taylor's Homecoming Squares", status: "open" },
      ],
    },
    profile: { displayName: "Taylor Quinn", legacyBoardsVisible: true },
  },
];

/** [manager fixture, board slug]: the manager gets an active MANAGER grant on that board. */
const MANAGER_GRANTS: [string, string][] = [
  ["phone-2", "fixture-email-1"],
  ["phone-3", "fixture-phone-2"],
  ["collab-1", "fixture-owner-1"],
];

/** Open invites on owner-1's open fundraiser. Tokens are fixed and fictional. */
const INVITES: { token: string; boundEmail: string | null }[] = [
  { token: "fixture-invite-unbound-0000000001", boundEmail: null },
  { token: "fixture-invite-bound-00000000000002", boundEmail: "invitee.bound@example.com" },
  { token: "fixture-invite-existing-000000003", boundEmail: null },
];

const fixture = (key: string): Fixture => FIXTURES.find((f) => f.key === key)!;
const slugFor = (f: Fixture, b: FixtureBoard) => (b.slug ? `fixture-${f.key}-${b.slug}` : `fixture-${f.key}`);

const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
const db = new PrismaClient({ datasources: { db: { url: dbUrl } } });

async function findUserId(f: Fixture): Promise<string | null> {
  const digits = f.phone?.replace(/^\+/, "") ?? null;
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT id::text AS id FROM auth.users
     WHERE (${f.email ?? null}::text IS NOT NULL AND lower(email) = lower(${f.email ?? null}))
        OR (${digits}::text IS NOT NULL AND phone = ${digits})`;
  return rows[0]?.id ?? null;
}

async function remove(userId: string) {
  const hosts = await db.host.findMany({ where: { supabaseUserId: userId }, select: { id: true } });
  for (const h of hosts) {
    const boards = await db.board.findMany({ where: { hostId: h.id }, select: { boardId: true } });
    const ids = boards.map((b) => b.boardId);
    await db.boardInvite.deleteMany({
      where: { OR: [{ boardId: { in: ids } }, { createdByHostId: h.id }, { acceptedByHostId: h.id }, { revokedByHostId: h.id }] },
    });
    await db.boardCollaborator.deleteMany({ where: { OR: [{ hostId: h.id }, { boardId: { in: ids } }] } });
    await db.board.deleteMany({ where: { boardId: { in: ids } } });
    await db.host.delete({ where: { id: h.id } });
  }
  await db.organizerProfile.deleteMany({ where: { userId } });
  const { error } = await admin.auth.admin.deleteUser(userId);
  if (error) throw error;
}

try {
  for (const f of FIXTURES) {
    const existing = await findUserId(f);
    if (existing) await remove(existing);

    const { data, error } = await admin.auth.admin.createUser({
      email: f.email,
      email_confirm: f.email ? true : undefined,
      phone: f.phone,
      phone_confirm: f.phone ? true : undefined,
    });
    if (error || !data.user) throw error ?? new Error(`createUser failed for ${f.key}`);
    const userId = data.user.id;

    if (f.host) {
      const host = await db.host.create({
        data: { supabaseUserId: userId, email: f.email ?? f.phone!.replace(/^\+/, ""), name: f.host.name },
      });
      for (const b of f.host.boards) {
        const board = await db.board.create({
          data: {
            hostId: host.id,
            gameName: b.title ?? (b.type === "game" ? `Fixture Game Day (${f.key})` : `Fixture Fundraiser (${f.key})`),
            slug: slugFor(f, b),
            boardType: b.type,
            status: b.status ?? "open",
            squarePrice: 2000,
            totalSquares: b.type === "game" ? 100 : 0,
            timezone: "America/New_York",
            acceptedPaymentMethods: ["zelle"],
            hostZelle: "fixture@example.com",
          },
        });
        await db.boardCollaborator.create({
          data: { boardId: board.boardId, hostId: host.id, role: "OWNER", status: "active", acceptedAt: new Date() },
        });
      }
    }
    if (f.profile) {
      await db.organizerProfile.create({
        data: {
          userId,
          displayName: f.profile.displayName,
          createdVia: f.profile.createdVia ?? "BACKFILL",
          legacyBoardsVisible: f.profile.legacyBoardsVisible ?? false,
        },
      });
    }
    const boards = f.host?.boards.map((b) => `${b.type}${b.status && b.status !== "open" ? `:${b.status}` : ""}`).join(",");
    console.log(`${f.key.padEnd(9)} ${userId}${f.host ? `  host[${boards}]` : ""}${f.profile ? `  profile:${f.profile.createdVia ?? "BACKFILL"}` : ""}`);
  }

  for (const [manager, slug] of MANAGER_GRANTS) {
    const host = await db.host.findFirstOrThrow({ where: { supabaseUserId: (await findUserId(fixture(manager)))! } });
    const board = await db.board.findUniqueOrThrow({ where: { slug } });
    await db.boardCollaborator.create({
      data: { boardId: board.boardId, hostId: host.id, role: "MANAGER", status: "active", acceptedAt: new Date() },
    });
    console.log(`${manager.padEnd(9)} MANAGER on ${slug}`);
  }

  const ownerHost = await db.host.findFirstOrThrow({ where: { supabaseUserId: (await findUserId(fixture("owner-1")))! } });
  const inviteBoard = await db.board.findUniqueOrThrow({ where: { slug: "fixture-owner-1" } });
  for (const inv of INVITES) {
    await db.boardInvite.deleteMany({ where: { tokenHash: hashInviteToken(inv.token) } });
    await db.boardInvite.create({
      data: {
        boardId: inviteBoard.boardId,
        role: "MANAGER",
        tokenHash: hashInviteToken(inv.token),
        boundEmail: inv.boundEmail,
        createdByHostId: ownerHost.id,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });
    console.log(`invite    /invite/${inv.token}${inv.boundEmail ? `  bound to ${inv.boundEmail}` : "  unbound"}`);
  }
} finally {
  await db.$disconnect();
}
