import { redirect } from "next/navigation";
import { getHost } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import CheckoutButtons from "./checkout-buttons";

interface Props {
  searchParams: Promise<{ boardId?: string }>;
}

export default async function CheckoutPage({ searchParams }: Props) {
  const host = await getHost();
  if (!host) redirect("/login");

  const params = await searchParams;
  const boardId = params.boardId;

  // If no boardId, send to dashboard
  if (!boardId) redirect("/host/boards");

  // Verify the board exists, belongs to host, and is pending
  const board = await prisma.board.findFirst({
    where: {
      boardId,
      hostId: host.id,
      status: "pending_payment",
    },
  });

  if (!board) redirect("/host/boards");


  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <div className="max-w-md mx-auto px-4 py-16">
        <h1 className="text-xl font-bold mb-2">Complete Your Board</h1>
        <p className="text-sm text-gray-400 mb-8">
          Purchase a board credit to activate{" "}
          <span className="text-white font-medium">{board.gameName}</span>.
        </p>

        <div className="rounded-lg border border-gray-800 bg-gray-900 p-5 mb-6">
          <div className="flex items-center justify-between mb-4">
            <span className="text-sm text-gray-400">Board</span>
            <span className="text-sm font-medium">{board.gameName}</span>
          </div>
          <div className="flex items-center justify-between mb-4">
            <span className="text-sm text-gray-400">Square price</span>
            <span className="text-sm font-medium">
              ${(board.squarePrice / 100).toFixed(0)}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm text-gray-400">Status</span>
            <span className="text-xs font-medium text-yellow-400 bg-yellow-400/10 px-2 py-0.5 rounded">
              Awaiting payment
            </span>
          </div>
        </div>

        <CheckoutButtons boardId={boardId} />

        <p className="text-xs text-gray-600 text-center mt-6">
          Board expires if not activated within 48 hours.
        </p>
      </div>
    </div>
  );
}
