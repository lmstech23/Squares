import { PLATFORM_OWNER_ID } from "@/lib/constants";
import { getHost } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import Link from "next/link";
import { Suspense } from "react";
import { CreditBuyButton, CreditPurchasedBanner } from "./components/credit-ui";

export default async function HostBoardsPage() {
  const host = await getHost();
  if (!host) redirect("/login");

  // New hosts who haven't chosen payment method yet
  if (!host.paymentPreference) {
    redirect("/host/payment-setup");
  }


  // Only require Stripe for hosts who chose card payments
  if (host.paymentPreference === "stripe") {
    if (!host.stripeAccountId) {
      redirect("/host/stripe");
    }
    if (host.stripeAccountId && !host.stripeChargesEnabled) {
      redirect("/host/stripe?refresh=true");
    }
  }

  const boards = await prisma.board.findMany({
    where: { hostId: host.id },
    orderBy: { createdAt: "desc" },
    include: {
      _count: {
        select: {
          squares: { where: { paymentStatus: "paid" } },
        },
      },
    },
  });

  const isPlatformOwner = host.id === PLATFORM_OWNER_ID;
  const activeBoards = boards.filter((b) => b.status === "open" || b.status === "closed");
  const pendingBoards = boards.filter((b) => b.status === "pending_payment");
  const expiredBoards = boards.filter((b) => b.status === "expired");

  return (
    <div>
      {/* Credit badge — hidden for platform owner */}
      {!isPlatformOwner && (
        <div className="rounded-lg border border-gray-800 bg-gray-900 p-3 mb-6 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500">Board Credits:</span>
            <span className={`text-sm font-bold ${host.boardCredits > 0 ? "text-green-400" : "text-red-400"}`}>
              {host.boardCredits}
            </span>
          </div>
          {host.boardCredits === 0 && <CreditBuyButton />}
        </div>
      )}

      {/* Credit purchased banner */}
      <Suspense>
        <CreditPurchasedBanner />
      </Suspense>

      <div className="flex items-center justify-between mb-8">
        <h1 className="text-xl font-bold">Your Boards</h1>
        <Link
          href="/host/boards/new"
          className="rounded-lg bg-white text-gray-950 px-4 py-2 text-sm font-medium hover:bg-gray-200 transition-colors"
        >
          New Board
        </Link>
      </div>

      {/* Active boards (open + closed) */}
      {activeBoards.length === 0 && pendingBoards.length === 0 && expiredBoards.length === 0 ? (
        <div className="text-center py-16">
          <p className="text-gray-500 text-sm">No boards yet. Create your first one.</p>
        </div>
      ) : (
        <>
          {activeBoards.length > 0 && (
            <div className="space-y-3 mb-8">
              {activeBoards.map((board) => (
                <Link
                  key={board.boardId}
                  href={`/host/boards/${board.boardId}`}
                  className="block rounded-lg border border-gray-800 bg-gray-900 p-4 hover:border-gray-700 transition-colors"
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium">{board.gameName}</p>
                      <p className="text-xs text-gray-500 mt-0.5">
                        {board._count.squares} / {board.totalSquares} paid
                      </p>
                    </div>
                    <span
                      className={`text-xs px-2 py-0.5 rounded-full ${
                        board.status === "open"
                          ? "bg-green-950 text-green-400 border border-green-900"
                          : "bg-gray-800 text-gray-400 border border-gray-700"
                      }`}
                    >
                      {board.status}
                    </span>
                  </div>
                </Link>
              ))}
            </div>
          )}

          {/* Pending payment boards */}
          {pendingBoards.length > 0 && (
            <div className="mb-8">
              <h2 className="text-sm font-medium text-yellow-400 mb-3">Pending Payment</h2>
              <div className="space-y-3">
                {pendingBoards.map((board) => {
                  const hoursLeft = board.pendingExpiresAt
                    ? Math.max(0, Math.round((new Date(board.pendingExpiresAt).getTime() - Date.now()) / (1000 * 60 * 60)))
                    : 0;

                  return (
                    <div
                      key={board.boardId}
                      className="rounded-lg border border-yellow-900/50 bg-yellow-950/20 p-4"
                    >
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-sm font-medium">{board.gameName}</p>
                          <p className="text-xs text-yellow-500/70 mt-0.5">
                            Complete payment to activate · {hoursLeft}h remaining
                          </p>
                        </div>
                        <CreditBuyButton boardId={board.boardId} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Expired boards — collapsed section */}
          {expiredBoards.length > 0 && (
            <div>
              <details>
                <summary className="text-sm text-gray-500 cursor-pointer hover:text-gray-400 mb-3">
                  Expired ({expiredBoards.length})
                </summary>
                <div className="space-y-3">
                  {expiredBoards.map((board) => (
                    <div
                      key={board.boardId}
                      className="rounded-lg border border-gray-800/50 bg-gray-900/50 p-4 opacity-60"
                    >
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-sm font-medium text-gray-400">{board.gameName}</p>
                          <p className="text-xs text-gray-600 mt-0.5">
                            Expired before payment
                          </p>
                        </div>
                        <span className="text-xs px-2 py-0.5 rounded-full bg-gray-800 text-gray-500 border border-gray-700">
                          expired
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </details>
            </div>
          )}
        </>
      )}
    </div>
  );
}
