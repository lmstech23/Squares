// Stripe TEST-MODE checks of the real merch gateway (spec §5.7). Refuses live keys.
// Usage: node --experimental-strip-types scripts/merch-stripe-testmode-check.mts <file containing rk_test_/sk_test_ key>
// Takes ~2 minutes: it waits until the frozen expires_at is under 30 minutes away, then replays the key.
// Test-mode checks of the real merch gateway against the test connected account. No browser.
import Stripe from "stripe";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { stripeMerchGateway, MerchStripeError } from "../src/domain/merch/stripe.ts";

const key = readFileSync(process.argv[2], "utf8").trim();
if (!key.startsWith("rk_test_") && !key.startsWith("sk_test_")) throw new Error("test keys only");
const stripe = new Stripe(key, { httpClient: Stripe.createFetchHttpClient() });
const gw = stripeMerchGateway(stripe);
const ACCT = process.argv[3] ?? "acct_1URIr6FO2u8dipnf"; // the test connected account
const out: Record<string, unknown> = {};
const now = () => Math.floor(Date.now() / 1000);
const orderId = randomUUID();
const params = (exp: number) => ({
  currency: "usd" as const,
  lines: [{ name: "Team T-shirt · M", unitAmountCents: 4150, quantity: 2 }],
  expiresAtUnix: exp, successUrl: "https://daali.test/merch/return?cs={CHECKOUT_SESSION_ID}",
  cancelUrl: "https://daali.test/merch/t?cancelled=1", customerEmail: "pat@example.com", orderId,
});
const exp = now() + 30 * 60 + 70;
const k = "merch-checkout-" + orderId;
const a = await gw.createCheckoutSession(params(exp), ACCT, k);
out.create = { id: a.id, status: a.status, amountTotal: a.amountTotal, clientRef: a.clientReferenceId === orderId, meta: a.metadataOrderId === orderId, url: !!a.url };
const b = await gw.createCheckoutSession(params(exp), ACCT, k);
out.replaySameSession = b.id === a.id;
const r = await gw.retrieveCheckoutSession(a.id, ACCT);
out.retrieve = { status: r.status, paymentStatus: r.paymentStatus };
try { await gw.retrieveCheckoutSession(a.id, "acct_1T08hpDaaliNotReal"); out.wrongAccount = "UNEXPECTED_OK"; } catch (e) { out.wrongAccount = (e as MerchStripeError).kind; }
try { await gw.createCheckoutSession(params(now() + 10 * 60), ACCT, "merch-checkout-" + randomUUID()); out.shortExpiry = "UNEXPECTED_OK"; } catch (e) { out.shortExpiry = (e as MerchStripeError).kind + ": " + (e as Error).message.slice(0, 90); }
// Wait until the frozen expires_at is < 30 min away, then replay: must return the ORIGINAL session, not a 400.
const waitMs = (exp - (30 * 60 - 20) - now()) * 1000;
await new Promise((res) => setTimeout(res, Math.max(waitMs, 0)));
out.secondsLeftAtReplay = exp - now();
try { const c = await gw.createCheckoutSession(params(exp), ACCT, k); out.lateReplaySameSession = c.id === a.id; } catch (e) { out.lateReplaySameSession = "ERROR " + (e as Error).message; }
// Fresh key with the same now-short expiry: Stripe must refuse (nothing created).
// A fresh key with expires_at well under 30 minutes must be refused. (Stripe allows ~30-60 s of slack:
// measured accepted at >= 1770 s, refused at <= 1740 s.) Anything accidentally created is expired at once.
try { const f = await gw.createCheckoutSession(params(now() + 1700), ACCT, "merch-checkout-" + randomUUID()); await gw.expireCheckoutSession(f.id, ACCT); out.lateFreshKey = "UNEXPECTED_OK (expired)"; } catch (e) { out.lateFreshKey = (e as MerchStripeError).kind; }
const x = await gw.expireCheckoutSession(a.id, ACCT);
out.expire = x.status;
const y = await gw.expireCheckoutSession(a.id, ACCT);
out.expireAgain = y.status;
console.log(JSON.stringify(out, null, 1));
