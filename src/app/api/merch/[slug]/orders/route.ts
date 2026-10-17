// POST /api/merch/[slug]/orders — supporter submits sizes and details.
// Free orders confirm here and return the after-order link; paid orders are
// held, then the Checkout Session is created (spec §5.1, §5.7).

import { NextResponse, after } from "next/server";
import { createOrder, startCheckout } from "@/domain/merch/orders";
import { processOutbox } from "@/domain/merch/notifications";
import { merchDeps, outboxDeps } from "@/domain/merch/runtime";
import { clientIp, errorResponse } from "@/domain/merch/http";

export const runtime = "nodejs";

export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  // New-sale availability is enforced inside createOrder/startCheckout (deps.salesOpen).
  const { slug } = await ctx.params;
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  try {
    const deps = merchDeps();
    const outcome = await createOrder(
      {
        slug,
        idempotencyKey: String(body.idempotencyKey ?? ""),
        buyerName: body.name,
        buyerEmail: body.email,
        buyerPhone: body.phone,
        fulfillmentOptionId: body.fulfillmentOptionId,
        answers: body.answers,
        lines: Array.isArray(body.lines) ? (body.lines as { variantId: string; quantity: number }[]) : [],
        ip: clientIp(req),
      },
      deps
    );

    if (outcome.kind === "confirmed_free") {
      // Confirmation email after the response; it never delays navigation.
      after(() => processOutbox(outboxDeps(), { orderId: outcome.orderId }).catch(() => {}));
      return NextResponse.json({
        kind: "confirmed",
        next: outcome.redirectUrl ?? `/merch/order/${outcome.publicToken}`,
      });
    }

    const result = await startCheckout(outcome.orderId, deps);
    switch (result.kind) {
      case "redirect":
        return NextResponse.json({ kind: "checkout", next: result.url });
      case "retry":
        return NextResponse.json({ kind: "retry", token: outcome.publicToken }, { status: 202 });
      case "failed":
        return NextResponse.json({ kind: "failed", error: result.message }, { status: 502 });
      case "expired":
        return NextResponse.json({ kind: "failed", error: "Your checkout timed out. Please start again." }, { status: 409 });
      case "sales_closed":
        return NextResponse.json({ kind: "failed", error: "This sale isn't taking orders right now. Nothing was charged." }, { status: 409 });
      case "not_pending":
        return NextResponse.json({ kind: "done", next: `/merch/order/${outcome.publicToken}` });
    }
  } catch (e) {
    return errorResponse(e);
  }
}
