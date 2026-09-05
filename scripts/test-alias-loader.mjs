// Module resolution for the node:test runner — the "@/" tsconfig path.
//
// WHY THIS EXISTS. `node --experimental-strip-types --test` is the runner this
// repo uses (see package.json `test`). It resolves node_modules and relative
// specifiers, and nothing else: a tsconfig `paths` entry is a TypeScript
// compile-time fiction that node knows nothing about. Any module importing
// "@/lib/..." therefore cannot be loaded by a test AT ALL — not mocked badly,
// not partially: ERR_MODULE_NOT_FOUND before the first assertion runs.
//
// That is why every test in this repo until now covered either a pure function
// or a module that takes its Prisma client as a parameter. Route handlers, the
// place where the guards that decide whether to write rows actually live, were
// untestable for a reason that had nothing to do with the routes.
//
// TEST-ONLY. Nothing in the application imports this. Next resolves "@/" itself
// from tsconfig, and `next build` never sees this file.
//
// It also probes extensions for relative specifiers, because strip-types
// requires them and application source does not write them.

import { existsSync, statSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";

const SRC = path.join(process.cwd(), "src");
const EXTS = [".ts", ".tsx", ".mts", ".js", ".mjs"];

/** First existing file among `base` plus the usual extensions and /index. */
function probe(base) {
  const candidates = [base, ...EXTS.map((e) => base + e), ...EXTS.map((e) => path.join(base, "index" + e))];
  for (const c of candidates) {
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  return null;
}

export async function resolve(specifier, context, next) {
  if (specifier.startsWith("@/")) {
    const hit = probe(path.join(SRC, specifier.slice(2)));
    if (hit) return { url: pathToFileURL(hit).href, shortCircuit: true };
  }

  // `next/server` resolves for the Next bundler but not for bare node, which
  // asks for `next/server.js`. NextResponse is what the route returns, so the
  // handler cannot be imported at all without this.
  if (specifier.startsWith("next/") && !path.extname(specifier)) {
    try {
      return await next(specifier + ".js", context);
    } catch {
      // fall through to the normal resolution and its error
    }
  }

  if ((specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL) {
    const parent = path.dirname(fileURLToPath(context.parentURL));
    const resolved = path.resolve(parent, specifier);
    if (!existsSync(resolved) || statSync(resolved).isDirectory()) {
      const hit = probe(resolved);
      if (hit) return { url: pathToFileURL(hit).href, shortCircuit: true };
    }
  }

  return next(specifier, context);
}
