// ============================================================
// scripts/seed-invite-codes.ts
//
// Run: npx tsx scripts/seed-invite-codes.ts
//
// Generates 10 invite codes for March Madness launch.
// Safe to run multiple times — skips existing codes.
// ============================================================

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const TOURNAMENT_EXPIRES = new Date("2026-04-08T00:00:00Z");

const CODES = [
  "DAALI-001",
  "DAALI-002",
  "DAALI-003",
  "DAALI-004",
  "DAALI-005",
  "DAALI-006",
  "DAALI-007",
  "DAALI-008",
  "DAALI-009",
  "DAALI-010",
];

async function main() {
  console.log("Seeding invite codes...\n");

  for (const code of CODES) {
    const existing = await prisma.inviteCode.findUnique({ where: { code } });

    if (existing) {
      const status = existing.claimedBy
        ? `CLAIMED by ${existing.email || "unknown"}`
        : "available";
      console.log(`  ${code} — already exists (${status})`);
      continue;
    }

    await prisma.inviteCode.create({
      data: {
        code,
        expiresAt: TOURNAMENT_EXPIRES,
      },
    });

    console.log(`  ${code} — created`);
  }

  // Summary
  const all = await prisma.inviteCode.findMany({ orderBy: { code: "asc" } });
  const claimed = all.filter((c) => c.claimedBy);
  const available = all.filter((c) => !c.claimedBy);

  console.log(`\n--- Summary ---`);
  console.log(`Total codes:     ${all.length}`);
  console.log(`Claimed:         ${claimed.length}`);
  console.log(`Available:       ${available.length}`);
  console.log(`Expires:         ${TOURNAMENT_EXPIRES.toISOString()}`);

  if (claimed.length > 0) {
    console.log(`\nClaimed codes:`);
    for (const c of claimed) {
      console.log(`  ${c.code} → ${c.email || "no email"} (${c.claimedAt?.toISOString()})`);
    }
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
