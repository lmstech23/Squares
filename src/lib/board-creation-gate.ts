// Who may create a board, and where the ones who may not are sent.
//
// ONE RULE, ONE IMPLEMENTATION. There are two gates between a host and a
// created board — the `/host/boards/new` page and `POST /api/boards` — and
// they have already drifted apart once. On 2026-02-25 both were fixed to let
// cash hosts through; on the same day `b771c68` reverted both while "removing
// dead paymentPreference refs"; `349529a` then restored the page and deleted
// the API gate outright, which is why that route's step numbering still jumps
// from 1 to 3. Two copies of a condition is how that happens. This is the copy.
//
// THE BUG THIS REPLACES WAS A DENYLIST. `!stripeChargesEnabled` asks "is Stripe
// unready" without first asking "does this host even use Stripe", so a host who
// never chose a payment preference is sent to Stripe — silently deciding a
// question the product exists to ask them. SYSTEM-FLOW §1C step 2 puts that host
// at payment setup.
//
// `stripeAccountId` IS DELIBERATELY NOT PART OF THIS. A cash host who started
// Stripe onboarding and abandoned it is still a cash host. Readiness is
// `stripeChargesEnabled`; anything else is a proxy that drifts.

/**
 * The payment preference as a closed set the compiler can reason about.
 *
 * The column is `String?`, so Prisma hands us `string | null` and a switch on it
 * directly cannot be made exhaustive. Parsing at the boundary buys that back
 * without a migration. Making it a Prisma enum is the right end state and is a
 * follow-up, not a hotfix.
 */
export type PaymentPreferenceState =
  | { kind: "UNSET" }
  | { kind: "CASH" }
  | { kind: "STRIPE" }
  | { kind: "UNRECOGNIZED"; raw: string };

/**
 * AN UNRECOGNIZED VALUE IS NOT THE SAME FACT AS AN UNSET ONE. Both hosts need
 * to land somewhere safe, but only one of them is normal. Collapsing the second
 * into the first routes the host correctly and destroys the only evidence that
 * something is writing garbage into the column — so they stay distinct cases and
 * the offending value travels with it.
 *
 * No UI can currently produce an unrecognized value: `POST /api/host/payment-
 * preference` accepts `"cash"` and `"stripe"` and 400s on anything else. That is
 * the reason to keep the branch, not a reason to drop it.
 */
export function parsePaymentPreference(
  raw: string | null | undefined
): PaymentPreferenceState {
  if (raw === null || raw === undefined) return { kind: "UNSET" };
  if (raw === "cash") return { kind: "CASH" };
  if (raw === "stripe") return { kind: "STRIPE" };
  return { kind: "UNRECOGNIZED", raw };
}

/** Why a host was refused. The three refusals mean different things and must not
 *  collapse into one message — most of all for the API, which cannot redirect
 *  and has only the body to explain itself with. */
export type GateRefusalReason =
  | "no-preference"
  | "unrecognized-preference"
  | "stripe-not-ready";

export type BoardCreationGate =
  | { allow: true }
  | {
      allow: false;
      reason: GateRefusalReason;
      /** Where the host should be sent. The page redirects here; the API names
       *  it in the 403 body so the form can route rather than show a dead end. */
      destination: "/host/payment-setup" | "/host/stripe";
      /** Safe to show a host. Never carries the raw preference value. */
      message: string;
    };

/** The fields the gate reads. Structural, so a `select` that narrows the Host
 *  row still satisfies it and neither consumer has to load the whole record. */
export interface BoardCreationGateHost {
  id: string;
  paymentPreference: string | null;
  /** `Boolean?` in the schema, so genuinely three-valued. Null is not ready. */
  stripeChargesEnabled: boolean | null;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled payment preference state: ${JSON.stringify(value)}`);
}

/**
 * ALLOWLIST, NOT DENYLIST — states that permit creation are named one at a time,
 * and the default is `assertNever`. Adding a fifth state later breaks the build
 * at every consumer, instead of falling silently into whichever branch a boolean
 * happens to land in.
 */
export function boardCreationGate(host: BoardCreationGateHost): BoardCreationGate {
  const state = parsePaymentPreference(host.paymentPreference);

  switch (state.kind) {
    case "UNSET":
      return {
        allow: false,
        reason: "no-preference",
        destination: "/host/payment-setup",
        message: "Choose how your players will pay before creating a board.",
      };

    case "CASH":
      // A cash host needs nothing from Stripe. This is the whole fix.
      return { allow: true };

    case "STRIPE":
      return host.stripeChargesEnabled
        ? { allow: true }
        : {
            allow: false,
            reason: "stripe-not-ready",
            destination: "/host/stripe",
            message: "Finish connecting Stripe to start accepting card payments.",
          };

    case "UNRECOGNIZED":
      // SERVER-SIDE ONLY, AND THE RAW VALUE STAYS HERE. The host sees the same
      // sentence an unset host sees; showing them a column value they did not
      // write explains nothing and leaks how the row is stored.
      console.warn("unrecognized payment preference", {
        hostId: host.id,
        raw: state.raw,
      });
      return {
        allow: false,
        reason: "unrecognized-preference",
        // Payment setup is the safe destination for both refusals that are not
        // about Stripe: it is the one screen that can repair the state, and it
        // asks a question rather than assuming an answer.
        destination: "/host/payment-setup",
        message: "Choose how your players will pay before creating a board.",
      };

    default:
      return assertNever(state);
  }
}
