// Contributor board panel — fundraiser-board-v2.md §6C.
//
// Replaces the Game Day "Payment & Payouts" panel, which is an instruction
// manual for a different product: Stripe explanations, PIN explanations, and
// an "If you win" section on a board that has no prize.
//
// Prize language is gated on `hasPrize` — that is prizePoolPercent > 0, never
// board type. A Phase B fundraiser WITH prizes needs the drawing block back,
// and gating on type would deny it.
//
// One checkout action, not a payment picker. The method choice lives in the
// claim sheet where the contributor is actually paying — asking it here too is
// the same question twice, and listing the handles puts the host's personal
// contact details on a public page.

interface Props {
  hasEvent: boolean;
  hasPrize: boolean;
  selectedCount: number;
  onCheckout: () => void;
}

const heading =
  "text-[10px] font-medium text-gray-500 uppercase tracking-wider";

export default function HowItWorks({
  hasEvent,
  hasPrize,
  selectedCount,
  onCheckout,
}: Props) {
  const unit = hasEvent
    ? selectedCount === 1
      ? "ticket"
      : "tickets"
    : selectedCount === 1
      ? "square"
      : "squares";

  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900 p-4 space-y-5">
      <div>
        <p className={heading}>How it works</p>
        {hasEvent ? (
          <>
            <p className="text-sm mt-2 font-medium">Each square = 1 ticket</p>
            <p className="text-sm text-gray-400 mt-1 leading-relaxed">
              Choose one or more available squares. Once your contribution is
              confirmed, your ticket(s) will be emailed to you.
            </p>
          </>
        ) : (
          <p className="text-sm text-gray-400 mt-2 leading-relaxed">
            Choose one or more available squares. Once your contribution is
            confirmed, you&apos;ll get a receipt by email.
          </p>
        )}
      </div>

      {/* Only when the host configured a prize. Absent, not softened. */}
      {hasPrize && (
        <div>
          <p className={heading}>Prize drawing</p>
          <p className="text-sm text-gray-400 mt-2 leading-relaxed">
            Each paid square gives you one entry in the drawing.
            {hasEvent
              ? " Drawing details will be included with your ticket."
              : " Drawing details will be included with your receipt."}
          </p>
        </div>
      )}

      <button
        type="button"
        onClick={onCheckout}
        disabled={selectedCount === 0}
        className="w-full rounded-lg bg-white px-4 py-3 text-sm font-medium text-gray-950 hover:bg-gray-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        {selectedCount === 0
          ? "Select squares to continue"
          : `Checkout — ${selectedCount} ${unit}`}
      </button>
    </div>
  );
}
