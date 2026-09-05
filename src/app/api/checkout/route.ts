import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { stripe } from "@/lib/stripe";
import { randomUUID } from "crypto";
import { releaseAdmissionForBatch } from "@/lib/admission";
import { currentPriceCents } from "@/lib/claim-price";
import { MAX_PER_CLAIM } from "@/lib/claim-limits";
import { prepareAdmission } from "@/lib/admission";
import {
  createPendingCardContribution,
  MIN_CARD_DONATION_CENTS,
} from "@/lib/contributions";
import { baseUrlFromRequest } from "@/lib/base-url";

interface CheckoutBody {
  squareIds: string[];
  playerName: string;
  playerEmail: string;
  // Payout coordination
  playerPhone: string;
  playerPayoutMethod?: string | null;
  playerPayoutHandle?: string | null;
  smsOptIn?: boolean;
  /// Fundraiser only — "I'm not attending, donate my admissions" (v2 §6).
  donateAdmissions?: boolean;
  /// Fundraiser only — an extra donation riding on this checkout, donations §6.
  /// One session, two line items, one Contribution. Zero or absent means a
  /// plain square purchase and nothing about this route changes.
  donationAmountCents?: number;
}

// 30-minute checkout TTL (Stripe minimum for checkout sessions)
const CHECKOUT_TTL_MS = 10 * 60 * 1000; // 10-min DB hold for square lock
const STRIPE_SESSION_TTL_MS = 30 * 60 * 1000; // 30-min minimum required by Stripe

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

    const email = playerEmail.trim().toLowerCase();
    const name = playerName.trim();

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json(
        { error: "Valid email is required." },
        { status: 400 }
      );
    }
    
     const phone = body.playerPhone?.trim();
    if (!phone) {
      return NextResponse.json(
        { error: "Phone number is required." },
        { status: 400 }
      );
    }

    // 2. Load all requested squares + board + host
    let squares = await prisma.square.findMany({
      where: { squareId: { in: squareIds } },
      include: {
        board: {
          include: {
            host: {
              select: { stripeAccountId: true, stripeChargesEnabled: true },
            },
            event: { select: { id: true } },
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
    const isFundraiser = board.boardType === "fundraiser";
    const donateAdmissions = body.donateAdmissions ?? false;

    // PER TRANSACTION, GAME DAY ONLY — src/lib/claim-limits.ts.
    //
    // A FUNDRAISER'S ONLY CEILING IS INVENTORY. This guard was previously a
    // hardcoded `squareIds.length > 10` ABOVE the line that computes
    // `isFundraiser`, so it could not be scoped even in principle and refused
    // fundraiser checkouts of 11 or more. Nobody hit it because the claim
    // sheet's preset buttons stopped at 10; removing those presets uncapped
    // the path into it.
    //
    // It necessarily moves BELOW the board lookup, so a Game Day request for
    // more than the limit against a missing board now reports the missing
    // board first. Accepted deliberately: the limit is a property of the
    // board's type, and it cannot be applied before the type is known.
    if (!isFundraiser && squareIds.length > MAX_PER_CLAIM) {
      return NextResponse.json(
        { error: `You can purchase up to ${MAX_PER_CLAIM} squares at a time.` },
        { status: 400 }
      );
    }

    // 2b. Mixed checkout — donations §6. One session, two line items, one
    //     Contribution, confirming together or not at all (invariant 59).
    //     Game Day never carries donation money: nothing downstream of it
    //     knows what to do with the number (donations §5).
    const donationCents = Math.trunc(body.donationAmountCents ?? 0);
    if (donationCents < 0) {
      return NextResponse.json(
        { error: "Donation amount is not valid." },
        { status: 400 }
      );
    }
    if (donationCents > 0 && !isFundraiser) {
      return NextResponse.json(
        { error: "Donations are not available on this board." },
        { status: 400 }
      );
    }
    if (donationCents > 0 && donationCents < MIN_CARD_DONATION_CENTS) {
      return NextResponse.json(
        {
          error: `The minimum card donation is $${MIN_CARD_DONATION_CENTS / 100}.`,
        },
        { status: 400 }
      );
    }

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

    // ✅ 4b. Smart resume/merge for returning players
    //    - Same squares, no new picks → resume existing Stripe session
    //    - New squares added → cancel old session, merge, create new combined one
    const now = new Date();

    const myPendingSquares = await prisma.square.findMany({
      where: {
        boardId: board.boardId,
        playerEmail: email,
        paymentStatus: "pending",
      },
      select: {
        squareId: true,
        stripePaymentId: true,
        checkoutExpiresAt: true,
        batchId: true,
      },
    });

    // The donate checkbox states intent for the WHOLE checkout, not for
    // whichever fragment happened to be written last.
    //
    // Someone claims 2 squares, abandons, comes back and claims 2 more with
    // "I'm not attending" ticked. She experienced one checkout of 4 and expects
    // zero passes. Without this, the earlier grant still says
    // donateAdmissions = false and she is minted 2 passes she asked not to
    // have. So every grant taking part in the merge takes the current value.
    //
    // Grant-level, deliberately, not supporter-level: someone who attended in
    // September and makes a pure donation in October must not have September's
    // passes voided by October's checkbox. Addendum §6.
    const priorBatchIds = Array.from(
      new Set(
        myPendingSquares
          .map((sq) => sq.batchId)
          .filter((id): id is string => id != null)
      )
    );

    async function propagateDonateFlag() {
      if (!isFundraiser || !board.event || priorBatchIds.length === 0) return;
      await prisma.admissionGrant.updateMany({
        where: { squareBatchId: { in: priorBatchIds } },
        data: { donateAdmissions },
      });
    }

    if (myPendingSquares.length > 0) {
      const pendingIds = new Set(myPendingSquares.map((s) => s.squareId));
      const requestedIds = new Set(squareIds);

      // Check if player is just resuming (exact same squares, no additions)
      const isExactResume =
        pendingIds.size === requestedIds.size &&
        [...pendingIds].every((id) => requestedIds.has(id));

      if (isExactResume) {
        // Try to return existing Stripe session
        const sessionId = myPendingSquares.find(
          (s) => s.stripePaymentId
        )?.stripePaymentId;

        if (sessionId) {
          try {
            const existing = await stripe.checkout.sessions.retrieve(
              sessionId,
              { stripeAccount: board.host.stripeAccountId! }
            );

            if (existing?.url && existing.status === "open") {
              // Resuming reuses the existing grant, so the checkbox on this
              // submission would otherwise be silently discarded.
              await propagateDonateFlag();
              return NextResponse.json({
                checkoutUrl: existing.url,
                resumed: true,
              });
            }
          } catch {
            // Session retrieval failed — fall through to create new one
          }
        }
      }

      // Either new squares added or old session expired — cancel old session(s)
      const staleSessionIds = new Set(
        myPendingSquares
          .filter((s) => s.stripePaymentId)
          .map((s) => s.stripePaymentId!)
      );
      for (const sid of staleSessionIds) {
        try {
          await stripe.checkout.sessions.expire(sid, {
            stripeAccount: board.host.stripeAccountId!,
          });
        } catch {
          // Already expired — safe to ignore
        }
      }

      // Merge: add any pending squares not already in the request
      for (const id of pendingIds) {
        if (!requestedIds.has(id)) {
          squareIds.push(id);
        }
      }

      // Re-load full square set if we merged in extras
      if (squareIds.length !== requestedIds.size) {
        squares = await prisma.square.findMany({
          where: { squareId: { in: squareIds } },
          include: {
            board: {
              include: {
                host: {
                  select: { stripeAccountId: true, stripeChargesEnabled: true },
                },
                event: { select: { id: true } },
              },
            },
          },
        });
      }
    }

    // Fundraiser campaigns close on a date, not a board status — invariant 6.
    if (isFundraiser && board.campaignEndsAt && board.campaignEndsAt <= new Date()) {
      return NextResponse.json(
        { error: "This campaign has closed." },
        { status: 409 }
      );
    }

    // 5. Check max_squares_per_player (count paid + pending by email)
    //    Fundraiser boards skip this entirely — money doc §12 says the limit
    //    does not apply. There is no cap on how much one person may contribute.
    //    Exclude squares being re-claimed/merged (no double-counting)
    const playerSquareCount = await prisma.square.count({
      where: {
        boardId: board.boardId,
        playerEmail: email,
        paymentStatus: { in: ["paid", "pending"] },
        squareId: { notIn: squareIds },
      },
    });

    if (!isFundraiser && playerSquareCount + squareIds.length > board.maxSquaresPerPlayer) {
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

    // 6. Lock all squares as pending — single atomic updateMany
    //    OR clause: allows re-claiming own pending squares + locking new open ones
    // The hold is capped at campaign close — no hold of any kind survives it
    // (money doc §3).
    let expiresAt = new Date(Date.now() + CHECKOUT_TTL_MS);
    if (isFundraiser && board.campaignEndsAt && board.campaignEndsAt < expiresAt) {
      expiresAt = board.campaignEndsAt;
    }

    // Price is fixed now, at claim, and never recomputed — invariant 42.
    const claimPriceCents = isFundraiser
      ? currentPriceCents(board)
      : board.squarePrice;

    // One batch id per claim. Groups the squares and keys the admission grant,
    // which is what makes preparation idempotent under retry.
    const batchId = isFundraiser ? randomUUID() : null;

    const { contributionId } = await prisma.$transaction(async (tx) => {
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
          playerPhone: body.playerPhone?.trim() || null,
          playerPayoutMethod: (body.playerPayoutMethod as any) || null,
          playerPayoutHandle: body.playerPayoutHandle?.trim() || null,
          smsOptIn: body.smsOptIn ?? false,
          checkoutExpiresAt: expiresAt,
          releaseReason: null,
          ...(isFundraiser
            ? {
                pricePaidCents: claimPriceCents,
                batchId,
                holdExpiresAt: expiresAt,
                claimedAt: new Date(),
              }
            : {}),
        },
      });

      if (result.count !== squareIds.length) {
        throw new Error("SQUARE_TAKEN");
      }

      // Admission preparation — addendum §4. Same transaction as the squares,
      // so an abandoned claim never leaves a supporter behind. No passes yet:
      // a pending supporter owns zero pass records. Minting is one per square
      // at confirmation (A8).
      if (isFundraiser && board.event && batchId) {
        await prepareAdmission(
          tx,
          board.event.id,
          batchId,
          { name, email, phone },
          donateAdmissions
        );

        // Merged squares are re-batched onto the new id above, which leaves
        // any earlier grant carrying a stale flag. Bring it in line rather
        // than leaving two grants disagreeing about the same checkout.
        if (priorBatchIds.length > 0) {
          await tx.admissionGrant.updateMany({
            where: { squareBatchId: { in: priorBatchIds } },
            data: { donateAdmissions },
          });
        }
      }

      // The money ledger — donations §5, invariant 51. One Contribution per
      // checkout, carrying the square portion and the donation portion as two
      // separate integers that the CHECK constraint sums.
      //
      // Fundraiser only. Game Day squares stay outside the ledger entirely in
      // this phase, exactly as A1 left them.
      let contributionId: string | null = null;
      if (isFundraiser) {
        const contribution = await createPendingCardContribution(tx, {
          boardId: board.boardId,
          squareAmountCents: claimPriceCents * squareIds.length,
          donationAmountCents: donationCents,
          contributorName: name,
          contributorEmail: email,
          contributorPhone: phone ?? null,
          holdExpiresAt: expiresAt,
        });
        contributionId = contribution.id;
        await tx.square.updateMany({
          where: { squareId: { in: squareIds } },
          data: { contributionId },
        });
      }

      return { count: result.count, contributionId };
    });

    // 6b. Post-lock re-check: max_squares_per_player race condition
    const postLockCount = await prisma.square.count({
      where: {
        boardId: board.boardId,
        playerEmail: email,
        paymentStatus: { in: ["paid", "pending"] },
      },
    });

    if (!isFundraiser && postLockCount > board.maxSquaresPerPlayer) {
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
    // The origin the contributor is actually on — never the configured
    // production URL, which would redirect them out of this deployment after
    // paying. Applies to Game Day too, and on production resolves to the same
    // value it always did.
    const baseUrl = baseUrlFromRequest(request);
    const boardUrl = `${baseUrl}/board/${board.slug}`;

    const positionNumbers = squares.map((s) => s.position + 1).sort((a, b) => a - b);

    // Stripe caps a metadata VALUE at 500 characters, and a product name is
    // shown on the receipt. Ninety-seven comma-joined numbers is ~380
    // characters of receipt line, so summarise past a threshold rather than
    // embedding the list.
    const POSITION_LIST_MAX = 12;
    const positions =
      positionNumbers.length <= POSITION_LIST_MAX
        ? positionNumbers.join(", ")
        : `#${positionNumbers[0]}-#${positionNumbers[positionNumbers.length - 1]}`;

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
                      : positionNumbers.length <= POSITION_LIST_MAX
                        ? `${squareIds.length} squares (#${positions})`
                        : `${squareIds.length} squares (${positions})`,
                  description: board.gameName,
                },
                unit_amount: claimPriceCents,
              },
              quantity: squareIds.length,
            },
            // The donation rides on the same session as a second line item —
            // donations §6. One payment, one Contribution, confirming together
            // or not at all (invariant 59). There is deliberately no second
            // payment intent: a partial-success state is forbidden by
            // invariant 61.
            ...(donationCents > 0
              ? [
                  {
                    price_data: {
                      currency: board.currency.toLowerCase(),
                      product_data: { name: "Extra donation" },
                      unit_amount: donationCents,
                    },
                    quantity: 1,
                  },
                ]
              : []),
          ],
          customer_email: email,
          // COMPACT BY NECESSITY. `squareIds: squareIds.join(",")` used to
          // live here — 36-character uuids plus separators, which overflows
          // Stripe's 500-character metadata limit at about thirteen squares and
          // fails session creation. The webhook now resolves squares from
          // `Square.checkoutSessionId` instead, so the list is not needed.
          //
          // Game Day still sends it: those squares never get a
          // `checkoutSessionId`, so the metadata IS the webhook's only handle
          // on them. Its 10-square MAX_PER_CLAIM keeps it near 370 characters,
          // inside the limit.
          metadata: {
            squareId: squareIds[0],
            boardId: board.boardId,
            positions,
            squareCount: String(squareIds.length),
            ...(isFundraiser
              ? { batchId: batchId ?? "" }
              : { squareIds: squareIds.join(",") }),
          },
          success_url: `${boardUrl}?success=true&session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${boardUrl}?cancelled=true`,
          expires_at: Math.floor((Date.now() + STRIPE_SESSION_TTL_MS) / 1000),
        },
        {
          stripeAccount: board.host.stripeAccountId,
        }
      );
    } catch (stripeError) {
      console.error("Stripe Checkout creation failed:", stripeError);

      // COMPLETE ROLLBACK.
      //
      // This used to clear only the Game Day fields, leaving a fundraiser
      // square `open` while still carrying batchId, holdExpiresAt,
      // pricePaidCents, claimedAt and playerPhone. An `open` square with a
      // price contradicts the schema's own rule that price is written when a
      // square LEAVES open, and a retained batchId keeps an AdmissionGrant
      // pointing at squares nobody holds.
      //
      // Mirrors the release in resolveExpiredHolds, which is the reference for
      // what "back to open" means on a fundraiser board.
      try {
        await prisma.square.updateMany({
          where: { squareId: { in: squareIds }, paymentStatus: "pending" },
          data: {
            paymentStatus: "open",
            playerName: null,
            playerEmail: null,
            playerPhone: null,
            checkoutExpiresAt: null,
            stripePaymentId: null,
            releaseReason: "failed",
            ...(isFundraiser
              ? {
                  batchId: null,
                  holdExpiresAt: null,
                  checkoutSessionId: null,
                  pricePaidCents: null,
                  claimedAt: null,
                  // An `open` square must never carry a contribution link —
                  // the same rule A1's gate 3 asserts at migration time.
                  contributionId: null,
                }
              : {}),
          },
        });

        // The Contribution was created by THIS request inside the lock
        // transaction, before Stripe was called, and has no session behind it.
        // Release it for the same reason the grant is cleaned up here.
        if (contributionId) {
          await prisma.contribution.updateMany({
            where: { id: contributionId, status: "pending" },
            data: { status: "released", releasedAt: new Date() },
          });
        }

        // The grant and supporter were created by THIS request, inside the
        // lock transaction, before Stripe was called. They are orphaned only
        // because this request failed, so this request cleans them up.
        // Idempotent and guarded: it refuses to delete while any square in the
        // batch is still live, and never touches an active supporter.
        if (isFundraiser && batchId) {
          await releaseAdmissionForBatch(batchId);
        }
      } catch (rollbackError) {
        // DISTINCT, not folded into a generic 500. This is the only path that
        // can leave squares `pending` with no Stripe session behind them, and
        // it needs to be findable in logs by its own name.
        //
        // Recovery is already covered, verified rather than assumed:
        //   fundraiser -> resolveHoldBatch selects on batchId, finds no
        //     checkoutSessionId, and its no-session branch releases the batch
        //     ("nothing that could still pay").
        //   game day   -> a failed updateMany writes NOTHING, so the square
        //     keeps paymentStatus 'pending' AND checkoutExpiresAt, which is
        //     exactly what the cron's Game Day sweep selects on.
        // No extra recovery is added here because both paths already resolve.
        console.error(
          "CHECKOUT_ROLLBACK_FAILED: squares may remain pending until the cron " +
            "sweeps them.",
          { squareIds, batchId, isFundraiser, rollbackError }
        );
      }

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
      data: {
        stripePaymentId: session.id,
        ...(isFundraiser ? { checkoutSessionId: session.id } : {}),
      },
    });

    // ...and on the contribution, which is what the webhook looks up
    // (donations §6, "Lookup key: Contribution.checkoutSessionId").
    if (contributionId) {
      await prisma.contribution.update({
        where: { id: contributionId },
        data: { checkoutSessionId: session.id },
      });
    }

    return NextResponse.json({
      checkoutUrl: session.url,
      // The client renders its countdown against this server timestamp, never
      // a local counter (money doc §3).
      ...(isFundraiser
        ? {
            holdExpiresAt: expiresAt.toISOString(),
            batchId,
            positions: squares.map((sq) => sq.position).sort((a, b) => a - b),
            squareIds,
          }
        : {}),
    });
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
