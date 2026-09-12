# Public Theme — Spec (v3.1)

**Status:** v3.1 approved September 11, 2026, as the implementation authority for
Deploy 1. It incorporates the §11 inventory, the browser spike, and the approved
organizer label.
**Location:** Commit as `docs/public-theme-spec.md` before any code.
**Authority:** This document is the flow authority for public-page theming.
`fundraiser-board-v2.md` remains the authority for fundraiser flows,
`fundraiser-money-state-machine.md` for money, and `SYSTEM-FLOW.md` for Game Day.
Nothing here amends any of them.

**Changes from v3:** the organizer label is approved (§2.1, §9), the placeholder
decision is recorded, and the `brand-*` rename note is corrected.

**Changes from v2**
- **Literal overrides only.** A theme overrides `tone-*` and `brand-*` tokens
  directly with literal colors. It never references a palette variable at
  runtime: the spike showed an unreferenced palette variable renders transparent,
  silently. The LIGHT table lives in `globals.css` as literals.
- **Accent roles renamed `brand-*`.** v2's `accent` tokens would collide with
  Tailwind's `accent-` (checkbox color) utility.
- **Per-use classification** for `green-500` and `white`, from the inventory.
  There is no hue-wide find-and-replace for green.
- **`progress` merged into `brand-line`.** Both default to `green-500`.
- **Both current selection styles kept** (white fill, green outline). Unifying
  them would change the dark render; that's a later cleanup.
- **No focus token in v1.** There is no focus styling on selectable elements
  today. Recorded as a known accessibility gap (§3.5).
- **`organizer_user_id` is `text`,** matching `hosts.supabase_user_id`.
- **Nothing changes above L115 in `page.tsx`.** The theme is fetched inside the
  fundraiser branch by `board.themeId`.
- **Enum convention confirmed.**
- **Host.name findings recorded,** and a board-level organizer label proposed
  (§9, §11).

---

## 1. Purpose

Let an organizer brand a public experience without redesigning it. The organizer
supplies a color, a light or dark surface, and an optional image. Daali keeps
layout, typography, spacing, semantic colors, and accessibility.

**First consumer:** the fundraiser branch of `/board/[slug]` and its donor pages.
Hampton lives there today, so this is a deliberately narrow, additive change on
the live Board path. The theme record is neutral so it can later serve other
capabilities.

**Not in scope:** custom CSS, fonts, additional color controls, per-component
styling, host settings UI, `/e/[slug]`, email templates, `themeColor` or viewport
exports, and `theme(static)`.

---

## 2. Model

Theme is presentation. The donation default is fundraiser configuration. They are
stored separately.

```prisma
enum ThemeSurface {
  LIGHT
  DARK
  @@map("theme_surface")   // newer-generation convention; UPPERCASE as in PassTier
}

/// CHECK (primary_color format) lives in SQL only.
model PublicTheme {
  themeId         String       @id @default(dbgenerated("gen_random_uuid()")) @map("theme_id") @db.Uuid
  organizerUserId String       @map("organizer_user_id")   // text, = hosts.supabase_user_id; not a Host FK
  primaryColor    String       @map("primary_color")
  surface         ThemeSurface @default(DARK)
  heroImageUrl    String?      @map("hero_image_url")
  createdAt       DateTime     @default(now()) @map("created_at") @db.Timestamptz(6)
  boards          Board[]
  @@map("public_themes")
}

// Board — additive, nullable, no default, no backfill.
/// CHECK (donation_default_cents > 0) lives in SQL only.
themeId              String?      @map("theme_id") @db.Uuid
theme                PublicTheme? @relation(fields: [themeId], references: [themeId], onDelete: Restrict, onUpdate: NoAction)
donationDefaultCents Int?         @map("donation_default_cents")
/// CHECK (trimmed, 1–60 chars) lives in SQL only.
publicOrganizerLabel String?      @map("public_organizer_label")
```

