const fs = require("fs");
const path = require("path");

// 1. Fix squares polling route
const sqDir = path.join("src","app","api","board","[slug]","squares");
fs.mkdirSync(sqDir, { recursive: true });
fs.writeFileSync(path.join(sqDir, "route.ts"), `import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;

  const board = await prisma.board.findUnique({
    where: { slug },
    select: {
      squares: {
        orderBy: { position: "asc" },
        select: {
          squareId: true,
          position: true,
          playerName: true,
          paymentStatus: true,
        },
      },
    },
  });

  if (!board) {
    return NextResponse.json({ error: "Board not found" }, { status: 404 });
  }

  return NextResponse.json({ squares: board.squares });
}
`);
console.log("Created squares polling route");

// 2. Update checkout success_url
let checkout = fs.readFileSync("src/app/api/checkout/route.ts", "utf8");
checkout = checkout.replace(
  "success_url: `${boardUrl}?success=true`",
  "success_url: `${boardUrl}?success=true&session_id={CHECKOUT_SESSION_ID}`"
);
fs.writeFileSync("src/app/api/checkout/route.ts", checkout);
console.log("Updated checkout success_url");

// 3. Update player-board.tsx - add polling
let pb = fs.readFileSync("src/app/board/[slug]/player-board.tsx", "utf8");
pb = pb.replace(
  'import { useState, useCallback } from "react";',
  'import { useState, useCallback, useEffect } from "react";'
);
pb = pb.replace(
  "const [squares] = useState(initialSquares);",
  "const [squares, setSquares] = useState(initialSquares);"
);
// Add polling useEffect after the winnerSet line
pb = pb.replace(
  "const winnerSet = new Set(winnerPositionsArr ?? []);",
  `const winnerSet = new Set(winnerPositionsArr ?? []);

  // Poll for square updates when there are pending squares
  useEffect(() => {
    if (!squares.some((s) => s.paymentStatus === "pending")) return;

    const id = setInterval(async () => {
      try {
        const res = await fetch(\`/api/board/\${slug}/squares\`, { cache: "no-store" });
        if (!res.ok) return;
        const data = await res.json();
        setSquares(data.squares);
      } catch {
        // ignore
      }
    }, 2000);

    return () => clearInterval(id);
  }, [slug, squares]);`
);
fs.writeFileSync("src/app/board/[slug]/player-board.tsx", pb);
console.log("Updated player-board.tsx with polling");

// 4. Update page.tsx - add redirect confirmation + host select
let page = fs.readFileSync("src/app/board/[slug]/page.tsx", "utf8");

// Add stripeAccountId to host select
page = page.replace(
  'select: { name: true },',
  'select: { name: true, stripeAccountId: true },'
);

// Add payment confirmation after notFound() check
page = page.replace(
  "if (!board) notFound();",
  `if (!board) notFound();

  // Confirm payment on redirect (webhook fallback)
  if (sp.session_id && sp.success === "true") {
    try {
      const { stripe } = await import("@/lib/stripe");
      const session = await stripe.checkout.sessions.retrieve(
        sp.session_id,
        { expand: [] },
        { stripeAccount: board.host.stripeAccountId ?? undefined }
      );

      if (session.payment_status === "paid" && session.metadata?.squareId) {
        const targetSquareId = session.metadata.squareId;
        const existing = await prisma.paymentReference.findUnique({
          where: { stripeSessionId: session.id },
        });

        if (!existing) {
          try {
            await prisma.$transaction(async (tx) => {
              const { count } = await tx.square.updateMany({
                where: {
                  squareId: targetSquareId,
                  paymentStatus: "pending",
                  stripePaymentId: session.id,
                },
                data: {
                  paymentStatus: "paid",
                  checkoutExpiresAt: null,
                  releaseReason: null,
                },
              });

              if (count > 0) {
                await tx.paymentReference.create({
                  data: {
                    squareId: targetSquareId,
                    stripeSessionId: session.id,
                    amount: session.amount_total ?? 0,
                  },
                });
              }
            });
          } catch (e) {
            console.error("Redirect payment confirmation failed:", e);
          }
        }

        // Re-fetch squares after confirming
        const refreshed = await prisma.square.findMany({
          where: { boardId: board.boardId },
          orderBy: { position: "asc" },
          select: {
            squareId: true,
            position: true,
            playerName: true,
            paymentStatus: true,
          },
        });
        board.squares = refreshed;
      }
    } catch (e) {
      console.error("Stripe session retrieve failed:", e);
    }
  }`
);

fs.writeFileSync("src/app/board/[slug]/page.tsx", page);
console.log("Updated page.tsx with redirect confirmation");

console.log("\nAll patches applied!");
