#!/bin/bash
set -e

echo "=== Stripe Gate Removal ==="
echo ""

# -------------------------------------------------------
# 1. src/app/host/boards/new/page.tsx
#    Remove the Stripe redirect gate
# -------------------------------------------------------
echo "1/5  src/app/host/boards/new/page.tsx"

cat > src/app/host/boards/new/page.tsx << 'EOF'
import { getHost } from "@/lib/auth";
import { redirect } from "next/navigation";
import NewBoardForm from "./form";

export default async function NewBoardPage() {
  const host = await getHost();
  if (!host) redirect("/login");

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
EOF
echo "  ✓ Stripe redirect removed"

# -------------------------------------------------------
# 2. src/app/api/boards/route.ts
#    Remove the stripeChargesEnabled 403 gate
# -------------------------------------------------------
echo "2/5  src/app/api/boards/route.ts"

# Delete the Stripe readiness gate block (the if + return + closing brace)
sed -i '/\/\/ 2\. Stripe readiness gate/,/^[[:space:]]*}$/{ 
  /\/\/ 2\. Stripe readiness gate/d
  /if (!host\.stripeChargesEnabled)/d
  /return NextResponse\.json(/d
  /{ error: "Stripe account not ready\. Complete onboarding first\." }/d
  /{ status: 403 }/d
  /);/d
  /^[[:space:]]*}$/d
}' src/app/api/boards/route.ts

# If the pattern above didn't match exactly, try a simpler approach
if grep -q "Stripe account not ready" src/app/api/boards/route.ts; then
  echo "  ⚠ First pass didn't clean fully, trying alternate pattern..."
  # Remove lines between "Stripe readiness gate" comment and the next section
  sed -i '/Stripe readiness gate/,/\/\/ 3\. Parse/{ /Stripe readiness gate/d; /stripeChargesEnabled/d; /Stripe account not ready/d; /status: 403/d; }' src/app/api/boards/route.ts
fi

if grep -q "Stripe account not ready" src/app/api/boards/route.ts; then
  echo "  ✗ Could not auto-remove. Manual edit needed — delete the stripeChargesEnabled block."
else
  echo "  ✓ Stripe 403 gate removed"
fi

# -------------------------------------------------------
# 3. src/app/host/boards/page.tsx
#    Remove Stripe banner, always show New Board button
# -------------------------------------------------------
echo "3/5  src/app/host/boards/page.tsx"

cat > src/app/host/boards/page.tsx << 'EOF'
import { getHost } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import Link from "next/link";

export default async function HostBoardsPage() {
  const host = await getHost();
  if (!host) redirect("/login");

  const boards = await prisma.board.findMany({
    where: { hostId: host.id, hiddenFromHost: false },
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
                      : board.status === "closed"
                        ? "bg-gray-800 text-gray-400 border border-gray-700"
                        : board.status === "pending_payment"
                          ? "bg-yellow-950 text-yellow-400 border border-yellow-900"
                          : "bg-red-950 text-red-400 border border-red-900"
                  }`}
                >
                  {board.status === "pending_payment" ? "pending" : board.status}
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
EOF
echo "  ✓ Stripe banner removed, New Board always visible"

# -------------------------------------------------------
# 4. src/app/board/[slug]/page.tsx
#    Add stripeChargesEnabled to host select
#    Pass stripeConnected prop to PlayerBoard
# -------------------------------------------------------
echo "4/5  src/app/board/[slug]/page.tsx"

# Add stripeChargesEnabled to the host select
sed -i "s|select: { name: true, stripeAccountId: true }|select: { name: true, stripeAccountId: true, stripeChargesEnabled: true }|" src/app/board/[slug]/page.tsx

# If the simpler select exists (without stripeAccountId)
sed -i "s|select: { name: true },|select: { name: true, stripeAccountId: true, stripeChargesEnabled: true },|" src/app/board/[slug]/page.tsx

# Add stripeConnected prop to PlayerBoard — insert after cashModeEnabled line
sed -i '/cashModeEnabled={board\.cashModeEnabled}/a\          stripeConnected={board.host.stripeChargesEnabled}' src/app/board/[slug]/page.tsx

echo "  ✓ stripeConnected prop added"

# -------------------------------------------------------
# 5. src/app/board/[slug]/player-board.tsx
#    Add stripeConnected prop
#    Update checkout logic to single-button
# -------------------------------------------------------
echo "5/5  src/app/board/[slug]/player-board.tsx"

# Add stripeConnected to the props interface
sed -i 's/cashModeEnabled: boolean;/cashModeEnabled: boolean;\n  stripeConnected: boolean;/' src/app/board/[slug]/player-board.tsx

# Add stripeConnected to destructured props
sed -i 's/cashModeEnabled,$/cashModeEnabled,\n  stripeConnected,/' src/app/board/[slug]/player-board.tsx

# If the destructuring is on one line with closing brace
sed -i 's/cashModeEnabled,\s*}/cashModeEnabled,\n  stripeConnected,\n}/' src/app/board/[slug]/player-board.tsx

# Replace the payment mode state initialization
# Old: defaults to "card" always
# New: defaults based on what's available
sed -i 's/const \[paymentMode, setPaymentMode\] = useState<"card" | "cash">("card");/\/\/ Payment method availability\n  const hasCard = stripeConnected;\n  const hasCash = cashModeEnabled;\n  const hasBoth = hasCard \&\& hasCash;\n\n  const [paymentMode, setPaymentMode] = useState<"card" | "cash">(\n    hasCard ? "card" : "cash"\n  );/' src/app/board/[slug]/player-board.tsx

# Replace the tab condition: {cashModeEnabled && ( → {hasBoth && (
sed -i 's/{cashModeEnabled && (/{hasBoth \&\& (/' src/app/board/[slug]/player-board.tsx

# Update form visibility: add hasCard / hasCash guards
sed -i 's/{paymentMode === "card" && (/{paymentMode === "card" \&\& hasCard \&\& (/' src/app/board/[slug]/player-board.tsx
sed -i 's/{paymentMode === "cash" && (/{paymentMode === "cash" \&\& hasCash \&\& (/' src/app/board/[slug]/player-board.tsx

echo "  ✓ Single-button checkout logic applied"

# -------------------------------------------------------
# Done
# -------------------------------------------------------
echo ""
echo "=== All changes applied ==="
echo ""
echo "Verify with:"
echo "  grep -r 'stripeChargesEnabled' src/app/host/boards/new/"
echo "  grep -r 'Stripe account not ready' src/app/api/boards/"
echo "  grep -r 'stripeConnected' src/app/board/"
echo "  grep -r 'hasBoth' src/app/board/"
echo ""
echo "Then: npm run build"