```sql
CREATE TYPE "theme_surface" AS ENUM ('LIGHT', 'DARK');

CREATE TABLE public.public_themes (
  theme_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organizer_user_id text NOT NULL,
  primary_color     text NOT NULL,
  surface           "theme_surface" NOT NULL DEFAULT 'DARK',
  hero_image_url    text,
  created_at        timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT public_themes_primary_color_check CHECK (primary_color ~ '^#[0-9A-F]{6}$')
);

ALTER TABLE public.boards
  ADD COLUMN theme_id uuid,
  ADD COLUMN donation_default_cents integer,
  ADD COLUMN public_organizer_label text;

ALTER TABLE public.boards
  ADD CONSTRAINT boards_public_organizer_label_check
  CHECK (public_organizer_label IS NULL
         OR (char_length(public_organizer_label) BETWEEN 1 AND 60
             AND public_organizer_label = btrim(public_organizer_label))) NOT VALID;
ALTER TABLE public.boards VALIDATE CONSTRAINT boards_public_organizer_label_check;

ALTER TABLE public.boards
  ADD CONSTRAINT boards_donation_default_cents_check
  CHECK (donation_default_cents IS NULL OR donation_default_cents > 0) NOT VALID;
ALTER TABLE public.boards VALIDATE CONSTRAINT boards_donation_default_cents_check;

ALTER TABLE public.boards
  ADD CONSTRAINT boards_theme_id_fkey
  FOREIGN KEY (theme_id) REFERENCES public.public_themes(theme_id)
  ON DELETE RESTRICT ON UPDATE NO ACTION NOT VALID;
ALTER TABLE public.boards VALIDATE CONSTRAINT boards_theme_id_fkey;

-- containment: copy the board_invites block verbatim, targeting public_themes
```

- **Apply with** `npm run db:migrate:production` and `VERIFY_SITE_URL` set.
- **Why `organizer_user_id` is text.** It matches `hosts.supabase_user_id` (text,
  unique, nullable), and a Prisma `String` in the Event package. Any comparison
  against `auth.uid()` needs `::text`.
- **Script guard.** The write script refuses if the host's `supabase_user_id` is
  null.
- **Why RESTRICT.** Rollback clears `boards.theme_id`; it never deletes a theme.
- **Why no index on `boards.theme_id`.** Reads go from board to theme by primary
  key.
- **Why presets aren't in the database.** The preset check happens at write time
  in code (§5).
- **Direction of dependency.** Board → PublicTheme. `src/lib/public-theme.ts` is
  pure and imports nothing from Prisma or Board modules.

### 2.1 Organizer label (approved September 11, 2026)

`boards.public_organizer_label` is board configuration for attribution. It is not
a theme field and not a Host field.

- **Scope.** Board-scoped. It is nullable, with no default and no backfill, and
  rides in the Deploy 1 migration. It does nothing while null.
- **Write rules**, enforced in the script and backed by the database CHECK:
  - Trim the value.
  - An empty result becomes null.
  - Maximum 60 characters, counted as characters (`char_length`), not bytes.
  - Store the value exactly as given after trimming. Typographic characters
    such as `’` (U+2019) are preserved.
- **Independent of the theme.** The label renders whether or not the board has a
  theme. Clearing the theme does not clear the label.
- **Rendering** is specified in §9 and applies to the fundraiser page only.

---

## 3. Tokens

### 3.1 Mechanism (verified by spike, Tailwind 4.1.18)

1. **Defaults.** A non-inline `@theme` block in `globals.css` declares every token
   with its default pointing at the stock palette. For example,
   `--color-tone-900: var(--color-gray-900)`.
   - The spike showed the computed value is identical to the stock class
     (`lab(8.11897 0.811279 -12.254)`).
   - Tailwind emits referenced palette variables, so the defaults are safe.
2. **LIGHT surface.** A plain rule in `globals.css`,
   `[data-surface="light"] { --color-tone-900: <literal>; … }`, uses literal
   values only.
3. **Brand values.** `themeStyle(theme)` returns the `data-surface` attribute plus
   an inline style setting `--color-brand*` to literal colors computed from
   `primary_color`.
   - For a null theme it returns nothing: no `data-surface`, no style.
   - It is applied to each page's existing root element: `fundraiser-view:419`,
     `reservation/[id]/page:139`, `passes/[batch]/page:101`.
   - Spike: an override on the L419 div reached the fixed donate sheet.
4. **Override the tokens, not the palette.** Overriding `--color-gray-*` on an
   element does not move a `tone-*` token, because the token was resolved at
   `:root`.
5. **No runtime palette references.** No stored or inline value may contain
   `var(--color-…)`.
   - The spike showed an inline reference to an unemitted palette variable
     renders transparent with no error.
   - `theme(static)` would fix that but adds about 26% CSS to every page. It isn't
     needed if the rule is followed.
