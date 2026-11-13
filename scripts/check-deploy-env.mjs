// Build-time deploy-environment guard (preview-environment-isolation.md §2.2).
// Runs before `next build`. Production and local builds: prints one line, exits 0.
// A non-production Vercel build configured with production resources: exits 1, so
// the deployment never goes live. Never prints a variable's value.

import { checkDeployEnv, ProductionResourceError } from "../src/lib/deploy-env-guard.mjs";

const r = checkDeployEnv(process.env);
if (!r.enforced) {
  console.log(`deploy-env-guard: ${r.context} — not enforced`);
  process.exit(0);
}
if (r.violations.length > 0) {
  console.error(new ProductionResourceError(r.context, r.violations).message);
  process.exit(1);
}
console.log(`deploy-env-guard: ${r.context} — no production resources configured`);
