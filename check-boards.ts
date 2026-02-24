import { PrismaClient } from "@prisma/client";
const p = new PrismaClient();
async function main() {
  const boards = await p.$queryRawUnsafe("SELECT board_id, host_id, game_name, status, created_at FROM boards ORDER BY created_at");
  console.table(boards);
  await p.$disconnect();
}
main();
