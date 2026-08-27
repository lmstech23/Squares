# Squares — System Flow Document

Last updated: Aug 27, 2026

This is the single source of truth for how **Game Day** works. Every screen, every redirect, every conditional. If it's not in this document, it doesn't exist. If this document says one thing and the code says another, fix the code.

---

## Quick Summary (Plain English)

**Onboarding:** New host enters phone or email, gets a code, enters it. First time only, they see a screen asking how players will pay — Cash or Card. Cash hosts go straight to their dashboard. Card hosts go through Stripe setup first. This screen never shows again.

**Dashboard:** Shows their boards, credit balance, and a "New Board" button that's always tappable. Cash hosts see an optional Stripe banner at the top until they connect. Credits show for new hosts (starts at 2). Platform owner sees "Unlimited."

**Board Creation:** Host taps "New Board," picks a board type (Standard 100-square or Double 25-square), then fills out a short form (game, teams, price, payout split). Cash hosts get cash mode auto-enabled with a random PIN. If the host has credits, the board goes live immediately. If no credits, the board is saved as a draft and they're sent to buy more ($19 for 1, $45 for 3). Unpaid drafts expire after 48 hours.

**Board Management:** Host sees their grid, fill progress, share link. They can close the board (triggers number randomization), toggle cash mode, reserve squares for cash players, confirm cash received, enter scores, and see winners.

**Player Experience:** Player opens a link, sees the grid, taps a square. They only see payment options that work — card if Stripe is set up, cash if cash mode is on, both if both exist. No mention of what's missing. Card goes through Stripe. Cash requires the host's PIN.

**Payment Processing:** Stripe webhooks handle payment confirmations and expirations. A cron job runs every 5 minutes to clean up abandoned card checkouts. Cash reservations do not expire — the host releases them.

**Database Fields:** Key fields on Host (payment preference, credits, Stripe status), Board (status, cash mode, PIN), and Square (payment status, payment method).

**Rules:** Stripe is optional. Cash is first-class. Players see what's available. Board creation is never blocked. Document first, code second.

**Fundraiser boards:** A second board type with its own flow, specified in `fundraiser-board-v2.md`. Money and drawing eligibility are governed by `fundraiser-money-state-machine.md`. Optional event admission is governed by `fundraiser-admission-addendum.md`.

**This document does not cover fundraiser flows, and the document-first rule is satisfied for fundraiser work by writing in v2 first.** See v2 §17. The backfill of fundraiser flows into this document is a deferred ticket and blocks nothing. This document remains the authority for Game Day.

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

### 3B. Board Type Picker

Before the form opens, the host sees a popup asking which kind of board they want.

**Trigger:** Tapping "New Board" from the dashboard (after the Access Gate passes).

**What the host sees:**

- Title: **"Pick your board type"**
- Subtitle: "You can't switch after players start buying squares."
- Two cards side by side, equal weight (no recommendation, no default selection):

  | | **Standard** | **Double** |
  |---|---|---|
  | Visual | 10×10 grid preview | 5×5 grid preview |
  | Headline | "100 squares" | "25 squares" |
  | Description | "Each row and column covers one number. The classic format." | "Each row and column covers two numbers. Smaller pool, bigger chance to win per square." |

- A "Continue" button at the bottom, disabled until a card is tapped. Tapping a card highlights it; the Continue button label updates to "Continue with Standard" or "Continue with Double" so the host always sees what they're about to commit to.
- A "Cancel" button that returns the host to the dashboard. **No X button in the corner** — the host either picks a type or cancels back to the dashboard.

**On Continue:** The popup closes and the host lands on the create-board form (3C). The chosen `gridType` is carried into the form and shown read-only at the top so the host can see it before submitting.

### 3C. The Form

Fields:
- **Board type** (read-only, set by 3B picker — shown as a chip at the top of the form, e.g. "Standard · 100 squares" or "Double · 25 squares")
- Game name (required)
- Team names — row and column (required)
- Price per square in dollars (minimum $1)
- Host cut percentage (0–50%, default 20%)
- Period type (halves or quarters, default halves)
- Payout structure per period (must total 100%)

The form should also display the resulting total pot (price × N where N = 100 for Standard, 25 for Double) so the host sees what the players are competing for before submitting.

### 3D. What Happens on Submit

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
- Create board with `status = open` and the chosen `gridType` from 3B
- Create N squares (`paymentStatus: open`) where **N = 100 for Standard, 25 for Double**
- Generate slug
- Redirect to `/host/boards/[id]`
- Board is immediately shareable

