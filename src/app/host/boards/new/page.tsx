import { getHost } from "@/lib/auth";
import { boardCreationGate } from "@/lib/board-creation-gate";
import { redirect } from "next/navigation";
import NewBoardFlow from "./new-board-flow";
import Link from "next/link";

export default async function NewBoardPage() {
  const host = await getHost();
  if (!host) redirect("/login");
  // Gate #3. The condition lives in `@/lib/board-creation-gate` because the API
  // gate below it must agree, and the two drifted apart once already.
  const gate = boardCreationGate(host);
  if (!gate.allow) redirect(gate.destination);


  return (
    <div className="max-w-lg mx-auto">
      <Link
        href="/host/boards"
        className="text-sm text-gray-400 hover:text-white mb-6 inline-block"
      >
        ← Back to Boards
      </Link>
      <h1 className="text-xl font-bold mb-1">New Board</h1>
      <p className="text-sm text-gray-500 mb-8">
        Set the game, price, and payout split. You can share the link
        immediately after.
      </p>
      <NewBoardFlow isCashHost={host.paymentPreference === "cash"} />
    </div>
  );
}
