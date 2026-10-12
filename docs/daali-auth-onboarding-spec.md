<!--
IMPORTED DOCUMENT: Daali Auth + Onboarding Spec (amended Oct 12, 2026: captcha on sign-in calls, Game Day return path)
Source: Claude Docs export, received as "daali-auth-onboarding-spec-oct12.md"
Export date: Oct 12, 2026
sha256 of the received file: 020f340d96b78c48519dbc797915b08a2404fa025eae17ae5947e40c7d5ec032
Supersedes the copy imported in d4e6996 (sha256 f3b700d66de4833cb268b5e9f13df7c4848c24b8666320670ded0059b9578cb8).
Everything below this comment is that file, byte for byte; it has not been edited.
Per CLAUDE.md ("If a spec is not in this repository, it is not authoritative"),
this repository copy is now the authoritative version.
-->

# Daali Auth + Onboarding Spec

Oct 2, 2026 · @Daaliyah

## Purpose and scope

This spec replaces the Board-era sign-in with one passwordless Daali account system with open signup, moves the app from beta.daali.app to daali.app, and ships a minimal Your Daali for every signed-in organizer to land on.

**In scope:** sign-in, open account creation through Get started, profile setup with phone verification, the post-auth gate, minimal Your Daali, the organizer-item read model, Game Day access and the Legacy Boards entry, and the domain move.

**Out of scope:** the standalone Fundraiser and Event roots, the creation flow behind "What are you organizing?", replacing the fundraiser management surface, and the landing page design (on the Daali Landing Page canvas).

**Hard boundary:** this work changes authentication and navigation only. No live Board or fundraiser write path changes. That covers contributions, checkout, cash and tender recording, payouts, Stripe Connect, `paymentPreference`, `boardCreationGate`, and credit transactions. Existing records are read, never migrated or rewritten. Two items touch the edges and each ships as its own reviewed change: the Game Day creation check (Launch readiness, L2) and the URL updates in Stripe and Twilio settings for the domain move.

**Launch rule:** signup is open in the code from the day it ships, but daali.app is not advertised until every item in Launch readiness is done. When it's advertised, it's a live, complete site.

Source documents: the auth direction doc (this project), the read-only auth audit, and `event-path-gate-independence.md`.

Authority: this spec governs authentication and onboarding through `/home`. The Daali Product Flow Spec governs product behavior after `/home`, and the approved Figma frames govern visual presentation and copy. If two governing specs conflict, stop and surface the conflict rather than following whatever the code does today.

## Locked decisions

These are settled and not open for reinterpretation during the build.

| # | Decision |
| --- | --- |
| D1 | No Daali passwords. Sign-in is Google, email magic link, or SMS code. |
| D2 | Signup is open. Anyone can create an account from Get started. Email and phone on the sign-in screen never create an account; an unknown email or number is offered account creation instead. Google signs in or creates on either screen, since both lead to the same verified identity. |
| D3 | Every account starts with a verified email, from Google or an email magic link. Phone-only and password signups are not offered. Accounts created before this release without an email add and verify one at /setup (amended Oct 10, see Existing accounts without an email). |
| D4 | The Supabase user is created by Google OAuth or the email magic link. The `organizer_profiles` row, created on first sign-in, is what makes it a Daali account. |
| D5 | One Supabase user per person. Google, email and phone are methods on that user, never separate users. |
| D6 | Phone is required at setup and verified by attaching it to the signed-in user, never by a phone sign-in. |
| D7 | The only post-auth gate is setup completeness: display name plus verified phone, plus a verified email for existing accounts created without one (amended Oct 10). Incomplete goes to `/setup`, complete goes to Your Daali. In this release the gate covers new Daali routes only; legacy `/host` pages are not gated on setup. |
| D8 | No Host, credit, payment preference or Stripe check participates in new Daali auth or routing. |
| D9 | Organizer display name lives on an organizer profile, not on `Host`. |
| D10 | Your Daali ships minimally with this work and lists existing fundraiser Boards as Fundraisers through a read-only read model. |
| D11 | Seeing a fundraiser you own never requires `legacy_boards_enabled`. The flag is the Game Day entitlement and controls the Legacy Boards entry (amended Oct 11). |
| D12 | UI uses Organizer and Daali account, never Host or New Host. |
| D13 | The app lives at daali.app. Every beta.daali.app URL permanently redirects to the same path on daali.app. |
| D14 | daali.app is not advertised until every Launch readiness item is done. |

## Account creation

Signup is open, and a Supabase user is created in exactly two ways, both starting from a verified email: Google OAuth, or an email magic link sent from Get started. A `before-user-created` hook rejects every other kind of creation.

### What can create a user

| Path | Call | Creates a user? |
| --- | --- | --- |
| Google, on Get started or Sign in | `signInWithOAuth({ provider: 'google' })` | Yes, when no user has that verified email. An existing user with that email is linked, not duplicated. |
| Email, on Get started | `signInWithOtp({ email, options: { shouldCreateUser: true, captchaToken } })` | Yes, when the link or code is confirmed |
| Email, on Sign in | `signInWithOtp({ email, options: { shouldCreateUser: false, captchaToken } })` | Never |
| Phone, on Sign in | `signInWithOtp({ phone, options: { shouldCreateUser: false, captchaToken } })` | Never |

### The hook

A Postgres `before-user-created` hook rejects two kinds of creation with HTTP 403:

- **Users with no email.** That blocks phone-only signups made by calling Supabase directly with the anon key, so every account has a verified email (D3).
- **Anonymous users.** Anonymous sign-ins stay off; the hook makes that a guarantee rather than a setting.

Whether the hook payload can tell a password signup apart is open item O5. If it can, password signups are rejected too. If it can't, they remain possible only through the raw API, need a confirmed email because `mailer_autoconfirm` is off, and are never offered in the UI.

The hook is a pure check and writes nothing. It doesn't fire for automatic linking or `updateUser`, which is what lets Google link to an existing user and setup attach a phone.

