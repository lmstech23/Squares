import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { prisma } from "@/lib/prisma";
import { stripe } from "@/lib/stripe";

export async function POST(request: Request) {
  try {
    // 1. Authenticate
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const host = await prisma.host.findUnique({
      where: { supabaseUserId: user.id },
    });

    if (!host) {
      return NextResponse.json({ error: "Host not found" }, { status: 404 });
    }

    const baseUrl = process.env.NEXT_PUBLIC_URL!;

    // 2. Create or retrieve Connect Express account
    let stripeAccountId = host.stripeAccountId;

    if (!stripeAccountId) {
      const account = await stripe.accounts.create({
        type: "express",
        email: host.email ?? undefined,
        metadata: {
          hostId: host.id,
        },
      });
      stripeAccountId = account.id;

      await prisma.host.update({
        where: { id: host.id },
        data: { stripeAccountId },
      });
    }

    // 3. Generate Account Link for onboarding
    const accountLink = await stripe.accountLinks.create({
      account: stripeAccountId,
      refresh_url: `${baseUrl}/host/stripe?refresh=true`,
      return_url: `${baseUrl}/host/stripe/return`,
      type: "account_onboarding",
    });

    return NextResponse.json({ url: accountLink.url });
  } catch (error) {
    console.error("Stripe Connect error:", error);
    return NextResponse.json(
      { error: "Failed to create Stripe onboarding link" },
      { status: 500 }
    );
  }
}
