# Daali Merchandise — Specification

**Status:** Approved as the implementation direction (Revision 3 + 3.1). Built locally on branch `merch-standalone`; no production migration, push or deployment.
**Date:** October 16, 2026 — **Revision 3.3**: the new-sales switch (`MERCH_SALES_ENABLED`) is separated from payment operations, which can no longer be switched off (§13.1); one public origin for every merch link (§13.2). **Revision 3.2** (implementation record, no product change): checkout recovery replays the idempotency key instead of expiring blindly (§5.7); delivery-unknown is sticky across attempts (§5.8.1); implementation notes added (§13); `package.json` added to the touched-files list (§10). **Revision 3.1**: migration privileges scoped to the seven new tables, forward-only rollback (migration impact §2.4, §6); receipt idempotency limits stated (§5.8.1); UX-1 settled as the immediate redirect. **Revision 3**: (R1) post-payment navigation restored to automatic redirect, the 3-second confirmation screen recorded as an open UX option (§5.4); (R2) pricing finds the minimum price that meets the net under Stripe's actual rounding (§4); (R3) receipts move to a delivery outbox with pending/sending/sent/failed states, retries and duplicate-send protection, never blocking the redirect (§5.8); (R4) checkout-session creation failures, timeouts and lost responses defined, with idempotency and recovery tests (§5.7). Revision 2.1's change is withdrawn as an approved change
**Repo baseline:** `lmstech23/squares` `main` at `ab6de64`. Every [REPO] line is re-checked against `main` before coding.
**Companions:** `daali-merchandise-migration-impact.md` (migration impact assessment) · mockup canvas "Daali merch shop mockups" (5 revised screens + host dashboard before/after).
**Process:** `CLAUDE.md` mockup → document → code. Mockups and this document are each approved before code. Per the document-authority rule, this file is imported into the repo before anything is built from it.

### Decision record

| # | Decision | Status |
|---|---|---|
| D1 | New `daali_merch_*` tables; one additive production migration, run after approval | **Approved Oct 16** |
| D2 | Owner = Supabase user id; paid sales use the organizer's existing Daali Express account through one resolver | **Approved** |
| D3 | Separate Stripe Connect webhook endpoint for merch | **Approved**; necessity verified in §7 |
| D4 | Per-unit all-in price | **Approved** |
| D5 | 30-minute stock hold during payment | **Approved** |
| D6 | Refunds issued in Stripe; Daali syncs status | **Approved** |
| D7 | Public address `daali.app/merch/[slug]` | **Approved** — *see §13.2: production is served at `beta.daali.app` today, so the address is `<production host>/merch/[slug]`; the host name is an open decision* |
| D8 | One "New merch sale" link plus a merch list on the host dashboard | **Approved** |
| D9 | No automated tax. **Organizer must confirm how sales tax is handled before publishing a paid listing.** No assumption that fundraiser merch is exempt | **Approved as amended** — §6 |
| D10 | Email required; **rate limiting and duplicate-order protection**; no email verification | **Approved as amended** — §8 |
| UX-1 | After verified payment: **immediate automatic redirect with no click** | **Approved Oct 16.** The 3-second confirmation screen is not part of this release |

**Out of this release:** Event and Fundraiser integration, the INCLUDED price mode, AI agent actions, optional Daali contributions, Daali fees, refunds inside Daali, shipping rates, tax calculation.

---

## 1. Product direction

Merchandise is one reusable Daali capability. It will live in three places — standalone, inside an Event, inside a Fundraiser — and every place uses the same domain code. **This release builds standalone only**, for the Wizards dance fundraiser, and leaves Event/Fundraiser attachment as additive work.

Per item, price is **Free** (a reservation, no Stripe account needed) or **Paid** (organizer enters what she receives; Daali shows the all-in price; Stripe handles payment). **Included** (covered by another paid activity) is reserved for Event/Fundraiser.

---

## 2. One domain, many parents

```
Standalone sale ─┐      ┌─────────── src/domain/merch (one implementation) ───────────┐
Event (later) ───┼────► │ Listing ─► Item ─► Variant     pricing · stock · order state │
Fundraiser(later)┘      │    └─► Order ─► OrderLine      fulfillment · redirect · CSV  │
                        └──────────────────────────────────────────────────────────────┘
```

- A **listing** is what a parent owns: items, sizes, fulfillment options, questions, close date, after-order link, tax confirmation.
- Standalone listing = `context = STANDALONE`, its own slug and public page.
- Later, Event/Fundraiser = the same listing with a parent column set and rendered inside the parent. The domain never branches on parent type except for ownership and where it renders.
- Rules exist once in `src/domain/merch/`: `pricing.ts`, `stock.ts`, `orders.ts` (create, fulfill, expire, refund, cancel), `limits.ts` (D10), `csv.ts`. Pages and routes only call them.

---

## 3. Data model

Full detail, constraints and indexes in the migration impact assessment. Summary:

| Table | Holds |
|---|---|
| `daali_merch_listings` | owner_user_id, context (STANDALONE), slug, title, description, status DRAFT/OPEN/CLOSED, closes_at, after-order link + who verified it and when, ≤ 2 custom questions, **tax_handling + tax_confirmed_at/by** |
| `daali_merch_items` | listing, name, description, image, price_mode FREE/PAID, net_cents (PAID only), per_order_limit |
| `daali_merch_variants` | item, label ("M"), stock_limit (optional), active |
| `daali_merch_fulfillment_options` | listing, label, kind PICKUP/SHIP |
| `daali_merch_orders` | buyer name/email/phone, fulfillment option, answers, status, totals, pricing version, payee snapshot, Stripe session and payment intent ids, frozen checkout parameters (§5.7), checkout attempt count and last error, actual Stripe fee, refunded amount, redirect snapshot, hold expiry, idempotency key, hashed IP, fulfillment status |
| `daali_merch_order_lines` | order, item, variant, quantity, frozen unit price and unit net, name/label snapshots |
| `daali_merch_notifications` | the receipt outbox (§5.8): order, kind, status PENDING/SENDING/SENT/FAILED, attempts, next attempt time, lease and fencing token, provider message id, last error. Same pattern as the existing `notification_deliveries` table, kept separate for isolation |

**Stock** is derived: `stock_limit − Σ quantity` over lines whose order is PAID, CONFIRMED_FREE, or PENDING_PAYMENT with an unexpired hold. Order creation locks the variant rows (`SELECT … FOR UPDATE`) in the same transaction that inserts the order, so the last shirt can't sell twice.

**Additive later:** `daali_event_id` / `fundraiser_id` on listings with a one-parent CHECK; `INCLUDED` price mode; `included_by_ref` on lines. No table rewrite.

---

## 4. Pricing

One pure function, integer cents, frozen on each order line.

```
fee(t)      = Stripe's fee on a charge of t cents, with Stripe's exact rounding rule (§4.1)
price(net)  = the SMALLEST p such that  p − fee(p) ≥ net
              AND, for every quantity q up to the item's per-order limit,
              q·p − fee(q·p) ≥ q·net
```

Found by searching upward from a lower bound (`floor(net / 0.971)`), never by rounding a gross-up formula up. Revision 2's formula rounded the gross-up up and then only stepped upward, so for $40.00 it returned $41.51 when $41.50 may already suffice. That was a defect.

### 4.1 Stripe's actual rounding — must be measured, not assumed
At $41.50 the exact fee is 2.9% × 4150 + 30 = **150.35¢**. Rounded to $1.50, the organizer nets exactly **$40.00**, so $41.50 is the minimum price. That holds under half-up and banker's rounding alike; only a round-up rule (to $1.51) would break it. Charges whose exact fee lands on a half cent are where rounding modes disagree: totals of $5.00, $15.00, $25.00, $35.00 and so on (every $10 starting at $5), e.g. $25.00 → 102.5¢.

**Required test before the pricing function is finalized** (Stripe test mode, test host account, test card): charge $41.50, $41.49, $83.00 (2 shirts), $124.50 (3 shirts), $25.00 and $35.00 (half-cent cases), and read each charge's balance-transaction `fee`. The function's `fee()` is set to reproduce all six exactly; the unit test suite asserts them. Results are recorded in this section.

**Measured Oct 16, 2026** (Stripe test mode, test host account `acct_1URIr6FO2u8dipnf`, Visa test card, balance-transaction `fee`):

| Charge | Exact 2.9% + 30¢ | Stripe fee | Net |
|---|---|---|---|
| $41.50 | 150.35¢ | $1.50 | **$40.00** |
| $41.49 | 150.321¢ | $1.50 | $39.99 — short |
| $83.00 (2 shirts) | 270.7¢ | $2.71 | $80.29 |
| $124.50 (3 shirts) | 391.05¢ | $3.91 | $120.59 |
| $25.00 | 102.5¢ | **$1.03** | $23.97 |
| $35.00 | 131.5¢ | **$1.32** | $33.68 |

**Rounding rule: nearest cent, half up** (both half-cent cases rounded up). In integer arithmetic: `fee(t) = floor((29·t + 30000 + 500) / 1000)`. **$40.00 net → $41.50 per shirt**, confirmed as the minimum ($41.49 nets $39.99).

- `PROCESSING_ASSUMPTIONS = { percent: 0.029, fixedCents: 30, rounding: "half-up", version: "us-card-2026-10" }`; each order stores the version. Stripe's actual fee is also read from each paid order's balance transaction and stored, so any drift shows up in the host report.
- No Daali fee, no tip, no `application_fee_amount`. One price, no separate fee line (DC bans card surcharges; keeps "Daali never surcharges").
- Not recoverable from buyers: international/currency surcharges, the fee Stripe keeps on refunds, $15 disputes. These fall on the organizer's account. Setup says so in one line.
- An order whose total is $0 skips Stripe.