### Finalize: becoming a Daali account

On the first authenticated request from a non-anonymous user with a confirmed email and no `organizer_profiles` row, the server inserts that row with `created_via = SIGNUP`. It prefills `display_name` and `avatar_url` from Google when available.

Finalize runs in `/auth/callback`, `/auth/confirm` and the `/setup` loader, whichever comes first. It's an insert that does nothing on conflict, so running it twice is harmless. That covers someone who confirms their email on a phone and then returns to the laptop.

### Abuse controls

- **CAPTCHA:** Supabase CAPTCHA protection on, with Turnstile. It covers every Supabase auth endpoint, so Get started, Sign in and setup all carry it.
- **Rate limits:** Supabase's limits on email sends, SMS sends and verifications stay at their defaults or lower.
- **SMS pumping:** with open signup, anyone who creates an account can make Daali send a text. Twilio Verify Fraud Guard is on, and Verify geo permissions allow only the US until you choose to add a country.
- **No Board access by default:** a new account gets no Game Day creation without the entitlement (Launch readiness, L2).

## New-account flow

A new organizer goes from Get started to Your Daali in four screens: create account, verify (Google or email), finish setup, and confirm phone.

### Screen 1: Create your Daali account (`/start`)

- Heading: **Create your Daali account**
- Sub: Free to use. Choose how you'd like to sign up. There's no password to remember.
- Buttons: **Continue with Google**, **Continue with email**
- Footer: Already have a Daali account? **Sign in**

Every Get started button on daali.app links here.

### Google path

1. The client calls `signInWithOAuth({ provider: 'google', options: { redirectTo: '/auth/callback?next=/setup' } })`.
2. `/auth/callback` exchanges the code, runs finalize, then sends the person through the post-auth gate.
3. Google's verified email becomes the account email. Google's display name prefills "What should we call you?". No email code follows.

If the Google email already belongs to a Daali account, Supabase links Google to it and the person is simply signed in. Nothing is duplicated.

### Email path

1. Screen asks: **What's your email?** Button: **Send link**.
2. The client calls `signInWithOtp({ email, options: { shouldCreateUser: true, captchaToken } })`.
3. The waiting screen says: **Check your email.** We sent a link to {email}. It also shows a six-digit code field and **Resend** with a 60-second cooldown. If the person confirms in this same browser, the waiting screen continues on its own. If they open the link on another device, that device is signed in, and this screen keeps its code field so they can finish here by entering the code. There is no cross-device session handoff (amended Oct 10).
4. The email holds a **Continue to Daali** link and the same six-digit code.
5. The link opens `/auth/confirm`, a page with one **Continue to Daali** button. Pressing it calls `verifyOtp({ token_hash, type: 'email' })`, then finalize, then the post-auth gate. Nothing verifies on page load, because email security scanners open links.

The template uses `token_hash`, not the PKCE code, so the link works on a different device than the one that asked for it. The code is the fallback. Supabase may send either its Magic Link or its Confirm Signup template to a new address, so both templates carry the same link and code.

If the email already belongs to a Daali account, the same link signs them in. Get started never shows an "account exists" error.

### Screen 3: Finish setting up your Daali (`/setup`)

- **What should we call you?** Prefilled from Google when available. Required, 1 to 60 characters, trimmed. Helper: This is how you'll appear to people you invite.
- **Mobile number.** US format by default, stored as E.164. Helper: We'll verify your number so you can also use it to sign in to Daali.
- Button: **Send code**

On submit, the name is saved to `organizer_profiles.display_name` right away, so it survives if the person stops at the phone step. Then the client calls `updateUser({ phone })`, which sends a six-digit code through Twilio Verify.

### Screen 4: Confirm your number

- Heading: **Enter the code we texted to {phone}**
- Six-digit code field, **Resend** with a 30-second cooldown, and **Change number**.
- The client calls `verifyOtp({ phone, token, type: 'phone_change' })`. Success sets `phone_confirmed_at` on the same user and sends them to Your Daali.

The phone step only ever attaches a number to the signed-in user. It never calls `signInWithOtp({ phone })`, so it cannot become a signup path.

### Existing accounts without an email (approved Oct 10)

Accounts created before this release by phone sign-in may have no email; production had 10 such accounts out of 19 on Oct 10. They keep signing in by phone, and their legacy pages stay reachable exactly as today. At /setup they add an email to their existing Supabase user:

- **Screen:** "Add your email" / "We'll use it to sign you in and send your receipts." Field: Email. Button: Send code. Shown only when the signed-in account has no confirmed email, alongside any other missing field.
- **Call:** `updateUser({ email })` on the signed-in user. Supabase sends a confirmation link and six-digit code to the new address, using the Change Email Address template, which carries the same `token_hash` link and code as the other templates.
- **Verify:** `verifyOtp({ email, token, type: 'email_change' })`, or the link through /auth/confirm. The email is attached only after ownership is verified. Until then it is pending and nothing else changes.
- **What stays the same:** the user id, the Host row, Board ownership, collaborator permissions and every management page. Nothing is migrated or rewritten.
- **Email already on another account:** stop. Show "That email is already on another Daali account." Nothing is merged, reassigned or overwritten on either account.
- **Interrupted setup:** if the person leaves after the code is sent, /setup shows the pending address on return with Resend and Change email. Legacy access is unaffected throughout.

  **Resend and Change on /setup (found in S1.5):** Supabase's resend for phone\_change and email\_change sends nothing when the account has no current number or address, so Resend on /setup repeats `updateUser` with the pending value. Supabase refuses a change within 60 seconds of the last send; the screen shows the same countdown pattern as Resend ("You can change it again in {n}s."), interim pending design review.

  **Phone-only account with no profile row:** it is asked for the email first, because finalize can create the row only once an email is confirmed. After the production backfill gives every existing user a row, this case should not arise.
- The before-user-created hook does not fire for `updateUser`, so this cannot create a user.

