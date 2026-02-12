import { getHost } from "@/lib/auth";
import { stripe } from "@/lib/stripe";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import Link from "next/link";

export default async function StripeReturnPage() {
  const host = await getHost();
  if (!host) redirect("/login");

  // Check Stripe account status directly (webhook may not have fired yet)
  let ready = false;
  if (host.stripeAccountId) {
    try {
      const account = await stripe.accounts.retrieve(host.stripeAccountId);
      ready = !!account.charges_enabled && !!account.payouts_enabled;

      // Sync to DB immediately — don't wait for webhook
      if (
        ready &&
        (!host.stripeChargesEnabled || !host.stripePayoutsEnabled)
      ) {
        await prisma.host.update({
          where: { id: host.id },
          data: {
            stripeChargesEnabled: !!account.charges_enabled,
            stripePayoutsEnabled: !!account.payouts_enabled,
          },
        });
      }
    } catch (err) {
      console.error("Failed to check Stripe account:", err);
    }
  }

  if (ready) {
    return (
      <div className="max-w-md mx-auto py-12 text-center">
        <div className="text-3xl mb-4">✓</div>
        <h1 className="text-xl font-bold mb-2">Stripe connected</h1>
        <p className="text-sm text-gray-500 mb-6">
          You&apos;re ready to create boards and accept payments.
        </p>
        <Link
          href="/host/boards"
          className="inline-block rounded-lg bg-white text-gray-950 px-6 py-2.5 text-sm font-medium hover:bg-gray-200 transition-colors"
        >
          Go to boards
        </Link>
      </div>
    );
  }

  // Not ready yet — might need more info from Stripe
  return (
    <div className="max-w-md mx-auto py-12 text-center">
      <h1 className="text-xl font-bold mb-2">Almost there</h1>
      <p className="text-sm text-gray-500 mb-6">
        Stripe needs a bit more information before you can accept payments.
        This is normal — click below to finish up.
      </p>
      <Link
        href="/host/stripe"
        className="inline-block rounded-lg bg-indigo-600 text-white px-6 py-2.5 text-sm font-medium hover:bg-indigo-500 transition-colors"
      >
        Continue setup
      </Link>
    </div>
  );
}
