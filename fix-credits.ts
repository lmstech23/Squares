import { PrismaClient } from "@prisma/client";
const p = new PrismaClient();
async function main() {
  await p.$executeRawUnsafe("UPDATE hosts SET board_credits = 2 WHERE supabase_user_id = 'e53478bd-2cbf-4713-9d25-2c3badf3e95b'");
  console.log("Done — 2 credits granted");
  await p.$disconnect();
}
main();
