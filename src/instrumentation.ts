// Run-time deploy-environment guard (preview-environment-isolation.md §2.3).
//
// Next.js calls register() once when a server instance starts. On a
// non-production deployment configured with production resources it throws,
// so the instance does not serve. On production and locally it does nothing.

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { assertDeployEnv } = await import("./lib/deploy-env-guard.mjs");
  assertDeployEnv(process.env);
}