**Path 3: Host Has No Credits (boardCredits = 0)**
- Check for existing `pending_payment` board — if one exists, redirect to complete that checkout first
- Create board with `status = pending_payment` and the chosen `gridType` from 3B
- Create N squares where **N = 100 for Standard, 25 for Double** (board is NOT shareable)
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
- **Fill tracker:** X / N squares filled (progress bar) — N = 100 for Standard boards, 25 for Double boards
- **Pending indicator:** "X squares pending payment"
- **Grid** showing all squares with status colors (10×10 layout for Standard, 5×5 for Double):
  - 🟢 Green = paid (card or confirmed cash)
  - 🟡 Yellow = pending (Stripe checkout in progress) or reserved_cash (awaiting host confirmation)
  - Empty/gray = open

### Close Board
- Button visible when `status = open`
- Confirmation required
- On close: Fisher-Yates shuffle assigns digits to rows and columns:
  - **Standard:** each of 10 rows gets one digit 0–9, each of 10 columns gets one digit 0–9. Stored in `rowNumbers` / `colNumbers`.
  - **Double:** each of 5 rows gets a pair of digits (e.g. `[0, 5]`), each of 5 columns gets a pair. All 10 digits used exactly once per axis. Stored in `rowPairs` / `colPairs`.
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

**On a fundraiser board with an event attached, confirming does three things in one transaction, not one:**

```
square              -> paid          (drawing eligibility follows from this)
event supporter     -> active
admission passes    -> minted (N = declaredCount)
```

Drawing eligibility is derived from the square being `paid`, not a separate write — see `fundraiser-money-state-machine.md` §5. A developer who reads "confirm sets paid" and implements exactly that ships a gate that admits nobody. See `fundraiser-admission-addendum.md` §4. Game Day boards are unaffected.

### Enter Scores (when board is closed)
- Enter scores per period for each team
- Winners auto-calculated:
  - **Standard:** the last digit of each team's score matches one row/column number — that single square wins.
  - **Double:** the last digit of each team's score falls inside a row's/column's digit pair — that single square (covering both possible digits per axis) wins.
- Payout amounts displayed

---

## 5. Player Experience

**Page:** `/board/[slug]` (public, no login required)

### What the Player Sees

- Game name, team names
- Grid with open/taken squares — 10×10 for Standard boards, 5×5 for Double boards
- Fill progress: "X / N squares filled" (N = 100 for Standard, 25 for Double)
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

### Closed Board View
- Row/column numbers visible — single digits for Standard, digit pairs (e.g. "0, 5") for Double
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
2. Expire boards where `status = pending_payment` AND `pending_expires_at < NOW()`

**Cash reservations are never auto-released.** They stay reserved until the host confirms or releases them. The same applies to the inline cleanup on the player and host board pages, which sweeps `pending` only.

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
| `gridType` | `standard` (10×10, 100 squares) or `double` (5×5, 25 squares). Set at creation, immutable once squares are sold. |
| `totalSquares` | 100 for Standard, 25 for Double. Derived from `gridType` on creation. |
| `rowNumbers` / `colNumbers` | Used for Standard boards. Single digits 0–9 assigned at close. |
| `rowPairs` / `colPairs` | Used for Double boards. Each is an array of 5 digit-pairs assigned at close. |
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

### Fundraiser and admission tables

Not duplicated here. `Board` and `Square` gain **no** admission columns, and there is no `Ticket` table — a drawing ticket is derived (money doc §5).

Fundraiser: see `fundraiser-board-v2.md` §3.
Admission: `Event`, `EventSupporter`, `AdmissionGrant`, `AdmissionPass`, `CheckInLog`, `VolunteerAccess`, `AttendanceAccessToken` — see `fundraiser-admission-addendum.md` §2.

---

## 8. Rules (Apply Everywhere)

1. **Stripe is optional.** It is never a prerequisite for board creation. Cash is a first-class payment method.
2. **The `paymentPreference` field drives all conditional logic.** Cash hosts skip Stripe checks. Stripe hosts get Stripe gates.
3. **Players see what's available.** No tabs when only one method exists. No error messages about what's missing.
4. **Cash mode auto-enables for cash hosts.** PIN auto-generates. No extra steps.
5. **Board creation is never blocked.** Credits determine the path (instant vs. pending_payment), not whether it's allowed.
6. **The host is the trust layer for cash.** No email required. PIN gates access. Host confirms receipt.
7. **Grid type is set at creation and locked once squares are sold.** Hosts pick Standard or Double in a popup before the form opens. Once any square is `paid`, `pending`, or `reserved_cash`, the board's grid type cannot change.
8. **Every change gets documented here first, then coded.**
9. **Before pushing ANY code change, check this document.** Walk through every section affected by the change. If the change would break any part of this flow — stop. Fix the approach first. This rule exists because on Feb 26, 2026, working code was destroyed by changes that ignored the existing flow. That cannot happen again.
