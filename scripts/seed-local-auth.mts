// Local auth fixtures for Daali Slice 1 S1.4 — LOCAL SUPABASE STACK ONLY.
//
//   node --env-file=.env.local --experimental-strip-types scripts/seed-local-auth.mts
//
// Shaped like production (19 users today: 9 with email, 10 phone-only, Boards
// linked by Supabase user id) but entirely fictional: example.com addresses
// and 555-01xx numbers, which are the fixed test-OTP numbers in
// supabase/config.toml. No real user data is copied, ever.
//
//   phone-1  phone only, Host with no name, a Game Day board, no profile
//   phone-2  phone only, Host with no name, a fundraiser, BACKFILL profile (no name)
//   phone-3  phone only, named Host, a fundraiser, BACKFILL profile with the name
//   email-1  email only, named Host, a fundraiser, BACKFILL profile with the name
//   email-2  email only, no Host, no profile
//   both-1   email and phone, no Host, no profile
//
// REFUSES ANY TARGET THAT IS NOT THIS MACHINE: the Supabase URL and the
// database host must both be loopback. Re-running replaces the fixtures (each
// is found by its email or phone and removed first, with its boards, grants,
// Host and profile); nothing else is touched.

import { createClient } from "@supabase/supabase-js";
import { PrismaClient } from "@prisma/client";

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

type Fixture = {
  key: string;
  email?: string;
  phone?: string;
  host?: { name: string | null; board: "game" | "fundraiser" };
  profile?: { displayName: string | null };
};

export const FIXTURES: Fixture[] = [
  { key: "phone-1", phone: "+15555550101", host: { name: null, board: "game" } },
  { key: "phone-2", phone: "+15555550102", host: { name: null, board: "fundraiser" }, profile: { displayName: null } },
  { key: "phone-3", phone: "+15555550103", host: { name: "Pat Morgan", board: "fundraiser" }, profile: { displayName: "Pat Morgan" } },
  { key: "email-1", email: "organizer.one@example.com", host: { name: "Erin Lee", board: "fundraiser" }, profile: { displayName: "Erin Lee" } },
  { key: "email-2", email: "no.name@example.com" },
  { key: "both-1", email: "both.methods@example.com", phone: "+15555550104" },
];

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
      const board = await db.board.create({
        data: {
          hostId: host.id,
          gameName: f.host.board === "game" ? `Fixture Game Day (${f.key})` : `Fixture Fundraiser (${f.key})`,
          slug: `fixture-${f.key}`,
          boardType: f.host.board,
          squarePrice: 2000,
          totalSquares: f.host.board === "game" ? 100 : 0,
          timezone: "America/New_York",
          acceptedPaymentMethods: ["zelle"],
          hostZelle: "fixture@example.com",
        },
      });
      await db.boardCollaborator.create({
        data: { boardId: board.boardId, hostId: host.id, role: "OWNER", status: "active", acceptedAt: new Date() },
      });
    }
    if (f.profile) {
      await db.organizerProfile.create({
        data: { userId, displayName: f.profile.displayName, createdVia: "BACKFILL" },
      });
    }
    console.log(`${f.key.padEnd(8)} ${userId}${f.host ? `  host+${f.host.board}` : ""}${f.profile ? "  profile" : ""}`);
  }
} finally {
  await db.$disconnect();
}
