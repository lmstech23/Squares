import { getHost } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import Link from "next/link";

export default async function HostBoardsPage() {
  const host = await getHost();
  if (!host) redirect("/login");

  // No Stripe at all — send them to connect
  if (!host.stripeAccountId) {
    redirect("/host/stripe");
  }

  // Started Stripe but didn't finish — send them back to complete it
  if (host.stripeAccountId && !host.stripeChargesEnabled) {
    redirect("/host/stripe?refresh=true");
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

  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <h1 className="text-xl font-bold">Your Boards</h1>
        <Link
          href="/host/boards/new"
          className="rounded-lg bg-white text-gray-950 px-4 py-2 text-sm font-medium hover:bg-gray-200 transition-colors"
        >
          New Board
        </Link>
      </div>

      {/* Board list */}
      {boards.length === 0 ? (
        <div className="text-center py-16">
          <p className="text-gray-500 text-sm">
            No boards yet. Create your first one.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {boards.map((board) => (
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
    </div>
  );
}