## Returning sign-in

One screen at `/sign-in` handles Google, email and phone. Email and phone on it never create an account; an unknown identifier is offered account creation instead.

### Screen: Welcome back

- Heading: **Welcome back**
- Button: **Continue with Google**
- Divider: or
- Field: **Email or mobile number**
- Button: **Continue**
- Footer: New to Daali? **Create an account** (links to `/start`)

The field decides the method. Input containing `@` is an email. Input that normalizes to a valid phone number (US default, stored as E.164) is a phone. Anything else shows: Enter an email address or a mobile number.

### Email

1. Calls `signInWithOtp({ email, options: { shouldCreateUser: false, captchaToken } })`.
2. Shows **Check your email** with a six-digit code field and **Resend** after 60 seconds.
3. The email holds a **Continue to Daali** link and the same code. The link opens `/auth/confirm`, whose button calls `verifyOtp({ token_hash, type: 'email' })`.
4. If the person opens the link on another device, they're signed in there. The waiting screen keeps the code field so they can sign in on this device too.

### Phone

1. Calls `signInWithOtp({ phone, options: { shouldCreateUser: false, captchaToken } })`, sent through Twilio Verify.
2. Shows **Enter the code we texted to {phone}**, with **Resend** after 30 seconds.
3. Calls `verifyOtp({ phone, token, type: 'sms' })`.

### Google

The same call as on Get started. An existing user with that verified email is signed in, with Google linked automatically if it wasn't already. A new email creates the account and continues to `/setup`, exactly as if the person had used Get started.

### Unknown email or number

`shouldCreateUser: false` returns an error for an identifier with no account. The screen offers to create one:

- **Unknown email:** We don't have a Daali account for {email} yet. **Create an account** sends the Get started link to that address in one tap, then shows Check your email. **Try a different email or number** returns to the field. Below both, the screen says: Signed in with your phone number before? Use your number instead. Tapping it returns to the field, ready for a mobile number, so an existing phone-only organizer reaches their original account instead of creating a second one (amended Oct 10).
- **Unknown phone:** We don't have a Daali account for that number. Create one with your email and you'll add this number during setup. **Create an account** opens `/start`.

This tells someone whether an identifier has an account, which is normal for an open-signup product.

### After sign-in

Every successful sign-in goes through the post-auth gate. A `next` parameter is honored only for allowlisted internal paths, under the rules in that section.

## Identity rules

A Daali account is one Supabase user id, and every way of signing in resolves to that id.

| Method | How it joins the account | How it's verified |
| --- | --- | --- |
| Google | Creates the account, or links automatically to an existing user with the same verified email | Google's verified email |
| Email | Google's email, or the Get started magic link | Google, or the magic link or code |
| Phone | `updateUser({ phone })` at setup | `phone_change` SMS code |

Rules:

- **Only two things create a user:** Google, and the Get started email link. Phone never does, and the sign-in email never does.
- **One account per phone number.** If `updateUser({ phone })` fails because another user has that number, show: That number is already on another Daali account. Nothing is moved or merged.
- **One account per email.** Supabase enforces it. On Get started, an existing email simply signs in.

  **Adding an email to an existing account.** Only through /setup with `updateUser({ email })`, confirmed by its code or link. Same user id. If another account holds the email, nothing changes on either (amended Oct 10).
- **Automatic linking only on verified emails.** That is why `mailer_autoconfirm` must be off before Google is enabled (Configuration). With it on, an unproven email is treated as verified, and a Google sign-in could link into an account someone else created with that address.
- **No merging in this release.** If a person ends up with two accounts, that's handled manually. There is no self-serve merge.
- **Changing or removing methods** after setup is out of scope here. It belongs to account settings, a later phase.

## Post-auth gate and routing

After any successful authentication there is exactly one question: is this Daali account set up? Missing name or unverified phone goes to `/setup`; complete goes to Your Daali at `/home`.

### One resolver

A single server function, `resolveOrganizerState(user)`, returns one of four states. Every page and route that needs to know uses it; nothing re-derives the answer.

| State | Condition | Where they go |
| --- | --- | --- |
| `SIGNED_OUT` | No user, or an anonymous user | `/sign-in` |
| `NO_PROFILE` | Signed in with a confirmed email but no `organizer_profiles` row | Finalize creates the row, then they're `SETUP_INCOMPLETE` |
| `SETUP_INCOMPLETE` | Profile exists, but `display_name` is empty, `phone_confirmed_at` is null, or `email_confirmed_at` is null (existing accounts created without an email; new accounts always have one) | `/setup` |
| `COMPLETE` | Profile with a name, and a confirmed phone | `/home`, or an allowlisted `next` |

The resolver reads only the Supabase user and `organizer_profiles`. It never reads `hosts`, credits, `paymentPreference`, Stripe fields or boards.

### `/setup` shows only what's missing

An existing user with a confirmed phone but no name sees only the name field. One with a name but no phone sees only the phone fields. This matters for current users: almost all have a null name today, and phone-OTP users already have a confirmed phone.

/setup carries a Sign out link (amended Oct 10), so a person who stops partway is never stuck in a signed-in session they cannot leave. No frame exists; interim pending design review.

An existing account with no confirmed email also sees the email step (Existing accounts without an email), and is not COMPLETE until it is verified. Legacy /host pages stay reachable while it is missing.

### Where the gate runs

- **New routes** (`/home`, `/setup`): the resolver runs in the page loader. `/home` requires `COMPLETE`.
- **Middleware:** unauthenticated or anonymous requests to `/home`, `/setup` and `/host/*` go to `/sign-in?next=…`. An anonymous user counts as signed out. The `/host` match is fixed to `/host` or `/host/…`, so it no longer catches paths like `/hostX`.
- **Legacy `/host/*` pages are not gated on setup in this release.** Any non-anonymous signed-in user reaches them exactly as today, including existing users with no display name or no confirmed phone. Only anonymous users are blocked. Bringing legacy pages under the setup gate waits until existing-user migration is verified.

