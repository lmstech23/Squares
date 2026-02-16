import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { stripe } from "@/lib/stripe";

interface CheckoutBody {
  squareId: string;
  playerName: string;
  playerEmail: string;
}

// 30-minute checkout TTL (Stripe minimum for checkout sessions)
const CHECKOUT_TTL_MS = 30 * 60 * 1000;

export async function POST(request: Request) {
  try {
    const body: CheckoutBody = await request.json();

    // 1. Validate input
    const { squareId, playerName, playerEmail } = body;

    if (!squareId || !playerName?.trim() || !playerEmail?.trim()) {
      return NextResponse.json(
        { error: "Square ID, name, and email are required." },
        { status: 400 }
      );
    }

    const email = playerEmail.trim().toLowerCase();
    const name = playerName.trim();

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json(
        { error: "Valid email is required." },
        { status: 400 }
      );
    }

    // 2. Load square + board + host in one query
    const square = await prisma.square.findUnique({
      where: { squareId },
      include: {
        board: {
          include: {
            host: {
              select: { stripeAccountId: true, stripeChargesEnabled: true },
            },
          },
        },
      },
    });

    if (!square) {
      return NextResponse.json(
        { error: "Square not found." },
        { status: 404 }
      );
    }

    const { board } = square;

    // 3. Board must be open
    if (board.status !== "open") {
      return NextResponse.json(
        { error: "This board is no longer accepting squares." },
        { status: 409 }
      );
    }

    // 4. Host must have Stripe connected and charges enabled
    if (!board.host.stripeAccountId || !board.host.stripeChargesEnabled) {
      return NextResponse.json(
        { error: "Host payment setup is incomplete." },
        { status: 503 }
      );
    }

    // 5. Check max_squares_per_player (count paid + pending by email on this board)
    const playerSquareCount = await prisma.square.count({
      where: {
        boardId: board.boardId,
        playerEmail: email,
        paymentStatus: { in: ["paid", "pending"] },
      },
    });

    if (playerSquareCount >= board.maxSquaresPerPlayer) {
      return NextResponse.json(
        {
          error: `You've reached the limit of ${board.maxSquaresPerPlayer} squares on this board.`,
        },
        { status: 409 }
      );
    }

    // 6. Lock square as pending — optimistic lock via updateMany + count.
    //    paymentStatus is not part of a unique constraint, so update() can't
    //    filter on it. updateMany returns { count } — if 0, square was taken.
    const expiresAt = new Date(Date.now() + CHECKOUT_TTL_MS);

    const { count: lockCount } = await prisma.square.updateMany({
      where: {
        squareId,
        paymentStatus: "open",
      },
      data: {
        paymentStatus: "pending",
        playerName: name,
        playerEmail: email,
        checkoutExpiresAt: expiresAt,
        releaseReason: null,
      },
    });

    if (lockCount === 0) {
      return NextResponse.json(
        { error: "This square is no longer available. Pick another one." },
        { status: 409 }
      );
    }

    // 6b. Post-lock re-check: max_squares_per_player race condition.
    //     Two simultaneous requests by the same email can both pass step 5,
    //     both lock different squares, exceeding the limit. Re-count now
    //     that this square is pending and release if over.
    const postLockCount = await prisma.square.count({
      where: {
        boardId: board.boardId,
        playerEmail: email,
        paymentStatus: { in: ["paid", "pending"] },
      },
    });

    if (postLockCount > board.maxSquaresPerPlayer) {
      // Release the square we just locked
      await prisma.square.updateMany({
        where: { squareId, paymentStatus: "pending" },
        data: {
          paymentStatus: "open",
          playerName: null,
          playerEmail: null,
          checkoutExpiresAt: null,
          releaseReason: null,
        },
      });

      return NextResponse.json(
        {
          error: `You've reached the limit of ${board.maxSquaresPerPlayer} squares on this board.`,
        },
        { status: 409 }
      );
    }

    // 7. Create Stripe Checkout session
    const baseUrl =
      process.env.NEXT_PUBLIC_URL ||
      request.headers.get("origin") ||
      "http://localhost:3000";
    const boardUrl = `${baseUrl}/board/${board.slug}`;

    let session;
    try {
      session = await stripe.checkout.sessions.create(
        {
          mode: "payment",
          line_items: [
            {
              price_data: {
                currency: board.currency.toLowerCase(),
                product_data: {
                  name: `Square #${square.position + 1}`,
                  description: board.gameName,
                },
                unit_amount: board.squarePrice,
              },
              quantity: 1,
            },
          ],
          customer_email: email,
          metadata: {
            squareId: square.squareId,
            boardId: board.boardId,
            position: String(square.position),
          },
          success_url: `${boardUrl}?success=true&session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${boardUrl}?cancelled=true`,
          expires_at: Math.floor(expiresAt.getTime() / 1000),
        },
        {
          stripeAccount: board.host.stripeAccountId,
        }
      );
    } catch (stripeError) {
      // Roll back the pending lock if Stripe fails
      console.error("Stripe Checkout creation failed:", stripeError);
      await prisma.square.updateMany({
        where: { squareId, paymentStatus: "pending" },
        data: {
          paymentStatus: "open",
          playerName: null,
          playerEmail: null,
          checkoutExpiresAt: null,
          stripePaymentId: null,
          releaseReason: "failed",
        },
      });

      return NextResponse.json(
        { error: "Payment setup failed. Please try again." },
        { status: 502 }
      );
    }

    // 8. Store session ID on square (guarded — only if still pending and no session yet)
    const { count: writeCount } = await prisma.square.updateMany({
      where: { squareId, paymentStatus: "pending", stripePaymentId: null },
      data: {
        stripePaymentId: session.id,
      },
    });

    if (writeCount === 0) {
      // Square state changed between step 6 and step 8. The Stripe session
      // exists but the square doesn't know about it. Webhook will still work
      // via metadata, but log for visibility.
      console.warn(
        `Checkout step 8: failed to write session ${session.id} to square ${squareId} (state changed)`
      );
    }

    return NextResponse.json({ checkoutUrl: session.url });
  } catch (error) {
    console.error("Checkout error:", error);
    return NextResponse.json(
      { error: "Something went wrong. Please try again." },
      { status: 500 }
    );
  }
}
