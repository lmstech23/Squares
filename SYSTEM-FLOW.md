# Squares — System Flow Document

Last updated: Mar 2, 2026

This is the single source of truth for how the application works. Every screen, every redirect, every conditional. If it's not in this document, it doesn't exist. If this document says one thing and the code says another, fix the code.

---

## Quick Summary (Plain English)

**Onboarding:** New host enters phone or email, gets a code, enters it. First time only, they see a screen asking how players will pay — Cash or Card. Cash hosts go straight to their dashboard. Card hosts go through Stripe setup first. This screen never shows again.

**Dashboard:** Shows their boards, credit balance, and a "New Board" button that's always tappable. Cash hosts see an optional Stripe banner at the top until they connect. Credits show for new hosts (starts at 2). Platform owner sees "Unlimited."

**Board Creation:** Host fills out a short form (game, teams, price, payout split). Cash hosts get cash mode auto-enabled with a random PIN. If the host has credits, the board goes live immediately. If no credits, the board is saved as a draft and they're sent to buy more ($19 for 1, $45 for 3). Unpaid drafts expire after 48 hours.

**Board Management:** Host sees their grid, fill progress, share link. They can close the board (triggers number randomization), toggle cash mode, reserve squares for cash players, confirm cash received, enter scores, and see winners.

**Player Experience:** Player opens a link, sees the grid, taps a square. They only see payment options that work — card if Stripe is set up, cash if cash mode is on, both if both exist. No mention of what's missing. Card goes through Stripe. Cash requires the host's PIN. Pending squares are tappable — players can resume an interrupted checkout by entering the email they used.

**Payment Processing:** Stripe webhooks handle payment confirmations and expirations. A cron job runs every 5 minutes to clean up abandoned checkouts and unconfirmed cash reservations.

**Database Fields:** Key fields on Host (payment preference, credits, Stripe status), Board (status, cash mode, PIN), and Square (payment status, payment method).

**Rules:** Stripe is optional. Cash is first-class. Players see what's available. Board creation is never blocked. Document first, code second.

---

## 1. Host Onboarding (New User)

### 1A. Authentication

**Page:** `/login`

1. Host opens the app
2. Two options: **Sign In** (existing host) or **New Host** (with invite code)
3. Host enters phone number or email
4. Taps "Send sign-in code"
5. Receives OTP via SMS or email
6. Enters 6-digit OTP
7. System verifies OTP via `/api/auth/verify-otp`
8. On success: Host record is created (upsert) with `boardCredits: 2`
9. Redirect → `/host/boards`

### 1B. Payment Method Choice (First Visit Only)

**Page:** `/host/payment-setup`

**Trigger:** When a host reaches the boards page and has never chosen a payment method, they're redirected here first.

**Screen: "How will your players pay?"**

**Option 1: Cash**
- Label: "I'll collect cash in person"
- Action: Sets `host.paymentPreference = "cash"` in the database
- Redirect → `/host/boards`
- Result: Host lands on the board list. Stripe banner shows at top as optional. Cash mode will be auto-enabled on every board they create.

**Option 2: Card (Stripe)**
- Label: "Card payments via Stripe"
- Action: Sets `host.paymentPreference = "stripe"` in the database
- Redirect → `/host/stripe`
- Result: Host enters Stripe Connect Express onboarding. After completion → redirect to `/host/boards`.

**This screen only appears once.** Once `paymentPreference` is set, the host never sees it again.

### 1C. Returning Host (Has Payment Preference Set)

**Page:** `/host/boards`

**What happens on page load:**
1. Not logged in → redirect to login
2. No payment preference set yet → redirect to the payment choice screen
3. Host chose Stripe but hasn't started Stripe setup → redirect to Stripe setup
4. Host chose Stripe, started setup but didn't finish → redirect to Stripe setup to resume
5. Everything else (cash hosts, or Stripe hosts who finished setup) → show the boards page

Cash hosts always skip Stripe checks entirely and land on the boards page immediately.

---

## 2. Host Dashboard

**Page:** `/host/boards`

### What the Host Sees

**Credit Badge:**
- Credits > 0: "Board Credits: X" (green number)
- Credits = 0: "You've used your free boards. Purchase more to continue hosting."
- Platform owner: "Unlimited"

**Stripe Banner (cash hosts only):**
- "Connect Stripe to accept card payments — Optional, you can still run cash-only boards without Stripe."
- Button: "Connect Stripe"
- Visible until host connects Stripe. Does NOT block anything.

**Board List:**
- Active boards (open + closed): full cards with fill count and status
- Pending payment boards: yellow banner with "Complete Purchase" action
- Expired boards: collapsed section, grayed out, "Recreate Board" button

**"New Board" Button:**
- Always visible
- Always tappable
- Never grayed out
- The system decides the path (credit deduction vs. checkout redirect) server-side

---

## 3. Board Creation

**Page:** `/host/boards/new`

### 3A. Access Gate

When a host opens the "New Board" page, the system checks whether they can accept payments:

