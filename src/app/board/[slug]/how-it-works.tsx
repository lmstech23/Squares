// Contributor board panel — fundraiser-board-v2.md §6C.
//
// FUNDRAISER ONLY. Game Day renders player-board.tsx and never imports this.
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
//
// NOTHING HERE MENTIONS CHOOSING. This panel used to open with "Each square =
// 1 ticket" over "Choose one or more available squares", which described a
// picker that has not existed since purchase went quantity-first — the sheet
// assigns the next open positions from a number. It also carried a
// `selectedCount` prop that its only caller passed as a constant 0, so its
// button rendered permanently disabled reading "Select squares to continue":
// a dead control instructing the contributor to do something the page could
// not do. Both are gone. The button opens the sheet.
//
// NO BUTTON. This panel used to carry its own checkout button, which put a
// SECOND "Purchase tickets" on the page a few hundred pixels under the header
// one. Two identical primary actions is a question — "are these different?" —
// and the answer was no. The header CTA is the action; this card explains it.
//
// The square is not renamed anywhere internal — this is copy.

import { purchaseUnit } from "@/lib/board-vocabulary";

interface Props {
  hasEvent: boolean;
  hasPrize: boolean;
}

const heading =
  "text-[10px] font-medium text-gray-500 uppercase tracking-wider";

export default function HowItWorks({ hasEvent, hasPrize }: Props) {
  // One shared resolver, never branched locally — src/lib/board-vocabulary.ts.
  const u = purchaseUnit({ boardType: "fundraiser", hasEvent, hasPrize });

  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900 p-4 space-y-5">
      <div>
        <p className={heading}>How it works</p>
        {hasEvent ? (
          <>
            <p className="text-sm mt-2 font-medium">
              Pick how many {u.many} you want
            </p>
            <p className="text-sm text-gray-400 mt-1 leading-relaxed">
              {/* "One admission pass per ticket" states what they GET. The
                  old line stated an internal mapping — square to ticket —
                  which only makes sense if you already know squares exist. */}
              Each {u.one} includes one admission pass. Once your contribution
              is confirmed, your passes are emailed to you.
            </p>
          </>
        ) : (
          <>
            <p className="text-sm mt-2 font-medium">
              Pick how many {u.many} you want
            </p>
            <p className="text-sm text-gray-400 mt-1 leading-relaxed">
              Once your contribution is confirmed, you&apos;ll get a receipt by
              email.
            </p>
          </>
        )}
      </div>

      {/* Only when the host configured a prize. Absent, not softened. */}
      {hasPrize && (
        <div>
          <p className={heading}>Prize drawing</p>
          <p className="text-sm text-gray-400 mt-2 leading-relaxed">
            Each confirmed {u.one} gives you one entry in the drawing.
            {hasEvent
              ? " Drawing details will be included with your passes."
              : " Drawing details will be included with your receipt."}
          </p>
        </div>
      )}

    </div>
  );
}