6. **Opacity modifiers.** `bg-tone-900/50` compiles to `color-mix()` and follows
   overrides.
   - Its fallback for browsers without `color-mix` bakes in stock gray. That's
     accepted: Tailwind 4's own browser baseline already requires `color-mix`
     support.
7. **Only additions to `globals.css`.** No existing rule is edited.
   - The existing `color-scheme: dark` on date inputs (`globals.css:28-31`) is
     untouched. No date input exists in scope.

### 3.2 Families and mapping (from the inventory)

**Neutral scale: `tone-100` … `tone-950`, and `tone-fg`.**
- `gray-N` becomes `tone-N`, one for one, across all 10 steps in use, including
  prefixes: `hover:`, `placeholder:`, `focus:`, `disabled:`.
- `text-white` and `hover:text-white` used as body, heading, input, or
  secondary-control text become `tone-fg`.
- Null values: stock gray, and white for `tone-fg`.
- LIGHT values are literals from a product-owned table. They are chosen for how
  each step is actually used, including its opacity, rather than as a strict
  reversal. Body and input text must meet 4.5:1 on the LIGHT surface.

**Brand roles.** The organizer's color feeds only these five:

| Token | Replaces (null value = today) | Themed value |
|---|---|---|
| `brand` | `bg-white` and `border-white` on primary buttons, selected amount chips, and payment-app chips | `primary_color` |
| `brand-hover` | `hover:bg-gray-200` on those primary buttons | `primary_color` darkened, with `on-brand` still ≥ 4.5:1 |
| `on-brand` | `text-gray-950` on those buttons and chips | Black or white, ≥ 4.5:1 on `brand` |
| `brand-line` | `green-500` as: the selected-choice border (card vs direct), `accent-green-500` checkboxes, and the progress fill (`fundraiser-view:487`) | `primary_color` |
| `brand-wash` | `bg-green-950/20` on the selected-choice fill | `primary_color`. The class keeps its `/20` modifier, so on LIGHT it renders as a light tint |

**Status families: `ok-*` (green), `bad-*` (red), `warn-*` (yellow), `caution-*` (amber).**
- These hold every remaining use of those hues. That includes:
  - the status panels (border X-900/50–60, background X-950/20–30, text X-200)
  - tinted text at opacity
  - the early-bird chip (`green-500/15`, `fundraiser-view:451`)
  - the two status-colored action buttons (`bg-green-200` at `fundraiser-view:579`,
    `bg-yellow-200` at `hold-timer:139`)
- Status-colored actions stay in their status family. They are never brand.
- Null values are the stock hue. LIGHT values are literals of the same hue, tuned
  to read on LIGHT with each step's actual opacity.
- Only the steps in use are defined: green 12 variants, red 3, yellow 8, amber 4.

**Never tokenized:**
- The pass QR background (`pass-row:81`, `bg-white`).
- The scrim (`bg-black/70`).

**Classification rule.** `green-500` and `white` are converted per use, by the
tables above. There is no hue-wide find-and-replace. Anything that fits none of
these families is a stop-and-report, not a new token.

### 3.3 Two selection styles

Today, amount and payment-app chips use a white fill, and the card-vs-direct
choice uses a green outline with a tint. Both are kept, mapped to
`brand`/`on-brand` and `brand-line`/`brand-wash` respectively. On a themed page
both read as the organizer's color. Unifying them is a later design change,
because it would alter the dark render.

### 3.4 Rules

| Rule | Detail |
|---|---|
| **Null theme = today** | No `data-surface`, no style. Every token resolves to the stock value it replaced |
| Organizer scope | `primary_color` feeds only the five `brand*` tokens |
| Too-light accent | Under 3:1 against its surface is rejected at write. Never silently altered |
| Status meaning | Status hues never derive from `primary_color` |
| `surface` switches | Exhaustive, ending in `assertNever` |
| One source | Components use token classes and accept no color props |

### 3.5 Known accessibility gap (not fixed in v1)

- Selectable elements (chips, choices, steppers) have no focus styles. Buttons
  rely on the browser's default outline.
- Text inputs signal focus only by a border shift (gray-800 → gray-600).
- Fixing this changes the dark render, so it cannot ride in Deploy 1. It gets its
  own follow-up after Hampton is live: `focus-visible` rings on both surfaces,
  using `brand-line` where themed.