### Allowlisted `next`

`next` is honored only for these internal paths. A next of /home requires a complete profile. A next under /host or /invite requires only a non-anonymous signed-in user, so an existing organizer with an incomplete profile can still follow a link straight to their fundraiser:

- `/home`
- `/host/boards/[id]` and paths beneath it, which is the existing fundraiser management surface
- `/invite/[token]`, the existing board-manager invite

Anything else falls back to `/home`. The same validator replaces `safeReturnPath` and the unvalidated `next` in `auth/callback`.

### Retired destinations

No auth path sends anyone to `/host/boards`, `/host/payment-setup` or `/host/stripe`. `/host` itself redirects to `/home` instead of `/host/boards`. `/login` permanently redirects to `/sign-in`, keeping `next`.

## Data model

One new table carries this work, `organizer_profiles`. No existing table gains or loses a column, and no existing row is rewritten. The dormant `invite_codes` table is left as is; nothing reads or writes it, and removing it is a separate cleanup.

### `organizer_profiles`

| Column | Type | Notes |
| --- | --- | --- |
| `user_id` | text, pk | Supabase user id. No foreign key, matching every other user-id column in the repo: no table references the `auth` schema, and the test database has none (amended Oct 8). |
| `display_name` | text, null | "What should we call you?" Prefilled from Google; otherwise null until setup. |
| `avatar_url` | text, null | From Google's picture when available. Otherwise initials are shown. |
| `legacy_boards_enabled` | boolean | Default `false`. The Game Day entitlement: allows creating Game Day boards and shows the Legacy Boards link. Granted by a Game Day access link or by the backfill (Game Day access). Renamed from `legacy_boards_visible` in S1.7 (Oct 11). |
| `created_via` | text | `SIGNUP` or `BACKFILL`. |
| `created_at`, `updated_at` | timestamptz |  |

No grants to `authenticated` or `anon`. All access is server-side, matching the existing `secure_data_api.sql` posture.

The row's existence is what makes a Supabase user a Daali account. Phone and email are not copied here; `auth.users` is their source of truth, including `phone_confirmed_at`.

### Backfill for existing users

A one-time script creates an `organizer_profiles` row, `created_via = BACKFILL`, for each existing non-anonymous auth user. It copies `Host.name` into `display_name` where one exists, and sets `legacy_boards_enabled = true` for every account whose Host owns at least one Game Day board, so no current Game Day user loses access (2 accounts in production on Oct 11). No other account gets the flag from the backfill; everyone else receives Game Day through an access link (amended Oct 11).

The Game Day part of the backfill runs once, at the L2 release, before the release is reachable by users. Rerunning it is safe: it only inserts `organizer_profiles` rows that are missing and never updates an existing row, so it cannot restore Game Day access an administrator removed and cannot clear access granted by a link. If it finds a Game Day owner who already has a row without the flag, it changes nothing and reports the count, for the administrator to resolve with an access link (amended Oct 11).

The script reads `hosts` and writes only `organizer_profiles`. Because production user counts are unverified, it runs in dry-run mode first and prints the list for your review.

### Organizer attribution on public pages

`organizerAttribution` keeps its current order in this release: board label, then `Host.name`, then nothing. Switching it to read `organizer_profiles.display_name` would make a name appear on live fundraiser pages that show none today, so that is a separate change.

## Your Daali and the organizer-item read model

Your Daali at `/home` lists everything an organizer runs as common organizer items, and it gets them only from a read-model layer that hides where each item is stored. Today that layer projects fundraiser-type Boards as Fundraisers. Later it returns standalone Fundraiser and Event records, and Your Daali doesn't change.

### What ships on `/home`

1. **Signed-in shell:** Daali wordmark on the left; organizer avatar, display name and "Organizer" on the right, opening a small menu: Organizer profile, Settings, Legacy Boards (entitled users only), Sign out. Visuals follow Daali UI System 1.0 (Lora headings, Inter body) as defined in the Product Flow Spec.
2. **Greeting:** Hi, {first name}. The first word of the display name, per the Product Flow Spec, which governs `/home` content (aligned Oct 11).
3. **Your items:** one card per organizer item, newest activity first. Each card shows the type chip (Fundraiser), title, status pill, last-updated date, **Manage**, and **View page** when there's a public URL.
4. **What are you organizing?** The full home from the Product Flow Spec in every state: AI card, organizer type cards, then Your organizing or its empty state. Only organizer types whose creation flow is live in production are shown. No Coming soon, no dead-end action, and Fundraiser never falls back to legacy Board creation.
5. **Legacy Boards entry:** an item in the avatar menu, rendered only when `legacy_boards_enabled` is true. It opens the existing Board list and is never presented as an organizer type.

No copy on `/home` says Board, Game Day, squares, credits or Host, except the Legacy Boards link itself for entitled users.

### The item shape

```
type OrganizerItem = {
  id: string              // stable and namespaced, e.g. "fundraiser:legacy:<boardId>"
  type: 'FUNDRAISER' | 'EVENT' | 'RAFFLE'
  title: string
  status: 'DRAFT' | 'LIVE' | 'CLOSED'
  role: 'OWNER' | 'COLLABORATOR'
  publicUrl: string | null
  manageUrl: string
  createdAt: Date
  updatedAt: Date
  source: { kind: 'LEGACY_BOARD'; id: string }  // internal only, never rendered
}
```

Your Daali components receive `OrganizerItem[]` and nothing else. They never import Board types, Prisma Board queries or Board status values.

### The aggregator

`listOrganizerItems(userId)` calls each registered provider, merges the results, and sorts by `updatedAt`. This release registers one provider.

**`legacyFundraiserProvider`** reads boards where `boardType = 'fundraiser'` and the user is the owner (`Host.supabaseUserId = userId`) or an accepted collaborator. It maps them as follows:

