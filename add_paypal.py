import sys

def replace_once(content, old, new, label):
    count = content.count(old)
    if count == 0:
        print(f"  ✗ FAILED — target string not found in {label}")
        print(f"    Looking for: {repr(old[:80])}")
        sys.exit(1)
    if count > 1:
        print(f"  ✗ FAILED — target string found {count} times (not unique) in {label}")
        sys.exit(1)
    return content.replace(old, new)

def patch(filepath, replacements):
    with open(filepath, "r", encoding="utf-8") as f:
        original = content = f.read()
    original_lines = original.count("\n")
    for old, new in replacements:
        content = replace_once(content, old, new, filepath)
    new_lines = content.count("\n")
    with open(filepath, "w", encoding="utf-8") as f:
        f.write(content)
    print(f"  ✓ {filepath}  ({original_lines} → {new_lines} lines)")

print("\n=== Adding PayPal support ===\n")

# ── 1. prisma/schema.prisma ──────────────────────────────────────────────────
patch("prisma/schema.prisma", [
    (
        '  hostCashapp            String?          @map("host_cashapp")',
        '  hostCashapp            String?          @map("host_cashapp")\n  hostPaypal             String?          @map("host_paypal")',
    ),
    (
        "enum PlayerPayoutMethod {\n  venmo\n  zelle\n  cashapp\n  cash\n}",
        "enum PlayerPayoutMethod {\n  venmo\n  zelle\n  cashapp\n  paypal\n  cash\n}",
    ),
])

# ── 2. src/app/api/boards/route.ts ───────────────────────────────────────────
patch("src/app/api/boards/route.ts", [
    (
        "  hostCashapp?: string | null;\n  payoutVisibility",
        "  hostCashapp?: string | null;\n  hostPaypal?: string | null;\n  payoutVisibility",
    ),
    (
        "    const hostCashapp = body.hostCashapp?.trim() || null;",
        "    const hostCashapp = body.hostCashapp?.trim() || null;\n    const hostPaypal = body.hostPaypal?.trim() || null;",
    ),
    (
        "      hostCashapp,\n      payoutVisibility",
        "      hostCashapp,\n      hostPaypal,\n      payoutVisibility",
    ),
])

# ── 3. src/app/host/boards/new/form.tsx ──────────────────────────────────────
patch("src/app/host/boards/new/form.tsx", [
    (
        '  const [hostCashapp, setHostCashapp] = useState("");\n  const hasPaymentHandle = hostVenmo.trim() || hostZelle.trim() || hostCashapp.trim();',
        '  const [hostCashapp, setHostCashapp] = useState("");\n  const [hostPaypal, setHostPaypal] = useState("");\n  const hasPaymentHandle = hostVenmo.trim() || hostZelle.trim() || hostCashapp.trim() || hostPaypal.trim();',
    ),
    (
        "          hostCashapp: hostCashapp.trim() || null,\n          payoutVisibility",
        "          hostCashapp: hostCashapp.trim() || null,\n          hostPaypal: hostPaypal.trim() || null,\n          payoutVisibility",
    ),
    (
        '            {/* CashApp */}\n            <div>\n              <label htmlFor="hostCashapp" className="block text-xs text-gray-500 mb-1">\n                CashApp\n              </label>\n              <input\n                id="hostCashapp"\n                type="text"\n                value={hostCashapp}\n                onChange={(e) => setHostCashapp(e.target.value)}\n                placeholder="$your-cashapp"\n                className="w-full rounded-lg border border-gray-800 bg-gray-900 px-3 py-2 text-sm text-white outline-none focus:border-gray-600 transition-colors"\n              />\n            </div>',
        '            {/* CashApp */}\n            <div>\n              <label htmlFor="hostCashapp" className="block text-xs text-gray-500 mb-1">\n                CashApp\n              </label>\n              <input\n                id="hostCashapp"\n                type="text"\n                value={hostCashapp}\n                onChange={(e) => setHostCashapp(e.target.value)}\n                placeholder="$your-cashapp"\n                className="w-full rounded-lg border border-gray-800 bg-gray-900 px-3 py-2 text-sm text-white outline-none focus:border-gray-600 transition-colors"\n              />\n            </div>\n\n            {/* PayPal */}\n            <div>\n              <label htmlFor="hostPaypal" className="block text-xs text-gray-500 mb-1">\n                PayPal\n              </label>\n              <input\n                id="hostPaypal"\n                type="text"\n                value={hostPaypal}\n                onChange={(e) => setHostPaypal(e.target.value)}\n                placeholder="you@email.com or @username"\n                className="w-full rounded-lg border border-gray-800 bg-gray-900 px-3 py-2 text-sm text-white outline-none focus:border-gray-600 transition-colors"\n              />\n            </div>',
    ),
])