---

## 4. Hero image

- **Optional.** When absent, there is no hero area.
- **Storage.** A new public bucket, `public-theme-images`: 1 MB limit, and
  image/jpeg, image/png, image/webp only. `hbcu-logos` is not reused. Creating
  the bucket is a Deploy 2b configuration step.
- **Origin allowlist.** `hero_image_url` must start with that bucket's public URL
  prefix. Checked at write.
- **Delivery.** A plain `<img>`. `next.config.ts` stays unchanged. Upload a photo
  already resized to about 1600px wide.
- **Rendered unaltered.** Full width, height auto, capped maximum height,
  `object-contain`. No crop, overlay, opacity change, rounded mask, or shadow.
- **Alt text.** `alt=""`.
- **Rights.** The organizer is responsible for rights to the image. Logo support
  remains in the architecture.

---

## 5. Donation default

- **Single source.** `DONATION_PRESETS_CENTS` (`src/lib/contributions.ts:53`) is
  the only preset list. `donate-sheet.tsx:24`'s local `PRESETS` is deleted and
  replaced by the import.
- **Render rule.** `initialDonationCents(configured)`, placed next to the presets,
  returns the configured value if it is a preset, otherwise 2500. It never
  preselects Other.
- **Where it applies.** `donate-sheet.tsx:58` initializes from a prop. The prop
  flows from `page.tsx`'s fundraiser branch through `fundraiser-view.tsx`.
- **Write rule.** Null or a preset.
- **Result with 5000.** `$50` selected, total `$50`, and "I'll send $50"
  (`:398`) on first open.
- **Ticket panel unchanged.** It still initializes to `""` (`purchase-panel:68`).
  The placeholder change is separate (§11).
- **Server unchanged.** The donate route (`route.ts:62/87/96`) is not touched.

---

## 6. Scope of change

**Token conversion (12 files, all fundraiser-only).**
- `board/[slug]/`: `fundraiser-view`, `claim-sheet`, `donate-sheet`,
  `entry-sheet`, `purchase-panel`, `hold-timer`, `direct-payment`
- `reservation/[id]/`: `page`, `copy-field`
- `passes/[batch]/`: `page`, `pass-viewer`, `pass-row`

**Data loading:**
- `board/[slug]/page.tsx`:
  - **Zero changes above L115.** The page query's `include` already returns the
    new Board columns.
  - Inside the fundraiser branch: when `board.themeId` is set, fetch the theme with
    `publicTheme.findUnique`. Pass the theme and `donationDefaultCents` down.
  - No change to `generateMetadata` (L31–48) or the Game Day return (L401+).
- `reservation/[id]/page.tsx`: add `themeId` to the nested board select
  (L96–105), then fetch the theme.
- `passes/[batch]/page.tsx`: add `themeId` to the nested `event.board` select
  (L61–68), then fetch the theme.

**Supporting changes:**
- `globals.css`: additive `@theme` block and the `[data-surface="light"]` rule.
- `src/lib/public-theme.ts` (new): validation, contrast, `themeStyle`, and the
  LIGHT-table contrast test.
- `src/lib/contributions.ts`: `initialDonationCents`.
- `prisma/schema.prisma` and a migration.
- `scripts/set-board-theme.ts` (new):
  - Sets the theme, donation default, and organizer label.
  - Has a dry run, a slug argument, and the null-uid guard.
  - Each field can be set or cleared independently.
- **Organizer label rendering:** `fundraiser-view.tsx` (the attribution slot at
  `:468-470`), plus passing the label from the fundraiser branch of `page.tsx`.

**Out of bounds:** `src/app/api/`, `src/app/host/`, cron, webhooks,
`player-board.tsx`, `accepted-payments.ts`, `next.config.ts`, and every line of
`page.tsx` outside L115–400.

---

## 7. Invariants

1. A board with `theme_id = null` renders identically to before. Its root elements
   carry no `data-surface` and no style attribute.
2. Game Day renders identically. `page.tsx` changes only inside L115–400.
3. No code branches on a board id, slug, or organizer to decide styling.
4. No component accepts a color prop.
5. `primary_color` feeds only the `brand*` tokens. It is referenced only in
   `src/lib/public-theme.ts`, the three page loaders, and the script.