- **Host chose Cash during onboarding** — go straight to the form. No checks needed.
- **Host chose Stripe during onboarding AND finished Stripe setup** — go straight to the form.
- **Host chose Stripe during onboarding but has NOT finished Stripe setup** — redirect to the Stripe setup page. They need to finish so players can actually pay by card.

### 3B. The Form

Fields:
- Game name (required)
- Team names — row and column (required)
- Price per square in dollars (minimum $1)
- Host cut percentage (0–50%, default 20%)
- Period type (halves or quarters, default halves)
- Payout structure per period (must total 100%)

### 3C. What Happens on Submit

**API:** `POST /api/boards`

**Stripe gate in API:**
- Same check as the form page: if the host chose Stripe but hasn't finished setup, the API rejects the request. Cash hosts are never blocked.

**Auto cash mode (cash hosts):**
- If the host chose Cash during onboarding, every board they create automatically has cash mode turned on, a random 4-digit PIN generated, and the liability acknowledgment pre-accepted.

**Credit system paths:**

**Path 1: Platform Owner**
- Skip credit check entirely
- Create board with `status = open`
- No credit deduction

**Path 2: Host Has Credits (boardCredits > 0)**
- Deduct 1 credit (atomic, in same transaction)
- Create board with `status = open`
- Create 100 squares (`paymentStatus: open`)
- Generate slug
- Redirect to `/host/boards/[id]`
- Board is immediately shareable

**Path 3: Host Has No Credits (boardCredits = 0)**
- Check for existing `pending_payment` board — if one exists, redirect to complete that checkout first
- Create board with `status = pending_payment`
- Create 100 squares (board is NOT shareable)
- Set `pendingExpiresAt = NOW() + 48 hours`
- Redirect to credit purchase page
- Purchase options: 1 board ($19) or 3 boards ($45)

**On successful payment (webhook):**
- Add purchased credits to `host.boardCredits`
- Deduct 1 credit for the pending board
- Flip board: `pending_payment → open`
- Clear `pendingExpiresAt`
- Create `CreditTransaction` record

**On payment failure / abandonment:**
- Board stays `pending_payment`
- Auto-expires after 48 hours → status becomes `expired`
- Auto-deleted 7 days after expiration

---

## 4. Board Management (Host Dashboard)

**Page:** `/host/boards/[id]`

### What the Host Sees

- **Share link** with copy button (always accessible)
- **Fill tracker:** X / 100 squares filled (progress bar)
- **Pending indicator:** "X squares pending payment"
- **Grid** showing all 100 squares with status colors:
  - 🟢 Green = paid (card or confirmed cash)
  - 🟡 Yellow = pending (Stripe checkout in progress) or reserved_cash (awaiting host confirmation)
  - Empty/gray = open

### Close Board
- Button visible when `status = open`
- Confirmation required
- On close: Fisher-Yates shuffle assigns random 0–9 to rows and columns
- Status flips to `closed`
- If `reserved_cash` squares exist: prompt to confirm all, release unconfirmed, or cancel

### Cash Mode Toggle
- Toggle switch: "Enable Cash Reservations"
- PIN display: "PIN: XXXX — share with players paying cash"
- First enable requires liability acknowledgment
- Cash hosts have this auto-enabled on board creation

### Cash Reserve Panel (when cash mode is on)
- Host can reserve squares for players by name
- Host can confirm cash received (reserved_cash → paid)
- Host can release cash squares back to open

### Enter Scores (when board is closed)
- Enter scores per period for each team
- Winners auto-calculated based on last digit of score matching row/column numbers
- Payout amounts displayed

---

## 5. Player Experience

**Page:** `/board/[slug]` (public, no login required)

### What the Player Sees

- Game name, team names
- 10×10 grid with open/taken squares
- Fill progress: "X / 100 squares filled"
- "Pick a square. Numbers randomize when the board closes."
- Square price

### Tapping an Open Square

**What shows depends on what's available. No mention of what's missing.**

| Host has Stripe | Cash mode on | Player sees |
|----------------|-------------|-------------|
| ✅ | ✅ | Card/Cash tabs (both options) |
| ✅ | ❌ | Card form only (no tabs) |
| ❌ | ✅ | Cash form only (no tabs) |
| ❌ | ❌ | Board exists but no checkout renders — host needs to enable a payment method |

**Card flow (Stripe):**
1. Player enters name + email
2. Taps "Pay $X"
3. Redirected to Stripe Checkout
4. On success: square marked `paid`, redirect back with success banner
5. On abandonment: square stays `pending`, released by cron after expiration

**Cash flow:**
1. Player enters name + 4-digit PIN (from host)
2. Taps "Reserve with Cash"
3. Square marked `reserved_cash` (amber on grid)
4. Player sees: "Hand your cash to the host to confirm"
5. Host confirms on dashboard → square becomes `paid` (green)
6. Unconfirmed cash reservations auto-expire after TTL (default 20 min)