# ── 4. src/components/player-payout-select.tsx ───────────────────────────────
patch("src/components/player-payout-select.tsx", [
    (
        "  hostCashapp: string | null;\n  required",
        "  hostCashapp: string | null;\n  hostPaypal: string | null;\n  required",
    ),
    (
        "  hostCashapp,\n  required",
        "  hostCashapp,\n  hostPaypal,\n  required",
    ),
    (
        '  if (hostCashapp) options.push({ value: "cashapp", label: "CashApp", needsHandle: true });\n  options.push({ value: "cash"',
        '  if (hostCashapp) options.push({ value: "cashapp", label: "CashApp", needsHandle: true });\n  if (hostPaypal) options.push({ value: "paypal", label: "PayPal", needsHandle: true });\n  options.push({ value: "cash"',
    ),
    (
        '                : selectedMethod === "zelle"\n                  ? "email or phone"\n                  : "$your-cashapp"',
        '                : selectedMethod === "zelle"\n                  ? "email or phone"\n                  : selectedMethod === "paypal"\n                    ? "you@email.com or @username"\n                    : "$your-cashapp"',
    ),
])

# ── 5. src/app/board/[slug]/page.tsx ─────────────────────────────────────────
patch("src/app/board/[slug]/page.tsx", [
    (
        "          cashapp={board.hostCashapp}\n          visibility",
        "          cashapp={board.hostCashapp}\n          paypal={board.hostPaypal}\n          visibility",
    ),
    (
        "          hostCashapp={board.hostCashapp}\n          payoutVisibility",
        "          hostCashapp={board.hostCashapp}\n          hostPaypal={board.hostPaypal}\n          payoutVisibility",
    ),
])

