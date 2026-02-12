import { getHost } from "@/lib/auth";
import { redirect } from "next/navigation";
import NewBoardForm from "./form";

export default async function NewBoardPage() {
  const host = await getHost();
  if (!host) redirect("/login");

  // Hard block: no board creation without Stripe ready
  if (!host.stripeChargesEnabled) {
    redirect("/host/stripe");
  }

  return (
    <div className="max-w-lg mx-auto">
      <h1 className="text-xl font-bold mb-1">New Board</h1>
      <p className="text-sm text-gray-500 mb-8">
        Set the game, price, and payout split. You can share the link
        immediately after.
      </p>
      <NewBoardForm />
    </div>
  );
}
