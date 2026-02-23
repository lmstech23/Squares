import { getHost } from "@/lib/auth";
// ============================================================
// src/app/api/host/credits/route.ts
//
// Returns current credit balance + recent transaction history.
// Used by the dashboard to display the CreditBadge and
// optionally a transaction log.
// ============================================================

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { CREDIT_PRICE_CENTS, CREDIT_PRICE_DISPLAY } from "@/lib/constants";

export async function GET(request: Request) {
  try {
    const host = await getHost();
    if (!host) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 }
      );
    }

    const transactions = await prisma.creditTransaction.findMany({
      where: { hostId: host.id },
      orderBy: { createdAt: "desc" },
      take: 20,
    });

    return NextResponse.json({
      boardCredits: host.boardCredits,
      pricePerBoard: CREDIT_PRICE_CENTS,
      priceDisplay: CREDIT_PRICE_DISPLAY,
      transactions: transactions.map((tx) => ({
        id: tx.id,
        type: tx.type,
        amount: tx.amount,
        balanceAfter: tx.balanceAfter,
        note: tx.note,
        createdAt: tx.createdAt,
      })),
    });
  } catch (error) {
    console.error("Credits fetch error:", error);
    return NextResponse.json(
      { error: "Failed to fetch credits." },
      { status: 500 }
    );
  }
}