| OrganizerItem field | From the Board |
| --- | --- |
| `title` | board title |
| `status` | `open` → LIVE; `closing`, `closed` → CLOSED; `pending_payment` → DRAFT; `expired` → not listed |
| `publicUrl` | `/board/[slug]` |
| `manageUrl` | `/host/boards/[id]`, the existing management surface |
| `createdAt`, `updatedAt` | the board's own timestamps |

Game Day boards (`boardType = 'game'`) are never projected. They're reachable only through the Legacy Boards entry.

### Rules for the bridge

- **Read-only.** The provider runs selects only. It never writes, migrates, backfills or touches a Board, square, contribution or Host.
- **Owning is enough.** A fundraiser owner sees it whether or not they have `legacy_boards_enabled`.
- **Management is unchanged.** **Manage** goes to the existing `/host/boards/[id]` surface until that surface is replaced separately.
- **Replaceable.** When the Fundraiser root exists, a `fundraiserProvider` is registered and `legacyFundraiserProvider` is retired. The item shape and `/home` stay the same.
- **Unknown statuses** are omitted from the list and raise an error event in monitoring. Known statuses map only as the table above shows. An unrecognized state is never shown as CLOSED or as any other status, because the provider doesn't know what it means.

## Legacy isolation

The legacy Board product keeps working exactly as it does today; this work only blocks anonymous users from it. Existing authenticated users reach it as today, whether or not their Daali profile is complete.

### Host creation guard

`getHostOrNull` (`auth.ts:38`) lazily creates a Host on any authenticated request that needs one. Host is an internal record the legacy Board and collaborator code depends on, not a user-facing organizer type. One change, inside the function before the upsert:

- If `user.is_anonymous` is true, return null. Never upsert.

Every non-anonymous user behaves as today: an existing Host is returned, and a missing one is created as before. Profile completeness is deliberately not checked here, so existing users with no name or phone keep managing their fundraisers. The function's return type and every caller stay the same; callers already handle null as signed out.

**Corrected Oct 11 — the Oct 10 Host creation guard is withdrawn.** New Daali accounts are not blocked from having a Host. Board Credits were removed from the product on Sep 16 (commit `f7b472c`); the `board_credits` column is an inert leftover nobody reads, so credits are not a reason to restrict Host creation. What keeps new accounts out of the legacy Board experience is routing: no sign-in, setup or navigation path sends anyone to a legacy page (T16), and `/host` redirects to `/home`. A new account reaches a legacy page only through a direct link — a Board-manager invite, a management link, or a typed address — and a Host is created then if the page needs one. Board-manager invites work for new and existing accounts exactly as today; ownership, permissions and invitation behavior are unchanged. Game Day creation by typed address is the remaining exposure, closed by the Game Day check (L2), a launch blocker.

The upsert in `auth/callback/route.ts:19` is removed. The callback resolves identity, runs finalize when it applies, and redirects. It creates nothing in `hosts`.

### What stays exactly as it is

- `boardCreationGate`, `/host/payment-setup`, `/host/stripe`, `/host/stripe/return`, and the Connect Stripe banner
- `POST /api/boards`, except the Game Day entitlement check defined in L2, and every Board, square, contribution, tender, payout and credit write
- Board Credits: removed from the product on Sep 16 (`f7b472c`). The inert `board_credits` column, the dead `credit_purchase` webhook branch and the historical `credit_transactions` table are left as they are; finishing that cleanup is a separate legacy change.
- Board-manager invites (`/invite/[token]`, `acceptInvite`)
- Public board pages, `organizerAttribution`, and cron jobs

None of these is reached as part of auth.

### Game Day access (amended Oct 11)

Game Day is part of Daali but is never advertised: it does not appear on the landing page, `/home`, sign-up or any organizer type list. It is available on request, through a link only Daali's administrator creates.

`legacy_boards_enabled` on `organizer_profiles` is the entitlement. It allows creating Game Day boards and shows the Legacy Boards item in the avatar menu.

**Enforcement (L2).** `POST /api/boards` rejects a board whose type resolves to `game` with 403 for accounts without the flag, and the board-type picker on `/host/boards/new` hides Game Day for them. The route treats a missing or unknown `boardType` as `game`; the check applies to that resolved type, and the default itself does not change. An account with no `organizer_profiles` row is treated as not entitled, so the production backfill must run before this ships. Existing Game Day boards, their public pages, their management and their payments stay exactly as they are. This is a Board write-path change and ships as its own reviewed commit.

**Access links.**

- **Created by the administrator only,** from a private page at `/admin/game-day`. Administrators are listed by Supabase user id in server configuration; the page is 404 to everyone else and never reads `hosts`.
- **One person, one use.** Each link is a random token; only its hash is stored. It works once and expires after 14 days if unused. The full link is shown once, when created, for the administrator to copy and send by any channel.
- **Redeeming.** The link opens `/gameday/[token]`. A signed-out visitor goes to `/sign-in?next=/gameday/[token]` and can create an account from there. A new or incomplete account goes through /setup carrying the link and returns to this page after the last setup step; the page itself still works for any signed-in account, whatever its setup state, when opened directly (decided Oct 12). A signed-in, non-anonymous account sees "Add Game Day to your Daali account" with one button; nothing happens on page load, because link scanners open links. Pressing it sets `legacy_boards_enabled = true` and marks the link used, in one transaction that succeeds only if the link is unused, unrevoked and unexpired. It then opens `/host/boards/new`. A used, expired or revoked link shows "This Game Day link can't be used. Ask the person who sent it for a new one." An account that already has access is sent straight to `/host/boards/new` and the link stays unused.
- **Administrator view.** Lists links with status (unused, used by whom and when, expired, revoked), revokes unused links, and removes Game Day access from an account. Removing access stops new Game Day boards; that account's existing boards are untouched.
- `/gameday/[token]` joins the allowlisted `next` paths and works whether or not setup is complete, like invites. `gameday` joins the vanity-path reserved words.

