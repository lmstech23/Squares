// Confirming a standalone Entry Ticket purchase.
//
// ENTRY REVENUE IS AUTHORITATIVE AT THE CONTRIBUTION. `entryAmountCents` is the
// retained revenue for this purchase, and it is immutable after confirmation —
// an APPLICATION convention held by this file, its call sites and its tests,
// NOT by a database trigger. A pass going `void` later never rewrites it,
// `totalPaidCents`, or `raised`, which is why revenue is never recomputed by
// summing current pass state.
//
// ENTRY PASS PRICES RECONCILE AT CONFIRMATION. The passes carry per-unit prices
// for audit and display; at confirmation their sum must equal the
// contribution's amount exactly, asserted inside the confirming transaction.
// Afterwards the two are independent historical facts.
//
// Both are registered invariants, stated in fundraiser-board-v2.md §19.12 and
// indexed by invariant-registry.md. Cited here by NAME: a number in a comment
// goes stale silently, and the registry has already had one renumbering.

import type { Prisma } from "@prisma/client";
import { mintEntryPasses } from "./confirm-square.ts";
import { resolveSupporter } from "./admission.ts";
import type { EntryPrice } from "./entry-pricing.ts";

export class EntryAmountMismatch extends Error {
  // Plain fields, not TypeScript parameter properties: the node test runner
  // strips types rather than compiling, and a parameter property is syntax it
  // refuses outright. The whole file becomes unloadable.
  expected: number;
  actual: number;

  constructor(expected: number, actual: number) {
    super(`Entry passes sum to ${actual}, contribution says ${expected}`);
    this.name = "EntryAmountMismatch";
    this.expected = expected;
    this.actual = actual;
  }
}

/**
 * Confirm one standalone purchase: activate the supporter, write the grant,
 * mint the passes.
 *
 * ALL INSIDE THE CALLER'S TRANSACTION. The sum assertion below is worthless if
 * the money and the passes can commit separately.
 *
 * STANDALONE ENTRY NEVER DONATES ADMISSION. `donateAdmissions` is not a
 * parameter: a standalone grant is always false — the toggle is not shown, the
 * value is not accepted from a request, and
 * `admission_grants_standalone_never_donates` makes any other state
 * unrepresentable. The minting below is therefore UNCONDITIONAL, which is the
 * other half of the rule: a stale `true` reaching here must not be able to turn
 * a PAID purchase into zero passes.
 */
export async function confirmEntryPurchase(
  tx: Prisma.TransactionClient,
  input: {
    eventId: string;
    contributionId: string;
    entryAmountCents: number;
    passes: EntryPrice[];
    contact: { name: string; email: string; phone: string };
    /**
     * The help checkbox, as the contributor answered it at purchase.
     *
     * INTENT ONLY — invariant 36. It claims no slot and puts nobody on the
     * host's volunteer list; it decides whether this person is shown the
     * sign-up link on their receipt and confirmation screen. `HelperSignup`
     * remains the only record of an actual commitment.
     *
     * REQUIRED, not defaulted. It was a hardcoded `false` here, which is how
     * both entry paths silently recorded "not interested" for people who were
     * never asked. A caller that has no answer must say `false` on purpose.
     */
    wantsToHelp: boolean;
  }
): Promise<{ supporterId: string; grantId: string; passesMinted: number }> {
  // ENTRY PASS PRICES RECONCILE AT CONFIRMATION — the assertion, before
  // anything is written. Σ pass prices must equal the authoritative amount,
  // and it runs here rather than after the writes because the invariant is
  // stated as holding INSIDE the confirming transaction. The Stripe webhook
  // already refuses a session whose total disagrees with its ledger row rather
  // than confirming and reconciling later; this is the same rule for the same
  // reason.
  const sum = input.passes.reduce((n, p) => n + p.pricePaidCents, 0);
  if (sum !== input.entryAmountCents) {
    throw new EntryAmountMismatch(input.entryAmountCents, sum);
  }

  const supporter = await resolveSupporter(tx, input.eventId, input.contact);

  const grant = await tx.admissionGrant.create({
    data: {
      eventId: input.eventId,
      eventSupporterId: supporter.id,
      contributionId: input.contributionId,
      source: "STANDALONE",
      // STANDALONE ENTRY NEVER DONATES ADMISSION. Stated rather than defaulted
      // so the rule is visible at the write, not only in the schema.
      donateAdmissions: false,
      // Interest is a one-way OR across grants, read as EXISTS(grant WHERE
      // wantsToHelp) — sign-up addendum §4. Writing the buyer's own answer
      // here is what puts the sign-up link on their receipt.
      wantsToHelp: input.wantsToHelp,
    },
  });

  const passesMinted = await mintEntryPasses(tx, supporter.id, input.passes);

  // The grant id is what the confirmation email links to. A standalone
  // purchase has no square batch, so `squareBatchId` - the key the passes
  // screen was built around - is null here and cannot be the address.
  return { supporterId: supporter.id, grantId: grant.id, passesMinted };
}
