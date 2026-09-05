// Runs BEFORE any test module is evaluated, via `node --import`.
//
// ORDER IS THE WHOLE POINT. src/lib/prisma.ts calls `new PrismaClient()` at
// module scope, and PrismaClient reads DATABASE_URL when it is CONSTRUCTED.
// Setting the variable inside a test file is too late: importing the route
// under test imports the singleton first, and the singleton has already
// resolved a connection string by then — the production one, if a .env put it
// there. This file exists so that cannot happen.
//
// FAILS CLOSED. Without TEST_DATABASE_URL it throws rather than letting the
// tests run against whatever DATABASE_URL happens to hold.

import { register } from "node:module";

const url = process.env.TEST_DATABASE_URL;
if (!url) {
  throw new Error(
    "TEST_DATABASE_URL is not set. Refusing to run route tests against the " +
      "ambient DATABASE_URL — start the disposable database with " +
      "`npm run test:db:up`."
  );
}

// The route handler and everything it imports now talk to the test database.
process.env.DATABASE_URL = url;
process.env.DIRECT_URL = url;

register("./test-alias-loader.mjs", import.meta.url);
