import re

HOST_FILE = "src/app/host/boards/[id]/page.tsx"
PLAYER_FILE = "src/app/board/[slug]/page.tsx"

# 1. Patch host page
with open(HOST_FILE, "r") as f:
    code = f.read()

if "CashModeToggle" not in code:
    code = code.replace(
        'import ScoreEntry from "./score-entry";',
        'import ScoreEntry from "./score-entry";\nimport CashModeToggle from "./cash-mode-toggle";\nimport CashReservePanel from "./cash-reserve-panel";',
        1
    )
    print("Added imports")

if "paymentMethod: true" not in code:
    code = code.replace(
        '      squares: {\n        orderBy: { position: "asc" },\n      },',
        '      squares: {\n        orderBy: { position: "asc" },\n        select: {\n          squareId: true,\n          position: true,\n          playerName: true,\n          playerEmail: true,\n          paymentStatus: true,\n          paymentMethod: true,\n          stripePaymentId: true,\n          checkoutExpiresAt: true,\n          releaseReason: true,\n        },\n      },',
        1
    )
    print("Updated squares query")

if "CashModeToggle\n" not in code:
    marker = "      {/* Randomized confirmation */}"
    cash_jsx = """      {/* Cash Mode */}
      {isOpen && (
        <CashModeToggle
          boardId={board.boardId}
          initialEnabled={board.cashModeEnabled}
          initialPin={board.cashPin}
          liabilityAccepted={board.cashLiabilityAccepted}
        />
      )}

      {/* Cash Reserve Panel */}
      {isOpen && board.cashModeEnabled && (
        <CashReservePanel
          boardId={board.boardId}
          squares={board.squares.map((s) => ({
            squareId: s.squareId,
            position: s.position,
            playerName: s.playerName,
            paymentStatus: s.paymentStatus,
            paymentMethod: s.paymentMethod,
          }))}
        />
      )}

"""
    code = code.replace(marker, cash_jsx + marker, 1)
    print("Added cash components")

with open(HOST_FILE, "w") as f:
    f.write(code)

# 2. Patch player page
with open(PLAYER_FILE, "r") as f:
    code = f.read()

if "cashModeEnabled" not in code:
    code = code.replace(
        "          winnerPositions={winnerPositions}\n        />",
        "          winnerPositions={winnerPositions}\n          cashModeEnabled={board.cashModeEnabled}\n        />",
        1
    )
    print("Added cashModeEnabled prop")

with open(PLAYER_FILE, "w") as f:
    f.write(code)

print("Done!")