Every server action and endpoint that creates, lists or revokes access links, or removes Game Day access, checks on its own that the signed-in user is in `DAALI_ADMIN_USER_IDS`; protecting the page is not enough. Redeeming and revoking the same link are mutually exclusive: each is a single conditional update on an unused, unrevoked link, so whichever lands first wins. A revoked link grants nothing; a redeemed link is used and can no longer be revoked as unused (amended Oct 11).

Data: `daali_game_day_links` — id, `token_hash` (unique), `created_by_user_id`, `created_at`, `expires_at`, `used_by_user_id`, `used_at`, `revoked_at` — with the same containment as other Daali tables. The flag rename and this table are one migration.

## Configuration prerequisites

Supabase and Twilio settings change in a fixed order, dev first and then production, because CAPTCHA and the hook break the current `/login` if they go live before the new UI does. Domain settings are in Moving to daali.app.

| Step | Setting | Prod today | Target | Why the order matters |
| --- | --- | --- | --- | --- |
| 1 | Dev mirrors prod: phone on, Twilio Verify (own dev service SID), email on | Dev: phone off, Twilio Messaging | Same as prod | Phone attach must be tested on the Verify path. Messaging hits the rejected 10DLC campaign. |
| 2 | `mailer_autoconfirm` | `true` | `false` | Must be off before Google. Users created through direct `/signup` while it was on have unproven emails (O5). |
| 3 | Email templates (Magic Link, Confirm Signup and Change Email Address) | Unverified | `token_hash` link to `/auth/confirm` plus `{{ .Token }}` six-digit code | Needed before any magic link ships. |
| 4 | Email OTP expiry | Unverified (Supabase default 1 hour) | 10 minutes | Matches the code copy. |
| 5 | Redirect URL allowlist | Unverified | `/auth/callback` and `/auth/confirm` on daali.app, beta.daali.app (until the redirect is verified), dev and localhost | Callbacks fail without it. |
| 6 | Automatic identity linking | Unverified | on | Lets an existing user sign in with Google without a duplicate account. |
| 7 | Anonymous sign-ins | off | off | Stays off; the hook also rejects anonymous creation. |
| 7a | Phone confirmations (enable\_confirmations) | Unverified | on | Found in S1.5 (Oct 10): with it off, updateUser({ phone }) attaches and confirms a number with no code, so anyone could claim any number. Must be on in every hosted project before /setup ships, alongside step 1. |
| 8 | Twilio Verify Fraud Guard and geo permissions | Unverified | Fraud Guard on, US only | Required before open signup can trigger texts. |
| 9 | CAPTCHA (Turnstile) | Unverified | on | Applies to every Supabase auth endpoint. Turn on only after `/sign-in`, `/start` and `/setup` send captcha tokens, or the old `/login` stops working. |
| 10 | `before-user-created` hook | Unverified | on | Rejects users with no email and anonymous users. Turn on with or after the new UI. |
| 11 | Google provider | off | on | Last, after steps 2, 5, 6 and 10, and after the OAuth client is set up for daali.app. |

`disable_signup` stays `false`. Signup is open.

## Removals and cleanup

Each removal below is limited to auth and navigation; none touches a Board payment path.

| Item | Location (from the audit) | Change |
| --- | --- | --- |
| Phone / Email tabs on `/login` | `login/page.tsx:154-173` | Page replaced by `/sign-in`; `/login` redirects there |
| `shouldCreateUser: true` and the phone default | `login/page.tsx:35-40` | Removed with the page. Sign-in calls pass `false`; only the Get started email passes `true`. |
| Dead OTP route | `api/auth/verify-otp/route.ts` | Deleted |
| Host upsert in callback | `auth/callback/route.ts:19` | Removed |
| Unvalidated `next` in callback | `auth/callback/route.ts:8, :35` | Uses the shared allowlist validator |
| `safeReturnPath` fallback to `/host/boards` | `login-return.ts:20-22` | Replaced by the shared validator, fallback `/home` |
| `/host` to `/host/boards` redirect | `host/page.tsx:4` | Redirects to `/home` |
| `startsWith("/host")` match | `middleware.ts:33-37` | Matches `/host` and `/host/…` only; login target becomes `/sign-in` |
| Host email in nav | `host/layout.tsx:18` | Shows `display_name`; may hold a phone or UUID today |
| Host / New Host wording | New Daali screens | Not used; Organizer and Daali account instead |

Also add a test for `acceptInvite` returning `already-collaborator` without a rollback (`board-invites.ts:149-155`). The test is worth having because the audit found the gap; it doesn't change `acceptInvite`.

## Edge cases and error states

Every failure ends on a screen with a next step, never a dead end or a raw error.

| Case | What happens | Copy |
| --- | --- | --- |
| Get started with an email that has an account | Same link signs them in | Check your email (no error) |
| Get started with Google that has an account | Signed in; Google linked if needed | Straight through the post-auth gate |
| Unknown email on `/sign-in` | Nothing created | We don't have a Daali account for {email} yet. **Create an account** · **Try a different email or number** · Signed in with your phone number before? Use your number instead. |
| Unknown phone on `/sign-in` | Nothing created | We don't have a Daali account for that number. Create one with your email and you'll add this number during setup. **Create an account** |
| Direct API signup with only a phone | Hook rejects | No UI path reaches this |
| Wrong or expired code | Field error, stays on screen | That code didn't work. Check it or send a new one. |
| Magic link expired or already used | `/auth/confirm` shows an error | This link has expired. **Send a new link** |
| Magic link opened on another device | Signed in on that device | The waiting screen keeps the code field for this device |
| Phone already on another account | Not attached | That number is already on another Daali account. |
| Non-US phone number at setup | Verify refuses (geo permissions) | Daali can only text US numbers right now. |
| SMS send fails or is rate limited | Stays on setup | We couldn't send a code to that number. Check it and try again. |
| Resend tapped early | Button disabled with countdown | Resend in {n}s |
| CAPTCHA fails | Request not sent | Please try again. |
| Visit `/setup` when complete | Redirect | `/home` |
| Visit `/home` when incomplete | Redirect | `/setup` |
| Old beta.daali.app link | Permanent redirect | Same path on daali.app |