6. No runtime value contains `var(--color-…)`. A unit test on `themeStyle` output
   enforces this.
7. `src/lib/public-theme.ts` imports nothing from Prisma or Board modules. A unit
   test enforces this.
8. The pass QR code always sits on literal white.
9. Status hues and status-colored actions never derive from `primary_color`.
10. The ticket-panel donation field opens empty regardless of
    `donation_default_cents`.
11. Setting `theme_id` and `donation_default_cents` to null fully restores prior
    behavior.
12. With `public_organizer_label` null, the fundraiser attribution is exactly
    today's, including the `Host.name` fallback.
13. Game Day attribution (`page.tsx:428-429`) and manager-invite attribution
    (`invite/[token]/page.tsx:99-101`) never read `public_organizer_label` and
    are unchanged.
14. A stored label is always trimmed and 1–60 characters. The database enforces
    this.

---

## 8. Rollout, rollback, verification

**Deploy 1 — code and migration, nothing assigned.** Expected visible change:
none, anywhere.

**Verification before Deploy 2.** Playwright, baseline vs candidate, same staging
database snapshot:
- **Baseline** is `main` after the placeholder change lands.
- **Surfaces:**
  - Unthemed fundraiser board: page, purchase panel with quantities, Donate Only
    (both amount and choice selection states), entry sheet, reservation page,
    passes page.
  - Raffle-on fundraiser board with the claim sheet open.
  - Fundraiser boards with `Host.name` set and with it null. This proves the
    fallback is unchanged while the label is null.
  - Hold timer: normal and urgent.
  - Game Day board: open, closed, and with winners.
- **Viewports:** 360px and 1280px. Animations off, clock frozen, readings taken
  after transitions (≥ 700 ms; see the spike note on the 150 ms transitions).
- **Pass:** zero pixel difference, and zero difference in computed `color`,
  `background-color`, `border-color`, `outline`, and `accent-color` per element.
- **Diff guard:** `git diff --stat` touches only §6 files, with `page.tsx` hunks
  only inside L115–400.
- **Staging only.** Rendering `/board/[slug]` runs `square.updateMany` (L88) on
  every request, so even page loads write.

**Deploy 1 unit tests for the label:**
- Trimming, empty string becoming null, and the 60-character limit.
- `QT ’13` round-trips unchanged.
- Precedence: label present → label; label null with host name → today's line;
  both null → nothing.

**Deploy 2 — Hampton theme, donation default, and organizer label.** Run the
script with dry run first. Review the themed page against §3.2's LIGHT contrast table at 360px and
1280px.

**Deploy 2b — hero image, once the photo exists.** Create the bucket, upload,
set `hero_image_url`.

**Rollback:**
- Theme and default: set the board's `theme_id` and `donation_default_cents` to
  null.
- Label: set `public_organizer_label` to null, independently of the theme.

---

## 9. Hampton configuration

| Field | Value |
|---|---|
| Board | `xv8yuwhd` |
| `organizer_user_id` | `1dfbdda0-33e8-45ac-a4a7-b5ac059693e4` (`hosts.supabase_user_id` for host `c94cbd1c…`) |
| `primary_color` | `#004AAD` (§10) |
| `surface` | `LIGHT` |
| `hero_image_url` | Homecoming/event photo (Deploy 2b) |
| `donation_default_cents` | `5000` |
| `public_organizer_label` | `QT ’13` (typographic apostrophe, U+2019; 6 characters) |

**Hero decision.** Use an event photo, not the Hampton University logo, seal, or
athletics marks. This is a parent fundraiser and must not read as an official
university payment page.

### Attribution — Host.name findings (Sep 11)

**Where it renders** (each hidden when null):
- the public fundraiser page (`fundraiser-view:468`, "hosted by")
- the public Game Day page (`page.tsx:428`)
- the manager invite page (`invite/[token]/page.tsx:99`, "Invited by")

**Where it doesn't:** no host screen, email, SMS, receipt, or export.

**Editing:** no screen or route. It is written only at sign-in from the Supabase
profile's `full_name` (`auth.ts:46`, `auth/callback/route.ts:27`). It is null on
all 6 hosts.

**Conclusion.** Populating `Host.name` would change the Game Day and invite
pages. A value set by hand could also be overwritten at the next sign-in.
Decision confirmed: do not use it for board attribution.