# ── 6. src/app/board/[slug]/player-board.tsx ─────────────────────────────────
patch("src/app/board/[slug]/player-board.tsx", [
    (
        "  hostCashapp?: string | null;\n  payoutVisibility",
        "  hostCashapp?: string | null;\n  hostPaypal?: string | null;\n  payoutVisibility",
    ),
    (
        "  hostCashapp,\n  payoutVisibility",
        "  hostCashapp,\n  hostPaypal,\n  payoutVisibility",
    ),
    # First PlayerPayoutSelect (card form)
    (
        "                          hostCashapp={hostCashapp ?? null}\n                          required={requirePlayerPayout}\n                          selectedMethod={playerPayoutMethod}\n                          handle={playerPayoutHandle}\n                          onMethodChange={setPlayerPayoutMethod}\n                          onHandleChange={setPlayerPayoutHandle}\n                        />\n\n                        <label className=\"flex items-center gap-2 cursor-pointer\">\n                          <input\n                            type=\"checkbox\"\n                            checked={saveInfo}\n                            onChange={(e) => setSaveInfo(e.target.checked)}\n                            className=\"rounded border-gray-600 bg-gray-800 text-indigo-600 focus:ring-indigo-600\"\n                          />\n                          <span className=\"text-xs text-gray-400\">Save my info for next time</span>\n                        </label>\n                        {error && <p className=\"text-xs text-red-400\">{error}</p>}\n                        <button\n                          type=\"submit\"\n                          disabled={loading}\n                          className=\"w-full rounded-lg bg-indigo-600 py-3 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50 transition-colors\"",
        "                          hostCashapp={hostCashapp ?? null}\n                          hostPaypal={hostPaypal ?? null}\n                          required={requirePlayerPayout}\n                          selectedMethod={playerPayoutMethod}\n                          handle={playerPayoutHandle}\n                          onMethodChange={setPlayerPayoutMethod}\n                          onHandleChange={setPlayerPayoutHandle}\n                        />\n\n                        <label className=\"flex items-center gap-2 cursor-pointer\">\n                          <input\n                            type=\"checkbox\"\n                            checked={saveInfo}\n                            onChange={(e) => setSaveInfo(e.target.checked)}\n                            className=\"rounded border-gray-600 bg-gray-800 text-indigo-600 focus:ring-indigo-600\"\n                          />\n                          <span className=\"text-xs text-gray-400\">Save my info for next time</span>\n                        </label>\n                        {error && <p className=\"text-xs text-red-400\">{error}</p>}\n                        <button\n                          type=\"submit\"\n                          disabled={loading}\n                          className=\"w-full rounded-lg bg-indigo-600 py-3 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50 transition-colors\"",
    ),
    # Second PlayerPayoutSelect (cash form)
    (
        "                          hostCashapp={hostCashapp ?? null}\n                          required={requirePlayerPayout}\n                          selectedMethod={playerPayoutMethod}\n                          handle={playerPayoutHandle}\n                          onMethodChange={setPlayerPayoutMethod}\n                          onHandleChange={setPlayerPayoutHandle}\n                        />\n\n                        <label className=\"flex items-center gap-2 cursor-pointer\">\n                          <input\n                            type=\"checkbox\"\n                            checked={saveInfo}\n                            onChange={(e) => setSaveInfo(e.target.checked)}\n                            className=\"rounded border-gray-600 bg-gray-800 text-indigo-600 focus:ring-indigo-600\"\n                          />\n                          <span className=\"text-xs text-gray-400\">Save my info for next time</span>\n                        </label>\n                        {error && <p className=\"text-xs text-red-400\">{error}</p>}\n                        <button\n                          type=\"submit\"\n                          disabled={loading}\n                          className=\"w-full rounded-lg bg-yellow-700 py-3 text-sm font-semibold text-white hover:bg-yellow-600 disabled:opacity-50 transition-colors\"",
        "                          hostCashapp={hostCashapp ?? null}\n                          hostPaypal={hostPaypal ?? null}\n                          required={requirePlayerPayout}\n                          selectedMethod={playerPayoutMethod}\n                          handle={playerPayoutHandle}\n                          onMethodChange={setPlayerPayoutMethod}\n                          onHandleChange={setPlayerPayoutHandle}\n                        />\n\n                        <label className=\"flex items-center gap-2 cursor-pointer\">\n                          <input\n                            type=\"checkbox\"\n                            checked={saveInfo}\n                            onChange={(e) => setSaveInfo(e.target.checked)}\n                            className=\"rounded border-gray-600 bg-gray-800 text-indigo-600 focus:ring-indigo-600\"\n                          />\n                          <span className=\"text-xs text-gray-400\">Save my info for next time</span>\n                        </label>\n                        {error && <p className=\"text-xs text-red-400\">{error}</p>}\n                        <button\n                          type=\"submit\"\n                          disabled={loading}\n                          className=\"w-full rounded-lg bg-yellow-700 py-3 text-sm font-semibold text-white hover:bg-yellow-600 disabled:opacity-50 transition-colors\"",
    ),
])

# ── 7. src/app/host/boards/[id]/page.tsx ─────────────────────────────────────
patch("src/app/host/boards/[id]/page.tsx", [
    (
        'sq.playerPayoutMethod === "venmo" ? "Venmo" : sq.playerPayoutMethod === "zelle" ? "Zelle" : "CashApp"',
        'sq.playerPayoutMethod === "venmo" ? "Venmo" : sq.playerPayoutMethod === "zelle" ? "Zelle" : sq.playerPayoutMethod === "paypal" ? "PayPal" : "CashApp"',
    ),
])

# ── 8. src/app/host/boards/[id]/winner-payout-card.tsx ───────────────────────
patch("src/app/host/boards/[id]/winner-payout-card.tsx", [
    (
        '      playerPayoutMethod === "venmo"\n        ? "Venmo"\n        : playerPayoutMethod === "zelle"\n          ? "Zelle"\n          : "CashApp"',
        '      playerPayoutMethod === "venmo"\n        ? "Venmo"\n        : playerPayoutMethod === "zelle"\n          ? "Zelle"\n          : playerPayoutMethod === "paypal"\n            ? "PayPal"\n            : "CashApp"',
    ),
])

print("\n=== All patches applied successfully ===")
print("\nNext steps:")
print("  1. npx prisma migrate dev --name add_host_paypal")
print("  2. npx prisma generate")
print("  3. Restart dev server\n")