## Acceptance tests

The work is done when every test below passes on dev, and the gate and isolation tests pass again on production after the config steps.

### Account creation

- [ ] T1. Get started with a new email creates exactly one Supabase user and one organizer profile. Supabase may create an unconfirmed Auth user when the email is sent; the organizer profile is created only after the link or code is verified, never before (amended Oct 10).
- [ ] T2. Get started with Google and a new Google account creates one user with a confirmed email and one profile.
- [ ] T3. Direct `/auth/v1/otp` with only a phone and `create_user: true` is rejected by the hook; no user appears.
- [ ] T4. Sign-in email and phone for unknown identifiers create nothing and show the create-an-account state.
- [ ] T5. Get started with an existing email or Google account signs in; no second user appears.
- [ ] T6. Finalize run twice for the same user leaves exactly one profile.
- [ ] T7. With CAPTCHA on, an auth request without a valid token is refused.
- [ ] T8. A non-US number at setup is refused by Verify with the correct message.

### Identity

- [ ] T9. Get started → Google → setup → phone: one user id with Google identity, confirmed email, confirmed phone, and a profile with a name.
- [ ] T10. Get started → email link opened on another device: that device is signed in and finalize runs once; the original device keeps its code field and completes sign-in when the code is entered. In the same browser, the waiting screen continues on its own. No cross-device session handoff exists (amended Oct 10).
- [ ] T11. That user then signs in by phone, by email and by Google, and all three resolve to the same user id.
- [ ] T12. Attaching a phone already on another account fails with the correct message and changes neither account.
- [ ] T13. No setup code path calls `signInWithOtp({ phone })`.

  T25. An existing phone-only account adds an email at /setup: the email attaches only after its code or link is verified; afterwards the user id, Host row, Board ownership, collaborator rows and legacy management pages are unchanged, and the account can sign in by email and by phone to the same user id.

  T26. Adding an email that belongs to another account fails with "That email is already on another Daali account." and changes neither account.

  T27. Interrupted email step: leaving after the code is sent, then returning, shows the pending address with Resend and Change email; finishing later attaches it to the same user; legacy access works throughout.

  T28. On /sign-in, a phone-only organizer entering an email sees the phone-number hint; following it signs them in by phone to their original account, and no second user is created.

### Gate and routing

- [ ] T14. Each `resolveOrganizerState` state redirects as specified, including `/setup` showing only missing fields.
- [ ] T15. `next` outside the allowlist falls back to `/home`; a `next` of `/home` requires a complete profile, and a `next` under `/host` works for any non-anonymous signed-in user.
- [ ] T16. No auth path redirects to `/host/boards`, `/host/payment-setup` or `/host/stripe`.

  **Release blocker (corrected Oct 11):** no sign-in, setup or navigation path may send a new Daali account into the legacy Board experience (T16), and the Game Day check (L2) must ship before release. A Host row created when a new account accepts a Board-manager invite or opens a management link is expected and acceptable.

### Legacy isolation

- [ ] T17. An anonymous user requesting `/host/*` or any API that calls `getHostOrNull` gets no Host row.

  T17b. A brand-new Daali account opens a Board-manager invite, signs in, accepts it, receives the grant, and opens the fundraiser's management page (200); ownership and other collaborators are unchanged; there is no redirect loop. An existing account's invite flow is unchanged.
- [ ] T18. A non-anonymous user with an incomplete profile reaches `/host/*` exactly as today, with no redirect to `/setup`.
- [ ] T19. An existing complete Host user's boards, gates, payments and management pages behave identically before and after; compare a Game Day board and a fundraiser board.
- [ ] T19b. An existing authenticated Host user with a null display name and/or no confirmed phone can still reach and manage their existing fundraiser through its current legacy URL after deployment. No payment, contribution, Stripe or management behavior changes.
- [ ] T20. The diff touches no file under Board payment, checkout, tender, payout, Stripe, cron or credit code.

### Your Daali

- [ ] T21. A fundraiser owner without `legacy_boards_enabled` sees their fundraiser on `/home` as a Fundraiser, and **Manage** opens the existing surface.
- [ ] T22. Game Day boards never appear as items; the Legacy Boards link appears only with the flag.
- [ ] T23. Rendering `/home` issues no writes and creates no Host; board row counts and a hash of every board row's content are unchanged (boards have no `updated_at` column; amended Oct 11).
- [ ] T24. `/home` contains no Board, Game Day, squares, credits or Host wording for a user without the flag.

  T29. Without `legacy_boards_enabled`, `POST /api/boards` with `boardType = 'game'` returns 403 and creates nothing, and the `/host/boards/new` picker offers no Game Day option; an account with no profile row is refused the same way. With the flag, Game Day creation behaves exactly as today. Fundraiser creation, existing Game Day boards and their management are unchanged.

  T30. A Game Day link redeemed by a signed-out new person: the link survives sign-in, account creation, email confirmation and every setup step, the confirm page appears, and pressing it grants access and opens `/host/boards/new`. Opening the link does nothing until the button is pressed.

  T31. A used, expired or revoked link grants nothing and shows its message; two accounts redeeming one link at once, exactly one succeeds; a redemption racing the administrator's revocation of the same link, exactly one wins (revocation first: no access granted; redemption first: the link is used and cannot be revoked as unused); an account that already has access leaves the link unused.

  T32. `/admin/game-day` returns 404 for anyone not listed as an administrator, and each create, list, revoke and remove-access action or endpoint refuses a non-administrator called directly; the full link is shown once and only its hash is stored; revoking and removing access work. After access is removed, both the picker and `POST /api/boards` refuse new Game Day boards, while that account's existing boards, their management, public pages and payments keep working.

  T33. The backfill grants the flag to exactly the accounts that own a Game Day board and to no one else; a rerun changes nothing, does not restore access an administrator removed and does not clear access granted by a link.

