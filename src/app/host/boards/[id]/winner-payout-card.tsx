"use client";

interface WinnerPayoutCardProps {
  label: string;
  playerName: string | null;
  scoreDisplay: string;
  amount: number;
  playerPayoutMethod: string | null;
  playerPayoutHandle: string | null;
  playerPhone: string | null;
}

export default function WinnerPayoutCard({
  label,
  playerName,
  scoreDisplay,
  amount,
  playerPayoutMethod,
  playerPayoutHandle,
  playerPhone,
}: WinnerPayoutCardProps) {
  const payoutDisplay = (() => {
    if (!playerPayoutMethod) {
      return playerPhone
        ? `No payout method — contact ${playerPhone}`
        : "No payout method on file";
    }
    if (playerPayoutMethod === "cash") {
      return "Cash (pay in person)";
    }
    const methodLabel =
      playerPayoutMethod === "venmo"
        ? "Venmo"
        : playerPayoutMethod === "zelle"
          ? "Zelle"
          : "CashApp";
    return `${methodLabel}: ${playerPayoutHandle || "—"}`;
  })();

  return (
    <div className="rounded-lg border border-green-900/50 bg-green-950/30 p-4">
      <div className="flex items-center justify-between mb-1">
        <span className="text-[10px] uppercase tracking-wider text-yellow-400 font-bold">
          {label} WINNER
        </span>
        <span className="text-sm font-bold text-green-300">${(amount / 100).toFixed(0)}</span>
      </div>
      <p className="text-sm font-semibold text-white">
        {playerName || "—"}
      </p>
      <p className="text-xs text-gray-400 mt-0.5">{scoreDisplay}</p>
      <p className="text-xs text-yellow-300/80 mt-2 flex items-center gap-1">
        <span>💰</span> {payoutDisplay}
      </p>
    </div>
  );
}
