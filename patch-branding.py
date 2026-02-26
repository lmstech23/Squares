"""
Patch Script 2: Branding Sweep — "Squares" → "Daali" / "Daali Boards"

Rules:
  - "Daali" = brand/company (nav, login, liability text)
  - "Daali Boards" = product name (page titles, metadata)
  - lowercase "squares" for game concept (grid squares, DB tables) — NO CHANGE
  - Stripe line items updated to reference Daali

Run AFTER patch-dismiss.py. Preview with: git diff
"""
import re

changes = []

def patch(filepath, old, new, label=None):
    with open(filepath, "r") as f:
        content = f.read()
    if old not in content:
        print(f"  ⚠ Not found in {filepath}: {repr(old[:60])}")
        return
    content = content.replace(old, new, 1)
    with open(filepath, "w") as f:
        f.write(content)
    changes.append(filepath)
    print(f"  ✓ {filepath}" + (f" — {label}" if label else ""))

print("Branding sweep: Squares → Daali\\n")

# ============================================================
# 1. Layout metadata
# ============================================================
print("[layout.tsx]")
patch(
    "src/app/layout.tsx",
    'title: "Squares"',
    'title: "Daali Boards"',
    "page title"
)
patch(
    "src/app/layout.tsx",
    'description: "Run your own squares board."',
    'description: "Your boards. Your community. Zero chaos."',
    "meta description"
)

# ============================================================
# 2. Host nav bar
# ============================================================
print("[host/nav.tsx]")
patch(
    "src/app/host/nav.tsx",
    '>Squares<',
    '>Daali<',
    "nav brand name"
)

# ============================================================
# 3. Login page
# ============================================================
print("[login/page.tsx]")
patch(
    "src/app/login/page.tsx",
    '>Squares<',
    '>Daali<',
    "login heading"
)

# ============================================================
# 4. Player board page title
# ============================================================
print("[board/[slug]/page.tsx]")
patch(
    "src/app/board/[slug]/page.tsx",
    '— Squares',
    '— Daali Boards',
    "board page title"
)

# ============================================================
# 5. Cash mode toggle — liability text
# ============================================================
print("[cash-mode-toggle.tsx]")
patch(
    "src/app/host/boards/[id]/cash-mode-toggle.tsx",
    "Squares doesn&apos;t",
    "Daali doesn&apos;t",
    "liability disclaimer"
)
patch(
    "src/app/host/boards/[id]/cash-mode-toggle.tsx",
    "Squares is not liable",
    "Daali is not liable",
    "liability warning"
)

# ============================================================
# 6. Credit checkout — Stripe line item
# ============================================================
print("[credits/checkout/route.ts]")
patch(
    "src/app/api/host/credits/checkout/route.ts",
    '"Squares board credits"',
    '"Daali board credits"',
    "Stripe product name"
)

# ============================================================
# 7. Square checkout — Stripe line item (capitalize fix)
# ============================================================
print("[checkout/route.ts]")
# "2 Squares (#45, #67)" → "2 squares (#45, #67)" — lowercase game term
with open("src/app/api/checkout/route.ts", "r") as f:
    content = f.read()
# Only change the Stripe line item label, not variable names
old_line_item = '`${squareIds.length} Squares'
new_line_item = '`${squareIds.length} squares'
if old_line_item in content:
    content = content.replace(old_line_item, new_line_item, 1)
    with open("src/app/api/checkout/route.ts", "w") as f:
        f.write(content)
    changes.append("src/app/api/checkout/route.ts")
    print("  ✓ src/app/api/checkout/route.ts — lowercase 'squares' in Stripe line item")
else:
    print("  - Stripe line item already lowercase or not found")

# ============================================================
print(f"\n✅ Branding sweep complete — {len(changes)} files changed.")
print("\nPreview all changes:")
print("  git diff")
print("\nIf everything looks good:")
print('  git add -A && git commit -m "brand: Squares → Daali across UI and Stripe"')
print("\nRevert a specific file if needed:")
print("  git checkout -- path/to/file")
