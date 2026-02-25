import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { stripe } from "@/lib/stripe";

interface CheckoutBody {
  squareIds: string[];
  playerName: string;
  playerEmail: string;
}

// 30-minute checkout TTL (Stripe minimum for checkout sessions)
const CHECKOUT_TTL_MS = 30 * 60 * 1000;

export async function POST(request: Request) {
  try {
    const body: CheckoutBody = await request.json();

    // 1. Validate input — support legacy single squareId too
    let squareIds: string[] = body.squareIds;
    if (!squareIds && (body as any).squareId) {
      squareIds = [(body as any).squareId];
    }
    const { playerName, playerEmail } = body;

    if (
      !squareIds?.length ||
      !playerName?.trim() ||
      !playerEmail?.trim()
    ) {
      return NextResponse.json(
        { error: "Square IDs, name, and email are required." },
        { status: 400 }
      );
    }

    if (squareIds.length > 10) {
      return NextResponse.json(
        { error: "You can purchase up to 10 squares at a time." },
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

    // 2. Load all squares + board + host
    const squares = await prisma.square.findMany({
      where: { squareId: { in: squareIds } },
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

    if (squares.length !== squareIds.length) {
      return NextResponse.json(
        { error: "One or more squares not found." },
        { status: 404 }
      );
    }

    // All squares must belong to the same board
    const boardIds = new Set(squares.map((s) => s.boardId));
    if (boardIds.size > 1) {
      return NextResponse.json(
        { error: "All squares must be on the same board." },
        { status: 400 }
      );
    }

    const board = squares[0].board;

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

    // ✅ 4b. Resume gate: if player already has an active pending checkout
    //    on this board, return the existing Stripe session URL
    const now = new Date();

    const activePending = await prisma.square.findFirst({
      where: {
        boardId: board.boardId,
        playerEmail: email,
        paymentStatus: "pending",
        checkoutExpiresAt: { gt: now },
        stripePaymentId: { not: null },
      },
      select: {
        squareId: true,
        stripePaymentId: true,
        checkoutExpiresAt: true,
      },
    });

    if (activePending?.stripePaymentId) {
      try {
        const existing = await stripe.checkout.sessions.retrieve(
          activePending.stripePaymentId,
          { stripeAccount: board.host.stripeAccountId! }
        );

        // If Stripe session is still usable, return it
        if (existing?.url && existing.status === "open") {
          return NextResponse.json({
            checkoutUrl: existing.url,
            resumed: true,
            squareId: activePending.squareId,
            expiresAt: activePending.checkoutExpiresAt,
          });
        }
      } catch {
        // Session retrieval failed — treat as expired
      }

      // Stripe session isn't open anymore — release the stale holds
      await prisma.square.updateMany({
        where: {
          boardId: board.boardId,
          playerEmail: email,
          paymentStatus: "pending",
          stripePaymentId: activePending.stripePaymentId,
        },
        data: {
          paymentStatus: "open",
          playerName: null,
          playerEmail: null,
          checkoutExpiresAt: null,
          stripePaymentId: null,
          releaseReason: "expired",
        },
      });
    }

    // 5. Check max_squares_per_player (count paid + pending by email)
    //    Exclude squares being re-claimed (no double-counting)
    const playerSquareCount = await prisma.square.count({
      where: {
        boardId: board.boardId,
        playerEmail: email,
        paymentStatus: { in: ["paid", "pending"] },
        squareId: { notIn: squareIds },
      },
    });

    if (playerSquareCount + squareIds.length > board.maxSquaresPerPlayer) {
      const remaining = board.maxSquaresPerPlayer - playerSquareCount;
      return NextResponse.json(
        {
          error:
            remaining <= 0
              ? `You've reached the limit of ${board.maxSquaresPerPlayer} squares on this board.`
              : `You can only pick ${remaining} more square${remaining === 1 ? "" : "s"} on this board.`,
        },
        { status: 409 }
      );
    }

    // 5b. Cancel stale Stripe sessions for squares this player is re-claiming
    const existingPendingSquares = await prisma.square.findMany({
      where: {
        squareId: { in: squareIds },
        paymentStatus: "pending",
        playerEmail: email,
        stripePaymentId: { not: null },
      },
      select: { stripePaymentId: true },
    });

    if (existingPendingSquares.length > 0) {
      const sessionIds = new Set(
        existingPendingSquares.map((s) => s.stripePaymentId!)
      );
      for (const sessionId of sessionIds) {
        try {
          await stripe.checkout.sessions.expire(sessionId, {
            stripeAccount: board.host.stripeAccountId!,
          });
        } catch {
          // Session may already be expired — safe to ignore
        }
      }
    }

    // 6. Lock all squares as pending — single atomic updateMany
    //    OR clause: allows re-claiming own pending squares
    const expiresAt = new Date(Date.now() + CHECKOUT_TTL_MS);

    const { count: totalLocked } = await prisma.$transaction(async (tx) => {
      const result = await tx.square.updateMany({
        where: {
          squareId: { in: squareIds },
          OR: [
            { paymentStatus: "open" },
            {
              paymentStatus: "pending",
              playerEmail: email,
            },
          ],
        },
        data: {
          paymentStatus: "pending",
          playerName: name,
          playerEmail: email,
          checkoutExpiresAt: expiresAt,
          releaseReason: null,
        },
      });

      if (result.count !== squareIds.length) {
        throw new Error("SQUARE_TAKEN");
      }

      return result;
    });

    // 6b. Post-lock re-check: max_squares_per_player race condition
    const postLockCount = await prisma.square.count({
      where: {
        boardId: board.boardId,
        playerEmail: email,
        paymentStatus: { in: ["paid", "pending"] },
      },
    });

    if (postLockCount > board.maxSquaresPerPlayer) {
      await prisma.square.updateMany({
        where: { squareId: { in: squareIds }, paymentStatus: "pending" },
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

    const positions = squares
      .map((s) => s.position + 1)
      .sort((a, b) => a - b)
      .join(", ");

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
                  name:
                    squareIds.length === 1
                      ? `Square #${squares[0].position + 1}`
                      : `${squareIds.length} Squares (#${positions})`,
                  description: board.gameName,
                },
                unit_amount: board.squarePrice,
              },
              quantity: squareIds.length,
            },
          ],
          customer_email: email,
          metadata: {
            squareIds: squareIds.join(","),
            boardId: board.boardId,
            positions,
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
      console.error("Stripe Checkout creation failed:", stripeError);
      await prisma.square.updateMany({
        where: { squareId: { in: squareIds }, paymentStatus: "pending" },
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

    // 8. Store session ID on all squares
    await prisma.square.updateMany({
      where: {
        squareId: { in: squareIds },
        paymentStatus: "pending",
      },
      data: { stripePaymentId: session.id },
    });

    return NextResponse.json({ checkoutUrl: session.url });
  } catch (error) {
    if (error instanceof Error && error.message === "SQUARE_TAKEN") {
      return NextResponse.json(
        {
          error:
            "One or more selected squares were just taken. Please pick again.",
        },
        { status: 409 }
      );
    }

    console.error("Checkout error:", error);
    return NextResponse.json(
      { error: "Something went wrong. Please try again." },
      { status: 500 }
    );
  }
}
