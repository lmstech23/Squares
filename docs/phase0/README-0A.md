# Phase 0A — Event foundation

Drop-in for the existing Next.js App Router + Prisma app. Additive only: no
existing table, route, or component is touched.

## Install

1. **Schema** — append `prisma/schema.additions.prisma` to `prisma/schema.prisma`.
2. **Migrate** — copy `prisma/migrations/0001_event_foundation/` into your
   migrations folder, then `npx prisma migrate deploy && npx prisma generate`.
3. **Copy `src/`** over the app root. Paths assume the `@/*` → `src/*` alias.
4. **Wire auth** — `src/lib/currentOrganizer.ts` is the ONLY integration point.
   It throws until you point it at the existing Supabase session lookup.

Nothing else needs configuration. No new env vars.

## What is here

| Layer | Files |
|---|---|
| Domain (pure) | `src/domain/` — status, slug, identity, validation, `assertNever` |
| Commands | `src/commands/events/` — create, update, publish, close |
| Command infra | `src/lib/commands/` — types, authorize, canonical hash, `runCommand` |
| Capability | `src/capabilities/eventCore.ts` |
| Identity | `src/db/eventPerson.ts` — `resolveEventPerson`, the only creator |
| Routes | `src/app/api/events/…` |
| Organizer UI | `/events`, `/events/new`, `/events/[id]/edit` |
| Public page | `/e/[slug]` |

`src/domain/` imports nothing from Prisma, Next, or the session. That boundary is
the whole reason Phase 2 is cheap.

## The three plan decisions, in code

**[R1] The CANCELLED seam** — `src/domain/eventStatus.ts`. Every read of
`EventStatus` is an exhaustive switch ending in `assertNever`. Adding `CANCELLED`
to the enum breaks the build at the public page, the registration guard, the badge
renderer, and the transition table. Nothing may write `status !== 'PUBLISHED'`.

**[R4] Idempotent replay** — `src/lib/commands/runCommand.ts`. The
`CommandExecution` row stores the actual outbound payload, so a replayed
`publishEvent` returns its original slug. Only successes persist, because the row
is written inside the same transaction as the work. Same key with different input
returns `IDEMPOTENCY_KEY_CONFLICT` rather than a stale result.

**Capability contract with a real consumer** — `src/capabilities/eventCore.ts` is
read by `/events/[id]/edit` to disable the fields it locks and print the reason.
Today that is the slug after publish. Every mutability rule is exercised by a human
before Daali ever reads one.

## Tests

```
npm run test      # 16 passing — status allowlists, identity normalization,
                  # slug generation, validation, canonical input hashing
```

## Deliberately not here

Registration · capacity · RSVP · volunteers · notifications · `CANCELLED` ·
organizer name editing · any LLM call.

## Notes for the next phase

- `Event.slug` is nullable and unique. Postgres allows many NULLs in a unique
  index, so drafts coexist without slugs and no placeholder is invented.
- `EventState` (in `eventCore.ts`) is `{ status, publishedAt }`. **0B adds
  `registrationCount`**, which will fail to compile at every contract that needs
  reconsidering — the same mechanism as the status switches, on purpose.
- `resolveEventPerson` is the only place that knows a person is scoped to an
  event. Downstream code takes `eventPersonId` and never `eventId + email`. That
  is the fundraiser seam [R5]; a code review that lets `eventId` leak into the
  signup domain is spending it.
- `resolveEventPerson`'s name overwrite is safe only while no organizer name-edit
  surface exists [R2]. That surface ships with `nameSetByOrganizerAt`.