### Tapping a Pending Square

Pending squares (yellow) are tappable. Tapping one opens a sheet asking for the
email used at checkout. This allows players who left mid-checkout to resume without
losing their square. No account required — identity is verified by email matching only.

**Resume flow:**
1. Player taps a pending (yellow) square
2. Sheet slides up: "This square has an active checkout"
3. Player enters the email used when they originally claimed the square
4. Taps "Resume Checkout"
5. Backend validates email and session state via `POST /api/checkout/resume`
6. If valid: player is redirected to the existing Stripe Checkout URL (same session, no new lock)
7. If invalid or expired: player sees an appropriate message (see states below)

**Possible outcomes:**

| Outcome | What happened | Player sees |
|---------|--------------|-------------|
| Email matches, session live | Normal resume | Redirected to existing Stripe Checkout |
| Email does not match | Wrong email or someone else's square | "This square is reserved by someone else." |
| TTL expired (DB or Stripe) | Cron hasn't run yet | "This square just freed up — tap it again to claim it." Grid updates within seconds via polling. |
| Payment already completed | Webhook hasn't fired yet | Sheet closes. Square turns green within seconds via polling. |

**Security:**
- Email mismatch and "belongs to someone else" return the same generic message — no email enumeration possible.
- The TTL expiry check runs before the email check so timing differences cannot leak ownership.
- No rate limiting in V1. Rate limiting (5 attempts / squareId / 5 min) is on the post-launch backlog.

**What this does NOT affect:**
- `reserved_cash` squares are not resumable via this flow. Cash reservations have their own TTL and are managed by the host.
- The claim flow for open squares is unchanged.
- No schema changes. No new database fields.

### Closed Board View
- Row/column numbers visible
- Winners highlighted per period
- Payout amounts displayed
- No more square selection

---

## 6. Payment Processing

### Stripe Webhooks

**Endpoint:** `/api/webhooks/stripe`
**Format:** v2 thin events (Stripe API version 2026-01-28.clover)

**Events handled:**
- `v1.checkout.session.completed` → flip square `pending → paid`, create PaymentReference. Also handles credit purchase sessions.
- `v1.checkout.session.expired` → release square back to open
- `v1.account.updated` → sync `stripeChargesEnabled` and `stripePayoutsEnabled` to Host record

**Redirect fallback:** On return from Stripe Checkout, the board page server-side checks the session status and confirms payment if the webhook hasn't fired yet.

### Cron Cleanup

**Endpoint:** `/api/cron/release-expired`
**Schedule:** Every 5 minutes

**What it does:**
1. Release squares where `payment_status = pending` AND `checkout_expires_at < NOW()` (Stripe abandonment)
2. Release squares where `payment_status = reserved_cash` AND `checkout_expires_at < NOW()` (cash never confirmed)
3. Expire boards where `status = pending_payment` AND `pending_expires_at < NOW()`

All operations are idempotent.

---

## 7. Key Database Fields

### Host
| Field | Purpose |
|-------|---------|
| `paymentPreference` | `"cash"` or `"stripe"` — set during onboarding, drives all conditional logic |
| `boardCredits` | Integer, default 2. Decremented on board creation. |
| `stripeAccountId` | Stripe Connect account ID, null until onboarding |
| `stripeChargesEnabled` | Boolean, synced via webhook |
| `stripePayoutsEnabled` | Boolean, synced via webhook |

### Board
| Field | Purpose |
|-------|---------|
| `status` | `open`, `closed`, `pending_payment`, `expired` |
| `cashModeEnabled` | Boolean, auto-set for cash hosts |
| `cashPin` | 4-digit string, auto-generated for cash hosts |
| `cashLiabilityAccepted` | Boolean |
| `hostCutPercent` | 0–50, default 0 |
| `pendingExpiresAt` | Set on pending_payment boards, 48 hours |

### Square
| Field | Purpose |
|-------|---------|
| `paymentStatus` | `open`, `pending`, `paid`, `reserved_cash` |
| `paymentMethod` | `stripe` or `cash` |

---

## 8. Rules (Apply Everywhere)

1. **Stripe is optional.** It is never a prerequisite for board creation. Cash is a first-class payment method.
2. **The `paymentPreference` field drives all conditional logic.** Cash hosts skip Stripe checks. Stripe hosts get Stripe gates.
3. **Players see what's available.** No tabs when only one method exists. No error messages about what's missing.
4. **Cash mode auto-enables for cash hosts.** PIN auto-generates. No extra steps.
5. **Board creation is never blocked.** Credits determine the path (instant vs. pending_payment), not whether it's allowed.
6. **The host is the trust layer for cash.** No email required. PIN gates access. Host confirms receipt.
7. **Every change gets documented here first, then coded.**
8. **Before pushing ANY code change, check this document.** Walk through every section affected by the change. If the change would break any part of this flow — stop. Fix the approach first. This rule exists because on Feb 26, 2026, working code was destroyed by changes that ignored the existing flow. That cannot happen again.