---

## 5. Flows

### 5.1 Supporter — paid
1. `/merch/[slug]` — pick quantity per size (Daali).
2. Details — name, email, phone, fulfillment option, questions.
3. `POST /api/merch/[slug]/orders` — in one transaction: D10 checks; lock variants; check stock, close date, per-order limits; insert `PENDING_PAYMENT` order and lines with a 30-minute hold; snapshot the after-order link; **freeze the Checkout parameters** (line items, amounts, payee, `expires_at`) on the order. Commit.
4. Create the Checkout Session (§5.7) on the organizer's account (`stripeAccount` = payee from `resolveMerchPayee`) with the frozen parameters: one line per chosen size; card and wallets only; `expires_at` = hold expiry; `client_reference_id = order_id`; `metadata = { daali_kind: "merch_order", order_id }` (never `squareId`, `squareIds` or `type`); `success_url = /merch/return?cs={CHECKOUT_SESSION_ID}`; `cancel_url` = the sale page; Stripe idempotency key `merch-checkout-<order_id>`.
5. Store the session id on the order (`WHERE stripe_session_id IS NULL`), then send the supporter to Stripe. Stripe collects payment — nothing else.
6. `/merch/return` — **redirect gate** (§5.4).

### 5.2 Supporter — free
Same pages. Step 3 inserts `CONFIRMED_FREE` and its confirmation-email outbox row (§5.8) in one transaction after D10 checks, then redirects immediately to the after-order link if one is set (a free order has nothing to verify with Stripe), else shows the order page. Email delivery happens after the response and never delays the redirect.

### 5.3 Exactly once
`fulfillOrder(orderId, session)` is the only path to `PAID`. It runs `UPDATE … SET status = 'PAID' WHERE id = ? AND status IN ('PENDING_PAYMENT','EXPIRED')` and proceeds only if one row changed. Preconditions: `session.status = 'complete'`, `session.payment_status = 'paid'`, `session.amount_total = order.total_cents`, session account = order payee. Any mismatch confirms nothing and alerts. In the **same transaction** as the status change, fulfillment inserts the receipt's outbox row (`daali_merch_notifications`, unique on order + kind), so a paid order without a pending receipt cannot exist, and the caller that loses the race inserts nothing. Sending happens outside the transaction (§5.8). A late `PAID` on an `EXPIRED` order (can't normally happen; see §7.4) is kept and flagged to the host as a possible oversell.

### 5.4 Redirect only after verified payment
`/merch/return?cs=…`:
1. Look up the order by session id. Unknown → generic "order not found" page. No redirect.
2. Retrieve the session from Stripe server-side on the order's payee account. The `cs` value is a lookup key, never trusted as proof.
3. Paid and all §5.3 preconditions hold → `fulfillOrder` (idempotent) → **HTTP 303 to the order's `redirect_snapshot_url`**, with `Referrer-Policy: no-referrer`. The browser goes straight from Stripe to the after-order page with no click and no Daali screen. No link set → the order page.
4. Not yet paid, or Stripe unreachable → "Confirming your payment…" page that re-checks server-side every few seconds for up to a minute and navigates automatically the moment the order is `PAID`; after a minute it shows the order page with the backup link. **Navigation to the after-order link never happens before payment is verified.**
5. The destination is only ever read from the order row. No query parameter, header or cookie can supply or change it.
6. The redirect never waits on email. The receipt's outbox row already exists (§5.3); delivery runs after the response (§5.8).

**UX-1 — settled.** The immediate redirect above is the approved behaviour. The optional 3-second confirmation screen considered in Revision 2.1 is not built in this release.

### 5.5 Recovery
The receipt email and `/merch/order/[public_token]` show the order and the after-order link. That link appears only there, never in the normal flow.

### 5.6 Host
- Host dashboard (D8): "New merch sale" button and a "Merch sales" list under the boards list — the only change to an existing page.
- `/host/merch/new`, `/host/merch/[id]` — setup, publish, close.
- `/host/merch/[id]/orders` — totals, counts by size, mark handed out, cancel a free order, CSV.
- After-order link: shown decoded, `https` only, must be opened and confirmed before publish; any edit clears the confirmation.
- Orders page shows each receipt's delivery state (sent, retrying, failed) with a "Resend receipt" action for failed ones.

### 5.7 Checkout-session creation: failure, timeout, lost response

The order and its stock hold are committed **before** Stripe is called (§5.1 step 3), so a stock hold always belongs to a real order row. The Stripe call then has four possible outcomes:

| Outcome | What it looks like | Handling |
|---|---|---|
| **Success** | Session returned | `UPDATE orders SET stripe_session_id, checkout_url WHERE id = ? AND stripe_session_id IS NULL`; redirect the supporter to Stripe |
| **Definite failure** | Stripe returns a 4xx (invalid request, account can't take charges, rate-limit refusal) — Stripe executed nothing | Order → `CANCELLED` with `checkout_error`; hold released immediately; supporter sees "Payment couldn't start. Nothing was charged. Try again." Retrying starts a new order |
| **Ambiguous** | Timeout, network error, 5xx, or a crash after Stripe may have created the session | Order stays `PENDING_PAYMENT` with no session id. The supporter sees "Still setting up payment…" and the page retries (below) |
| **Lost response** | Stripe created the session but Daali never stored it (timeout on the response, or the database write after it failed) | Same as ambiguous. The supporter was never given the checkout URL, because the URL is only returned after the session id is stored, so nobody can pay on that session |

**Recovery is idempotent by construction.** Every attempt for an order uses the same Stripe idempotency key, `merch-checkout-<order_id>`, and the **same frozen parameters** stored on the order. Stripe returns the original session for a repeated key with identical parameters (keys are kept at least 24 hours), so a retry after a lost response gets the session that already exists rather than creating a second one. Parameters are never recomputed on retry; a changed parameter under the same key is a Stripe error by design.

- **Supporter retry:** the "Still setting up payment…" page calls `POST /api/merch/orders/[public_token]/checkout`, which repeats the call with the same key and parameters (up to 3 times, a few seconds apart). The form's own idempotency key (§8) means a reload or double submit finds the same order instead of creating another hold.
- **Background recovery:** the reconciliation cron (§7.5) picks up `PENDING_PAYMENT` orders with no session id that are older than 2 minutes.
  - **No attempt was ever sent to Stripe** (`checkout_attempts = 0`, the supporter left first): no session can exist, so the order is marked `EXPIRED` and the hold released without calling Stripe.
  - **At least one attempt was sent:** the cron replays the create call with the same key and the same frozen parameters. If Stripe had created a session, the replay returns **that** session (Stripe replays the original result for a repeated key; it does not re-validate `expires_at`). If it is paid, the order is fulfilled; otherwise the cron **expires it immediately** (`checkout.sessions.expire`) and marks the order `EXPIRED` — the supporter has left and was never given that URL. If the original request never reached Stripe, the replay is a new request whose `expires_at` is now under 30 minutes away, Stripe rejects it (a definite 4xx), nothing was ever created, and the order is `CANCELLED`. Still ambiguous → try again next run.
- **Too late to retry:** Stripe requires `expires_at` at least 30 minutes after creation. A *first* attempt that would violate that is not sent; the order is expired and the hold released. After an earlier attempt, the call is always replayed instead (above), because only a replay can recover a session Stripe already created.

  *Revision 3.2: Revision 3.1 expired any order whose remaining hold was under 30 minutes without asking Stripe. Since the cron only looks at orders older than 2 minutes and the hold is 31 minutes, that branch caught every recovered order, so a session Stripe had created (and possibly been paid on, with a lost webhook) was never looked up. Found by the integration test "…and if the supporter had paid it, recovery marks it PAID".*
- **Payment arrives for a session Daali never stored:** cannot happen through Daali's flow (the URL was never handed out), but the merch webhook still handles it — when no order matches the session id, it falls back to `client_reference_id` = order id, verifies payee account and amount against the frozen parameters, attaches the session id, and fulfills.

### 5.8 Receipt delivery

Receipts and free-order confirmations go through an outbox, `daali_merch_notifications`, modelled on the existing `notification_deliveries` table [REPO `schema.prisma`].

```
PENDING ──claim──► SENDING ──provider accepted──► SENT
   ▲                  │
   │                  ├── provider rejected / timeout ──► FAILED (retryable, next_attempt_at set)
   └────── retry ─────┘                                     │
                                                            └── 6 attempts used ──► FAILED (final, host sees it)
```

- **Created with the order state change:** the row is inserted in the transaction that makes an order `PAID` or `CONFIRMED_FREE`, unique on `(order_id, kind)`. No paid order can exist without a receipt to send, and a duplicate fulfillment creates nothing.
- **Claim:** `UPDATE … SET status = 'SENDING', attempts = attempts + 1, locked_at = now(), lock_token = <new uuid> WHERE id = ? AND (status = 'PENDING' OR (status = 'FAILED' AND next_attempt_at <= now() AND attempts < 6) OR (status = 'SENDING' AND locked_at < now() − 2 min))`. Only one worker can hold it; a stale lease is reclaimable. Every later write is fenced on `lock_token`, so a slow worker can never overwrite a newer result.
- **Send:** Resend with `Idempotency-Key: merch-<kind>-<order_id>` and an identical payload on every attempt. Resend keeps keys 24 hours and returns the original result for a repeat, so a retry after an ambiguous failure (timeout after Resend accepted) cannot send a second email. A `409 concurrent_idempotent_requests` is treated as retryable.
- **Settle:** accepted → `SENT`, `provider_message_id`, `sent_at`. Rejected or timed out → `FAILED` with `last_error` and backoff `next_attempt_at` (1, 5, 15, 60, 240 minutes). After 6 attempts it stays `FAILED` and shows on the host's orders page with "Resend receipt", which resets it to `PENDING` with a fresh idempotency suffix.
- **Never blocks navigation:** the first attempt runs after the HTTP response is sent (Next.js `after()`, available in the repo's Next 16 [REPO `package.json`]); the reconciliation cron runs retries. The redirect does not wait for, or depend on, the email.
- **What `SENT` means:** Resend accepted the message. It is not proof the message reached the inbox.

#### 5.8.1 What this does and doesn't guarantee

**Guaranteed:** every paid or confirmed-free order gets a receipt record; the redirect never waits on it; two workers can never send the same receipt at the same time; and any automatic retry that happens within Resend's 24-hour idempotency window cannot produce a second email.

**Not guaranteed: exactly-once delivery.** The hard case:

1. Daali sends the receipt; Resend accepts it and the email goes out.
2. Daali never sees the acceptance (timeout, dropped connection, or a crash before `SENT` is written), so the record shows `FAILED` or a stale `SENDING`.
3. Any retry **within 24 hours** reuses the key and Resend returns the original result — no second email.
4. A send **after 24 hours** (the key has expired) can produce a second copy, and Daali cannot tell beforehand, because the only proof of the first send was the response it lost.

How the design keeps that case rare and visible rather than pretending it away:
- **Automatic retries stop inside the window.** The backoff schedule (1 + 5 + 15 + 60 + 240 minutes) finishes about 5½ hours after the first attempt; no automatic attempt is ever made more than 23 hours after the first one. A record still unconfirmed at that point is marked `FAILED` with `last_error = 'delivery_unknown'`.
- **Ambiguity is remembered.** Once any attempt for a record ended ambiguously (timeout, dropped connection, 5xx), `last_error` keeps an `ambiguous:` prefix, and the record's final failure is reported as `delivery_unknown` even if the last attempt itself was a clean rejection — an earlier attempt may have delivered it. *(Revision 3.2.)*
- **The host sees it honestly.** The orders page shows "Receipt may not have been delivered" for those orders, not "failed", and the "Resend receipt" button warns that the supporter may get a second copy. That resend uses a new idempotency suffix on purpose: it is a deliberate, visible second email.
- **The order page is the real record.** Every receipt links to `/merch/order/[public_token]`, and the supporter reached the after-order page through the redirect regardless of email, so a missing or duplicated email never loses the order.

So: **at most one automatic email per receipt within the provider's idempotency window; outside that window, duplicates are possible only through an explicit host resend.** No exactly-once claim is made.

---

## 6. Sales tax (D9)

Publishing a listing that has at least one **Paid** item requires the organizer to pick one statement and confirm it. Free-only listings skip this.

| Choice (stored as `tax_handling`) | Shown to the organizer |
|---|---|
| `INCLUDED_ORGANIZER_REMITS` | "My price includes any sales tax due, and my organization will report and pay it." |
| `EXEMPT_CONFIRMED` | "My organization has confirmed these sales are exempt from sales tax." |
| `NOT_DUE_CONFIRMED` | "My organization has confirmed no sales tax is due on these sales." |

Above the choice: "Daali doesn't calculate, collect separately or pay sales tax. Fundraiser merchandise isn't automatically tax-exempt — check your state's rules." There is **no default**; Publish stays unavailable until one is chosen and the confirmation box is ticked. `tax_confirmed_at` and `tax_confirmed_by` are recorded. Changing the choice requires confirming again. The orders CSV includes the listing's tax choice in its header line.

---

## 7. Stripe webhook — necessity, routing, duplicates

### 7.1 Is a webhook necessary?
Yes. The return route alone misses three real cases:

| Case | Without a webhook |
|---|---|
| Supporter pays, then closes the tab before returning | Money taken, order stays pending, hold expires, shirt can be resold, no receipt |
| Supporter abandons checkout | Hold only released by cron |
| Refund issued in Stripe | Daali never learns of it |

A polling cron could cover the first two (retrieve each stale pending session) but not refunds without listing every charge on every account. So: webhook as the primary signal, plus a reconciliation cron as the safety net (§7.5).

### 7.2 Is a separate endpoint necessary?
Yes, given the isolation requirement.

| Option | Verdict |
|---|---|
| Add a merch branch to the existing `/api/webhooks/stripe` | Edits the live Board money path (`handleCheckoutCompleted` carries invariants 59, 62, 63). Rejected |
| **New Connect endpoint `/api/webhooks/merch`** with its own signing secret | **Chosen.** Stripe delivers each connected-account event independently to every endpoint subscribed to it, each with its own retries |

Consequence: both endpoints receive every subscribed connected-account event.

- **The existing endpoint receives merch events and ignores them** — verified on `ab6de64`: `checkout.session.completed` finds no `Contribution`, no squares for the session and no `squareId(s)` metadata, and returns 200 with no writes; `checkout.session.expired` updates zero contribution rows and returns. It is not subscribed to `charge.refunded`. Proven by an integration test (§9).
- **The merch endpoint receives Board events and ignores them**: no merch order with that session or payment intent → 200, no writes.
- `src/middleware.ts` already excludes `api/webhooks` from the auth matcher, so the new route needs no middleware change [REPO].

### 7.3 Routing inside the merch endpoint
1. Verify the signature with `STRIPE_MERCH_WEBHOOK_SECRET`. Bad → 400.
2. Require `event.account` (a connected-account event). Missing → 200, ignored.
3. Subscribed types only: `checkout.session.completed`, `checkout.session.expired`, `charge.refunded`. Anything else → 200.
4. Find the order by `stripe_session_id` (or `stripe_payment_intent_id` for refunds). None → 200, ignored. `metadata.daali_kind` is a hint only, never the lookup.
5. `event.account` must equal the order's payee. Mismatch → log, alert, 200, no write.
6. Act (below). Database or transient failure → 500 so Stripe retries. Everything else → 200.

### 7.4 Duplicate and out-of-order delivery
Stripe delivers at least once, sometimes concurrently, not always in order. Every action is a conditional state change, so replaying it changes nothing:

| Event | Action | Replay / race |
|---|---|---|
| `checkout.session.completed` | `fulfillOrder` | Second call changes zero rows; return route and webhook racing → one wins; receipt claimed once |
| `checkout.session.expired` | `UPDATE … SET status='EXPIRED' WHERE id=? AND status='PENDING_PAYMENT'` | No-op after PAID or a prior expiry. The session's `expires_at` equals the hold expiry, so Stripe cannot take payment after the hold lapses |
| `charge.refunded` | `refunded_cents = GREATEST(refunded_cents, charge.amount_refunded)`; status REFUNDED when it equals the total, else PARTIALLY_REFUNDED | Cumulative amount makes it order-independent and replay-safe. A full refund releases its stock automatically; a partial refund doesn't (the host decides) |

No processed-event log table is needed: the state machine is the idempotency.

### 7.5 Reconciliation cron
`/api/cron/merch-reconcile`, every 10 minutes (CRON_SECRET, like the existing crons). For `PENDING_PAYMENT` orders whose hold passed more than 5 minutes ago: retrieve the session; `complete`+`paid` → `fulfillOrder`; `expired` → expire; `open` → leave it. This covers missed webhooks and is the abandoned-checkout cleanup. It never expires an order Stripe hasn't confirmed expired. The same run also (a) recovers `PENDING_PAYMENT` orders with no session id older than 2 minutes (§5.7) and (b) claims due receipt rows (§5.8). Each step works on a bounded batch so one slow Stripe or Resend call can't starve the rest.

---

## 8. Abuse controls (D10)

Applies to free and paid orders unless noted.

| Control | Rule |
|---|---|
| Email | Required, trimmed, lower-cased, basic format check |
| Double submit | The form sends a one-time key; `idempotency_key` is unique, so a double click or resubmit returns the same order |
| Duplicate free orders | One `CONFIRMED_FREE` order per email per listing (partial unique index). A repeat sees "You've already reserved — check your email." The host can cancel an order to release it |
| Hold hoarding (paid) | At most 2 `PENDING_PAYMENT` orders per email per listing at a time |
| Per-order limit | Per item, set by the host (default 10) |
| Rate limit | Per listing: ≤ 5 orders per hashed IP per 10 minutes and ≤ 3 per email per hour, counted from `daali_merch_orders`. Over the limit → "Too many tries. Try again in a few minutes." IPs stored only as a salted SHA-256 hash |
| Host remedy | Cancel any free order; cancelled orders release stock |

No email verification in this release.

---

## 9. Testing (required before any production step)

**Unit (`npm test`):**
- Pricing: `fee()` reproduces every measured Stripe fee from §4.1 exactly; `price(4000) = 4150`; for every net from $1.00 to $1,000.00, `price(net)` meets the net and `price(net) − 1` does not (minimality); for every quantity up to the per-order limit, `q·price` meets `q·net`
- Stock arithmetic; status transitions; D10 limits; CSV; receipt backoff schedule

**Integration (`npm run test:integration`, replayed test database):**
- Two concurrent orders for the last shirt → exactly one succeeds
- `fulfillOrder` called concurrently from return route and webhook → one PAID, one receipt
- Duplicate `checkout.session.completed` → no change on replay
- Amount mismatch → not confirmed
- Expired after paid → no change; completed after expired → PAID plus oversell flag
- Full and partial refund, delivered twice and out of order → correct `refunded_cents`, stock released only on full refund
- Duplicate free order by the same email → rejected; host cancel → re-order allowed
- Rate limits trigger and reset
- **Isolation:** a merch session's `checkout.session.completed` and `.expired` passed to the existing Board webhook handler → 200 and zero rows changed in every table
- **New sales switched off with payments in flight** (Revision 3.3, §13.1):
  - New orders and checkout sessions are refused, and a replayed form key still finds its order.
  - A never-attempted pending order releases its hold without calling Stripe.
  - A lost-response order is left for the cron, which replays the key and ends the session.
  - A supporter already at Stripe pays: the order is PAID, the receipt is sent, and the browser redirects.
  - A lost webhook is still reconciled.
  - Expired and refunded events are applied, not acknowledged and dropped.
  - A processing failure still returns 500.
  - The cron is not skipped.
  - Host order actions and the CSV keep working.
  - Creating and publishing a sale are refused.
- **Checkout creation** (Stripe client stubbed at the boundary):
  - Success → session stored once; supporter sent to Stripe
  - Stripe 4xx → order CANCELLED, stock released, nothing stored
  - Timeout before Stripe received the call → retry creates the session; one session id stored
  - Timeout after Stripe created it (stub returns the same session for the same idempotency key) → retry stores the original session; no second session
  - Database write fails after Stripe success → cron repeats the call with the same key, receives the original session, expires it, order EXPIRED, stock released
  - Double submit / reload → one order, one hold, one session
  - Retry with any parameter changed is impossible: parameters are read only from the frozen order fields (asserted)
  - Retry too close to expiry → order EXPIRED, hold released, no Stripe call
  - Webhook `checkout.session.completed` for a session id not on any order → matched by `client_reference_id`, payee and amount verified, fulfilled once
- **Receipt outbox:**
  - Fulfillment creates exactly one PENDING row; a duplicate fulfillment creates none
  - Two workers claim the same row concurrently → one SENDING, the other gets nothing
  - Provider timeout → FAILED with backoff; retry sends with the same idempotency key; stub provider records exactly one email
  - Stale SENDING lease (worker crashed) → reclaimed after 2 minutes; the old worker's late write is rejected by the fencing token
  - 6 failures → FAILED final, visible to host; host resend → PENDING, sends once
  - Redirect response is returned while the provider stub is still hanging (navigation never waits on email)

**Stripe test mode, end to end** on test account `acct_1URIr6FO2u8dipnf`:

| Scenario | Pass condition |
|---|---|
| Fee rounding | Six test charges from §4.1 recorded; `fee()` matches each |
| Paid: 3 shirts, 2 sizes at $41.50 | Browser goes from Stripe straight to the after-order link with no click; order PAID once; receipt SENT once; CSV row correct; actual fee $3.91; organizer net ≥ $120.00 |
| Email provider down during payment (invalid key in test env) | Redirect still immediate; receipt FAILED then SENT after the key is restored, once |
| Checkout creation with network cut after Stripe responds (fault-injection flag, test env only) | Order recovered by cron; session expired; stock released |
| Close tab right after paying | Webhook marks PAID; receipt arrives; no redirect needed |
| Duplicate webhook (`stripe events resend`) | No change |
| Abandoned checkout (session expired via API) | Order EXPIRED; stock back |
| Webhook endpoint disabled, then pay | Reconciliation cron marks PAID |
| Refund in Stripe | Order REFUNDED; stock back |
| Free order; repeat with same email | Confirmed; repeat blocked |
| Tampered `cs` value on `/merch/return` | No redirect |

**Isolation guard (CI):** no file under `src/domain/merch`, `src/app/merch`, `src/app/host/merch`, `src/app/api/merch`, `src/app/api/webhooks/merch` imports Board, Square, Contribution, entry or checkout modules; nothing outside those paths imports merch, except the host dashboard link (D8).

---

## 10. Isolation from Boards — the complete list of touched existing files

| File | Change |
|---|---|
| `prisma/schema.prisma` | New models appended; existing models untouched; no `prisma format` |
| `prisma/migrations/<new>/migration.sql` | New, additive |
| `src/app/host/boards/page.tsx` | "New merch sale" button and a "Merch sales" list (D8) |
| `vercel.json` | One cron entry (`/api/cron/merch-reconcile`, every 10 minutes) |
| `package.json` | One script, `test:integration:merch` |

Everything else is new files. No change to Board checkout, the existing webhook, `confirmSquares`, contributions, email templates for Boards, `next.config.ts` or middleware.

---

## 11. Build order (after mockup and document approval)

1. Import this spec into the repo.
2. Migration + models; replay on the test database; S1 containment preconditions (`CLAUDE.md`).
3. Domain + unit and integration tests.
4. Host screens, public pages, checkout route, return route, merch webhook, reconciliation cron.
5. Stripe test-mode end-to-end (§9).
6. Your approval → production migration through `db:migrate:production` → live merch webhook endpoint + secret → storage bucket → deploy → one live purchase.

---

## 12. Open items outside engineering
- The organizer's exact Wizards ticket link (and whether buyers need a promo code; if so, it must be inside the URL).
- Wizards branding she is authorized to use.
- Her tax choice (§6) before publishing.

---

## 13. Implementation notes (Revision 3.2)

Details settled while building that the earlier revisions left open. None changes an approved behavior.

- **Edits never delete.** `daali_merch_items` and `daali_merch_fulfillment_options` carry an `active` column. Saving a sale updates rows by id (or by label), and anything removed in the editor is deactivated, not deleted, because past order lines reference it.
- **Receipt window.** `daali_merch_notifications.first_attempt_at` records the first claim; the 23-hour auto-send cutoff (§5.8.1) is measured from it.
- **Reserved link names.** `return`, `order`, `orders`, `new`, `api`, `admin` cannot be used as a sale's link, so a sale can never shadow a route.
- **Receipt wording.** The after-order button reads "Continue to <site>" (for example, "Continue to nba.com"), and the footer says "Contact the organizer" for questions. All buyer and host text in the email is HTML-escaped.
- **Close date.** Stored in UTC. The host enters it in their own browser's time zone, and the editor shows it back in that zone. (Merch has no Board, so there is no `Board.timezone` to use.)
- **Host resend.** "Resend receipt" sends right after the click (after the response), then falls back to the cron like any other row.

### 13.1 Switching off new sales never switches off payments (Revision 3.3)

`MERCH_SALES_ENABLED` controls **new-sale availability only**. It replaces Revision 3.2's `MERCH_ENABLED`, which also silenced the merch webhook (acknowledging Stripe events without processing them) and skipped the reconciliation cron. Once real orders exist, that switch could have dropped a paid order or a refund.

| Off stops | Off never stops |
|---|---|
| The public sale page (`/merch/[slug]`, 404) | The merch webhook: completed, expired and refund events are **processed** |
| New orders, paid or free (`createOrder` → "This sale isn't taking orders right now. Nothing was charged.") | The return gate `/merch/return`: a supporter who pays after shutdown is still sent to the after-order link |
| New Checkout Sessions (`startCheckout` creates nothing; a pending order that was never sent to Stripe releases its hold at once) | The status poll and the order page `/merch/order/[token]` |
| Creating a sale, publishing, image upload | The reconciliation cron: lost sessions, lost webhooks, receipts, fee backfill |
| The dashboard "New merch sale" button | The receipt outbox, and host "Resend receipt" |
| | Host orders page, CSV, mark handed out, cancel free reservation, close a sale; the dashboard "Merch sales" list |

Rules that make this safe:
- **There is no switch that makes the webhook acknowledge without processing.** The endpoint returns 200 only after the event is handled (or is provably not a merch event), and 500 on any failure, so Stripe retries.
- **The check lives in the domain, not just the routes.** `MerchDeps.salesOpen` is read by `createOrder` and `startCheckout` themselves.
- **An existing session is not a new one.** A supporter already on Stripe's page when sales switch off can still pay; their payment is processed normally. A reload of the checkout page returns the session already stored on the order.
- **Recovery is not creation.** The cron's lost-session recovery replays an idempotency key from an earlier attempt and immediately expires whatever comes back; it never hands a checkout URL to anyone, and a genuinely new request is refused by Stripe because the frozen expiry is under 30 minutes away.
- **To stop payment processing entirely** (an emergency, not a rollback), disable the merch endpoint in the Stripe Dashboard. Stripe then queues and retries deliveries for up to three days, and the reconciliation cron settles every pending order from Stripe directly when it runs. Re-enable the endpoint to resume.

### 13.2 One public origin

Every address merch hands out comes from one value, `NEXT_PUBLIC_URL`, read by `merchBaseUrl()` (`src/domain/merch/origin.ts`):
- Stripe `success_url` (`/merch/return?cs=…`) and `cancel_url` (`/merch/[slug]?cancelled=1`)
- The receipt email's order link (`/merch/order/[token]`)
- The return gate's own redirects
- The link prefix shown in the host editor (for example `beta.daali.app/merch/`)

It is never taken from the incoming request (unlike Board checkout, `src/lib/base-url.ts`), so a supporter who arrives through a `vercel.app` alias still gets canonical links. In production it must be an `https` origin with no path, not localhost; otherwise every merch route fails rather than handing out a wrong link. A unit test fails if any merch source hard-codes a site host (the email From address excepted).

The Stripe webhook endpoint is configured separately, in the Stripe Dashboard, and must use the same host. The deployment checklist compares them.

**Open decision.** D7 named `daali.app/merch/[slug]`, but the repo's deployment record lists the production deployment as `beta.daali.app` plus three `vercel.app` aliases, and `NEXT_PUBLIC_URL` is `beta.daali.app`. Two options:
1. **Use `beta.daali.app`.** This works today with no other change.
2. **Serve `daali.app` from the same deployment.** This needs the domain added in Vercel. It also needs `NEXT_PUBLIC_URL` changed, which **also changes Board links**: Board confirmation emails and the Stripe Connect return use it. That is outside this change.

