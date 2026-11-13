#!/bin/sh
# Vercel "Ignored Build Step" (vercel.json ignoreCommand) — preview-environment-isolation.md §2.4.
# Vercel convention: exit 1 = BUILD, exit 0 = SKIP.
#
#   Production                                   always builds
#   Preview with DAALI_PREVIEW_ISOLATED=true     builds (and must still pass scripts/check-deploy-env.mjs)
#   any other Preview                            skipped

if [ "$VERCEL_ENV" = "production" ]; then
  echo "ignore-build: production — building"
  exit 1
fi

if [ "$DAALI_PREVIEW_ISOLATED" = "true" ]; then
  echo "ignore-build: ${VERCEL_ENV:-unknown} ${VERCEL_GIT_COMMIT_REF:-} — Preview declared isolated, building"
  exit 1
fi

echo "ignore-build: ${VERCEL_ENV:-unknown} ${VERCEL_GIT_COMMIT_REF:-} — Preview not declared isolated (DAALI_PREVIEW_ISOLATED), skipping"
exit 0