**Other public identity:** the board payment handles, shown on the donate sheet,
the reservation page, Game Day, and the pending-reservation email. These are the
most identifying public detail today.

**Rendering (approved).** Only in the fundraiser's existing attribution location,
`fundraiser-view.tsx:468-470`, in this order:
1. **Label present:** `Organized by {publicOrganizerLabel}`.
2. **Label null and `Host.name` present:** today's "hosted by {hostName}" line,
   exactly as it renders now.
3. **Both null:** nothing, as today.

Game Day and the manager invite page are not changed. There is no host settings
UI in v1; the label is set through `scripts/set-board-theme.ts`.

---

## 10. Color source record — Hampton Blue

Recorded September 11, 2026. The official sources conflict; this section records
that rather than treating the value as settled.

| Source | Hex | PMS | CMYK |
|---|---|---|---|
| Brand guide webpage, `home.hamptonu.edu/our/brand-guide/` (page modified 2026-08-13) | `#004ADD` | 293 C | C95 M72 Y0 K0 |
| Hampton's downloadable brand board (provided by product owner) | `#004AAD` | 293 C | C95 M72 Y0 K0 |

**Chosen: `#004AAD`.** Both sources cite the same Pantone and CMYK values, and
`#004AAD` is the closer match to PMS 293 C. The webpage value is most likely a
typo.

**Not used:** third-party color sites (they disagree with each other) and any
value sampled from a logo or screenshot.

**Revisit if** University Relations confirms a different value. The change is one
field on one row.

**Contrast:** 8.13:1 on white, and `on-brand` resolves to white.

---

## 11. Open items

**Resolved product decisions (September 11, 2026):**
1. **Organizer label:** approved (§2.1, §9).
2. **Ticket-panel placeholder:** approved as a separate small commit, landed
   before theming. Its commit is the visual-regression baseline.
   - Use neutral copy, not `25` or `50`.
   - The field stays initialized to `""`.

**Follow-ups after Hampton is live:**
- Focus-visible rings (§3.5).
- Unify the two selection styles (§3.3).
- Remove the `square.updateMany` render-time write (L88). Out of scope here;
  flagged by the preflight.

**Amendments approved September 12, 2026.** Recorded here; the header stays
v3.1 until the product owner versions it.
1. **§6 — `src/lib/donation-presets.ts`.** A pure module with no imports holds
   `DONATION_PRESETS_CENTS` and `initialDonationCents`. `contributions.ts`
   re-exports both, so existing importers are unchanged. `donate-sheet.tsx`
   imports it directly, as §5 intends. `page.tsx` passes
   `donationDefaultCents` and imports nothing dynamically.
2. **§3.2 — progress-track token.** `tone-track` holds the one neutral fill,
   the progress track in `fundraiser-view.tsx`. Its default is
   `var(--color-gray-800)`, and its LIGHT literal is `#E5E7EB`.
   - `tone-800` and `tone-700` are borders only.
   - Their LIGHT values are `#868B96` and `#757A87`, so control boundaries
     reach 3:1 on the page and on cards.
3. **§3.4 — accent against the track.** At write, an accent under 3:1 against
   its surface's progress track is rejected. This is in addition to the
   surface check.
   - The LIGHT track is `#E5E7EB`; the DARK track is stock gray-800,
     `#1E2939`.
   - Effective range: relative luminance at most about 0.23 on LIGHT, and at
     least about 0.165 on DARK.
   - A narrow band near 0.18 is excluded on both, because no hover step there
     keeps black button text at 4.5:1.
   - `#004AAD` measures 8.13:1 on white and 6.57:1 on the LIGHT track.

**Do not ship a LIGHT theme on a raffle-enabled board** (recorded September 12,
2026).
- On LIGHT, `warn-200` is `#251604`. The hold timer uses it for its text,
  its 60%-opacity helper line, and its status-coloured button.
- The hold timer renders only on raffle-enabled boards
  (`fundraiser-view.tsx:638`, gated by `square-product.ts:42`). A LIGHT
  theme on such a board would show it.
- Until the warn scale is fixed, do not combine `surface = LIGHT` with
  `raffle_enabled = true`. Hampton (`xv8yuwhd`) has the raffle off.

**Known reconciliation item.** When the Event package merges, its id generation
may be `@default(uuid())` rather than this repo's `gen_random_uuid()`.
`public_themes` follows this repo.