## Moving to daali.app

The app moves from beta.daali.app to daali.app as part of this work, and every existing beta.daali.app link keeps working through a permanent redirect. Fundraiser links, QR codes and emails already sent all point at beta, so the redirect stays in place indefinitely.

### What changes

| Where | Change |
| --- | --- |
| Hosting and DNS | Add daali.app as the primary domain with TLS; `www.daali.app` redirects to `daali.app` |
| beta.daali.app | Permanent redirect (308) of every path and query string to the same path on daali.app |
| App config | Site URL environment variables, any hard-coded `beta.daali.app` in code, Open Graph tags, and links inside emails and SMS |
| Supabase | Site URL and redirect allowlist on daali.app; email templates point at daali.app |
| Google OAuth | OAuth client and consent screen set up for daali.app, with home page, privacy policy and terms links |
| Stripe | Connect return and refresh URLs, checkout success and cancel URLs, and webhook endpoints. Configuration only; no payment logic changes. |
| Twilio | Any status-callback or webhook URLs |
| Email sending | Sender domain and DNS records (SPF, DKIM) if emails will come from daali.app |

### Order

1. Find every reference to beta.daali.app in code and in each dashboard (O4).
2. Bring daali.app up alongside beta. Add daali.app to every allowlist while keeping the beta entries.
3. Switch the site URL, emails and integrations to daali.app.
4. Turn on the beta redirect. Remove beta allowlist entries only after the redirect is verified.

Sessions are tied to the domain, so anyone signed in on beta signs in once more on daali.app. That's acceptable before launch, because the only signed-in users are existing ones.

### Done when

- [ ] M1. A beta.daali.app fundraiser link, with its path and query string, lands on the same page at daali.app.
- [ ] M2. Sign-in by Google, email link and SMS code all complete on daali.app.
- [ ] M3. A test contribution and a Stripe Connect return complete on daali.app, and webhooks arrive.
- [ ] M4. A search of code and config finds no remaining beta.daali.app reference except the redirect itself.

## Launch readiness

daali.app is not advertised until every item here is done. Signup works from the day auth ships; these items decide when people are invited to use it.

| # | Blocker | Why |
| --- | --- | --- |
| L1 | This spec complete, with every acceptance test passing on production | The account system is the front door |
| L2 | Game Day check: `POST /api/boards` and the `/host/boards/new` picker refuse Game Day without `legacy_boards_enabled`; access is granted only by administrator-created single-use links or the backfill (Game Day access) | With open signup, any new account could otherwise create a squares board by URL |
| L3 | Domain move done and verified (M1 to M4) | Advertising should point at the final address |
| L4 | Every organizer type shown on `/home` leads to a live creation flow; types not yet buildable are hidden, never Coming soon (O3) | A new organizer's first tap can't be a dead end |
| L5 | The landing page only shows what works | It currently shows events, volunteers and raffles; each must exist at launch or come off the page |
| L6 | New organizers never see credits | Done: Board Credits were removed on Sep 16 (`f7b472c`); nothing shows or reads a balance. Confirm no credit wording remains on new screens (T24) |
| L7 | Privacy policy and terms pages on daali.app | Open signup and the Google consent screen both need them |

## Build sequence and open items

Build in this order so guards exist before new users can arrive, and the new UI exists before CAPTCHA and the hook switch on.

1. **Close the unverified items** (O1, O2, O4) from the production dashboards. You own this step.
2. **Dev config** steps 1 and 2: mirror prod, `mailer_autoconfirm` off.
3. **Schema:** `organizer_profiles`. Write the backfill script; run it in dry-run mode only.
4. **Guards:** `resolveOrganizerState`, the `getHostOrNull` guard, callback cleanup, middleware fix, shared `next` validator.
5. **Account screens:** `/start`, `/sign-in`, `/auth/confirm`, email templates, finalize, `/login` redirect.
6. **Setup:** `/setup` and phone attach.
7. **Your Daali:** `/home`, the aggregator and `legacyFundraiserProvider`.
8. **Game Day check (L2)**, as its own reviewed change.
9. **Dev config** steps 3 to 11, then the full acceptance suite.
10. **Domain move**, in the order above.
11. **Production:** review and run the backfill, apply config steps in order, deploy, then re-run the acceptance suite.
12. **Launch readiness** L1 to L7 checked off. Then advertise.

Each step is its own commit with a report before the next one starts.

### Open items

| # | Item | Needed by |
| --- | --- | --- |
| O1 | Production dashboard: linking toggles, configured hooks, email templates, redirect allowlist, Twilio Verify service and Fraud Guard, auth user counts by provider | Step 1 |
| O2 | Resolved Oct 11: there is no single legacy tester. The backfill grants Game Day to every account that owns a Game Day board; anyone else, including the administrator's own account, gets it through an access link. | Step 3 |
| O3 | Resolved Oct 4: "What are you organizing?" shows only organizer types whose creation flow is live in production. Start a fundraiser never opens or falls back to legacy Board creation, Event is never shown as Coming soon, and Fundraiser and Raffle stay hidden until their standalone roots are buildable. Legacy Boards are reached only through the entitled-user Legacy Boards entry. Behavior is governed by the Daali Product Flow Spec. | Step 7 |
| O4 | Every beta.daali.app reference: code, Supabase, Google, Stripe, Twilio, DNS and email sending | Step 1 |
| O5 | Password signups: how many production users signed up with a password while `mailer_autoconfirm` was on (and whether they must re-verify before Google can link to them), and whether the `before-user-created` payload can identify a password signup so the hook can reject it | Step 9 |
| O6 | Switch `organizerAttribution` to read `organizer_profiles.display_name` on live public pages | After this work |
