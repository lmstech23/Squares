// Registers "@/" resolution for the node:test runner, and nothing else.
//
// WHY THIS EXISTS ALONGSIDE test-env-first.mjs. That file also registers the
// alias loader, but it FAILS CLOSED without TEST_DATABASE_URL — deliberately,
// because the route tests it bootstraps talk to a real database and must never
// reach the ambient DATABASE_URL.
//
// A route test that mocks `@/lib/prisma` outright has no database to protect:
// the singleton in src/lib/prisma.ts never evaluates, so no PrismaClient is
// ever constructed and no connection string is ever read. Requiring a disposable
// Postgres for such a test would mean it could not run in the default `npm test`
// suite — which is exactly where a guard against a deleted gate needs to live.
//
// So this bootstrap does the one thing those tests do need, and none of what
// they do not.

import { register } from "node:module";

register("./test-alias-loader.mjs", import.meta.url);
