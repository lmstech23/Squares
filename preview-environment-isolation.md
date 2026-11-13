# Preview Environment Isolation

**Status:** proposed. It is local to branch `preview-safeguards`, and nothing is pushed or deployed.
**Date:** October 16, 2026
**Why:** pushing `merch-standalone` (`efd055f`) created a Vercel **Preview** deployment. The repo's records say Preview shares the production database record (`src/lib/db-target.ts`, Sep 6), and Production's `STRIPE_SECRET_KEY` is live (`STATUS.md`, Sep 3). A Preview with that configuration is a second production front end: real Board checkouts, real rows. See `daali-preview-deployment-findings.md`.

**Goal:** a Preview deployment can never read or write production data or use live Stripe. Production and Hampton's live fundraiser behave exactly as they do today.

---

## 1. What counts as a production resource

| Resource | Production identifier | How a Preview is checked |
|---|---|---|
| Database | Supabase project `xfmonzvdlxbeskugrjmk` (`DEFAULT_PRODUCTION_DB_REF`, overridable with `DAALI_PRODUCTION_DB_REF`) | The project ref inside `DATABASE_URL`, `DIRECT_URL`, `POSTGRES_URL`, `POSTGRES_PRISMA_URL` and `POSTGRES_URL_NON_POOLING` (pooler and direct shapes) |
| Supabase API | Same project | The ref in the `NEXT_PUBLIC_SUPABASE_URL` host (`<ref>.supabase.co`) |
| Stripe | Live mode | The prefix of `STRIPE_SECRET_KEY`: `sk_live_` or `rk_live_` |

The non-production project is **`daali`** (`iujjlgfrwavfhqatpqdy`, "daali-dev").

## 2. Safeguards in code (this branch)

### 2.1 One guard, `src/lib/deploy-env-guard.mjs`
- **When it does nothing.** `VERCEL_ENV=production` is checked **first, and unconditionally exits the guard**, so nothing in it can stop the live site. Local runs (no `VERCEL`) are also never checked.
- **When it applies.** It is *enforced* when either of these holds:
  - `VERCEL_ENV` is `preview` or `development`; or
  - `VERCEL_ENV` is missing, and the build is on Vercel (`VERCEL=1`) from a git branch other than `main` (`VERCEL_GIT_COMMIT_REF`).

  The second rule still catches a Preview if system variables were ever partly hidden.
- **What it checks.** When enforced, it collects every production resource from §1 that it finds and **throws**. The message names the variable and the reason, never the value.

### 2.2 Build time: the Preview never goes live
`package.json` `build` becomes `node scripts/check-deploy-env.mjs && next build`. On a misconfigured Preview the build **fails** and GitHub shows a red Vercel status. Nothing is served.

On Production the check prints `deploy-env-guard: production — not enforced` and exits 0, so the build is the same `next build` as today.

### 2.3 Run time: defense in depth
`src/instrumentation.ts` runs the same guard when the Node server starts. A Preview whose variables were changed to production values after it was built refuses to start, instead of serving.

On Production it does nothing.

### 2.4 Previews build only when you opt in
`vercel.json` gains `"ignoreCommand": "sh scripts/vercel-ignore-build.sh"`. It replaces the dashboard rule, so the rule is now in version control.

| Deployment | Behavior |
|---|---|
| **Production** (`VERCEL_ENV=production`) | **Always builds** |
| **Preview** | Builds **only** when the Preview environment has `DAALI_PREVIEW_ISOLATED=true` |
| **Preview, opted in** | Still has to pass the §2.2 guard to go live |

Two independent locks, then: you must declare Preview isolated, and the build proves it.

**One behavior change, flagged:**
- Today's dashboard rule, added between Sep 22 and Oct 7, may skip some Production builds, for example markdown-only commits to `main`.
- With this file, **every push to `main` builds Production**, which is how `CLAUDE.md` already describes it ("Docs-only commits deploy too").
- If you want to skip markdown-only Production builds, that can be added; it is a separate decision.

## 3. Safeguards in Vercel (account actions, in this order)

1. **Contain:** delete the `merch-standalone` Preview deployment (`squares-exm1qa2xf…`).
2. **Authenticate:** Deployment Protection → **Vercel Authentication** on, for **Standard Protection** (all Preview URLs).
3. **Isolate:** on every variable shared with Production, **untick Preview and Development**, leaving Production exactly as it is. Then add Preview-only values that point at `daali` and Stripe **test** mode.
4. **Declare:** add `DAALI_PREVIEW_ISOLATED=true` to Preview **only after** step 3.

The exact click-by-click steps are in `daali-preview-runbook.md`.

## 4. What does not change

- **Production values:** no Production variable value changes. Unticking Preview leaves the Production entry and its value untouched.
- **The running site:** environment changes don't affect a running deployment. The live site keeps running deployment `ab6de64` until the next production deploy, which reads the same Production values.
- **Board code:** no Board route, checkout, webhook, cron or page is modified.
- **Production checks:** the guard is a no-op on Production by construction, and a unit test asserts it.
- **Hampton's live fundraiser:** its Production database, live Stripe key, webhooks and crons are untouched.

## 5. Tests

`src/lib/deploy-env-guard.test.ts` (in `npm test`) checks that:
- **Production is never checked:** Production with live Stripe and the production DB is not enforced, and `main` on Vercel is not enforced.
- **Bad Previews are refused:**
  - a production DB ref in any of the five database variables (pooler and direct shapes);
  - the production Supabase URL;
  - `sk_live_` and `rk_live_` keys.
- **Good Previews pass:** a Preview on `daali` with `sk_test_` passes.
- **The non-`main` branch rule is enforced** even without `VERCEL_ENV`.
- **No secret value appears in any message.**
- **The ref parsing matches** `deriveProjectRef` in `src/lib/db-target.ts`.
- **The ignore script decides correctly:** it is exercised with each `VERCEL_ENV` and opt-in combination (exit 1 means build, exit 0 means skip).

## 6. Rollout (each step needs your approval)

1. Do the Vercel steps 1–3 (no deploy needed).
2. Approve this branch for review, then merge to `main`. That merge is a production deploy: an ordinary build plus a guard that reports "not enforced".
3. When a Preview is needed for merch testing:
   - catch `daali` up to the current migrations through the guarded non-production path (approval needed; it's at 5 of 25 today);
   - set `DAALI_PREVIEW_ISOLATED=true`;
   - push the branch for a Preview.
