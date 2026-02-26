"""
Patch Script 1: Board Dismiss Feature (Addendum K)
Creates: migration SQL, API route, dismiss button component
Patches: schema.prisma, dashboard page, webhook
"""
import os

# ============================================================
# 1. Migration SQL
# ============================================================
os.makedirs("migrations", exist_ok=True)
with open("migrations/add_dismiss_feature.sql", "w") as f:
    f.write("ALTER TABLE boards ADD COLUMN hidden_from_host BOOLEAN NOT NULL DEFAULT false;\n")
print("✓ Created migrations/add_dismiss_feature.sql")

# ============================================================
# 2. Patch prisma/schema.prisma — add hiddenFromHost field
# ============================================================
with open("prisma/schema.prisma", "r") as f:
    schema = f.read()

old_schema = '  activatedAt               DateTime?   @map("activated_at") @db.Timestamptz(6)'
new_schema = """  activatedAt               DateTime?   @map("activated_at") @db.Timestamptz(6)

  // Dismiss feature (Addendum K) — soft-hide from host dashboard
  hiddenFromHost            Boolean     @default(false) @map("hidden_from_host")"""

if "hiddenFromHost" not in schema:
    schema = schema.replace(old_schema, new_schema, 1)
    with open("prisma/schema.prisma", "w") as f:
        f.write(schema)
    print("✓ Patched prisma/schema.prisma — added hiddenFromHost")
else:
    print("- prisma/schema.prisma already has hiddenFromHost")

# ============================================================
# 3. Create API route: /api/boards/[id]/dismiss/route.ts
# ============================================================
dismiss_dir = "src/app/api/boards/[id]/dismiss"
os.makedirs(dismiss_dir, exist_ok=True)

dismiss_route = '''import { NextResponse } from "next/server";
import { getHost } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

// ============================================================
// DISMISS BOARD — Addendum K
//
// PATCH /api/boards/[id]/dismiss
//
// Sets hiddenFromHost = true. Non-destructive soft delete.
// Only allowed for expired and pending_payment boards.
// Open and closed boards return 403 — always.
// ============================================================

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const host = await getHost();
  if (!host) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  const board = await prisma.board.findUnique({
    where: { boardId: id },
    select: { boardId: true, hostId: true, status: true },
  });

  if (!board || board.hostId !== host.id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (board.status !== "expired" && board.status !== "pending_payment") {
    return NextResponse.json(
      { error: "Only expired or pending boards can be dismissed." },
      { status: 403 }
    );
  }

  await prisma.board.update({
    where: { boardId: id },
    data: { hiddenFromHost: true },
  });

  return NextResponse.json({ success: true });
}
'''

with open(os.path.join(dismiss_dir, "route.ts"), "w") as f:
    f.write(dismiss_route)
print("✓ Created src/app/api/boards/[id]/dismiss/route.ts")

# ============================================================
# 4. Create DismissButton client component
# ============================================================
components_dir = "src/app/host/boards/components"
os.makedirs(components_dir, exist_ok=True)

dismiss_button = '''"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function DismissButton({ boardId }: { boardId: string }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function handleDismiss() {
    setLoading(true);
    try {
      const res = await fetch(`/api/boards/${boardId}/dismiss`, {
        method: "PATCH",
      });
      if (res.ok) {
        router.refresh();
      }
    } catch {
      // silent — non-critical action
    } finally {
      setLoading(false);
    }
  }

  return (
    <button
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        handleDismiss();
      }}
      disabled={loading}
      className="text-xs text-gray-600 hover:text-red-400 transition-colors disabled:opacity-50"
      title="Remove from dashboard"
    >
      {loading ? "\\u2026" : "Dismiss"}
    </button>
  );
}
'''

with open(os.path.join(components_dir, "dismiss-button.tsx"), "w") as f:
    f.write(dismiss_button)
print("✓ Created src/app/host/boards/components/dismiss-button.tsx")

# ============================================================
# 5. Patch dashboard: src/app/host/boards/page.tsx
# ============================================================
with open("src/app/host/boards/page.tsx", "r") as f:
    dash = f.read()

changes = 0

# 5a. Add import for DismissButton
old_import = 'import { CreditBuyButton, CreditPurchasedBanner } from "./components/credit-ui";'
new_import = '''import { CreditBuyButton, CreditPurchasedBanner } from "./components/credit-ui";
import { DismissButton } from "./components/dismiss-button";'''

if "DismissButton" not in dash:
    dash = dash.replace(old_import, new_import, 1)
    changes += 1
    print("✓ Added DismissButton import")
else:
    print("- DismissButton import already present")

# 5b. Add hiddenFromHost filter to query
old_where = "where: { hostId: host.id },"
new_where = "where: { hostId: host.id, hiddenFromHost: false },"

if "hiddenFromHost" not in dash:
    dash = dash.replace(old_where, new_where, 1)
    changes += 1
    print("✓ Added hiddenFromHost filter to board query")
else:
    print("- hiddenFromHost filter already present")

# 5c. Add DismissButton to pending payment cards
old_pending_btn = '                        <CreditBuyButton boardId={board.boardId} />'
new_pending_btn = '''                        <div className="flex items-center gap-3">
                          <DismissButton boardId={board.boardId} />
                          <CreditBuyButton boardId={board.boardId} />
                        </div>'''

if "DismissButton" in dash and old_pending_btn in dash:
    dash = dash.replace(old_pending_btn, new_pending_btn, 1)
    changes += 1
    print("✓ Added DismissButton to pending payment cards")

# 5d. Add DismissButton to expired cards
old_expired_badge = '''                        <span className="text-xs px-2 py-0.5 rounded-full bg-gray-800 text-gray-500 border border-gray-700">
                          expired
                        </span>'''
new_expired_badge = '''                        <div className="flex items-center gap-3">
                          <DismissButton boardId={board.boardId} />
                          <span className="text-xs px-2 py-0.5 rounded-full bg-gray-800 text-gray-500 border border-gray-700">
                            expired
                          </span>
                        </div>'''

if old_expired_badge in dash:
    dash = dash.replace(old_expired_badge, new_expired_badge, 1)
    changes += 1
    print("✓ Added DismissButton to expired cards")

if changes > 0:
    with open("src/app/host/boards/page.tsx", "w") as f:
        f.write(dash)
    print(f"✓ Saved dashboard ({changes} changes)")
else:
    print("- Dashboard already patched")

# ============================================================
# 6. Patch webhook: reset hiddenFromHost on board activation
# ============================================================
webhook_file = "src/app/api/webhooks/stripe-platform/route.ts"
with open(webhook_file, "r") as f:
    webhook = f.read()

if "hiddenFromHost" not in webhook:
    old_activate = "          activatedAt: new Date(),"
    new_activate = "          activatedAt: new Date(),\n          hiddenFromHost: false,"
    
    if old_activate in webhook:
        webhook = webhook.replace(old_activate, new_activate, 1)
        with open(webhook_file, "w") as f:
            f.write(webhook)
        print("✓ Patched webhook — reset hiddenFromHost on activation")
    else:
        print("⚠ Could not find activatedAt line in webhook — patch manually")
else:
    print("- Webhook already has hiddenFromHost reset")

# ============================================================
print("\n✅ Dismiss feature patched. Next steps:")
print("  1. Run migration:")
print('     npx prisma db execute --url "$DATABASE_URL" --file migrations/add_dismiss_feature.sql')
print("  2. Regenerate client:")
print("     npx prisma generate")
print("  3. Build:")
print("     npm run build")
