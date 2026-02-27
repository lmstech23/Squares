#!/bin/bash
# ============================================================
# SQUARES — Payout Coordination Build
# Reference: payout-coordination-memo.docx + SYSTEM-FLOW.md §8
#
# Run from repo root:  bash payout-coordination.sh
#
# WHAT THIS DOES:
#   1. Migration SQL (run manually against DB)
#   2. Updates Prisma schema with new fields
#   3. Updates board creation form with payout fields
#   4. Updates board creation API to accept new fields
#   5. Updates checkout API to accept phone + payout info
#   6. Updates cash reserve API to accept phone + payout info
#   7. Updates player board with new form fields + host payment display
#   8. Adds winner payout display component for host dashboard
#
# WHAT THIS DOES NOT TOUCH:
#   - Cash mode toggle/reserve/release flows (unchanged)
#   - Stripe webhook handler (unchanged)
#   - Cron cleanup (unchanged)
#   - Board close / randomization (unchanged)
#   - Score entry (unchanged — winner display is additive)
# ============================================================
set -e
echo "🏗️  Payout Coordination Build"
echo "=============================="
echo ""

# ============================================================
# 1. MIGRATION SQL
# ============================================================
mkdir -p migrations
cat > 'migrations/payout-coordination.sql' << 'EOF_MIGRATION'
-- ============================================================
-- PAYOUT COORDINATION MIGRATION
-- Adds host payment handles, player payout info, phone, SMS opt-in
-- Reference: payout-coordination-memo.docx + SYSTEM-FLOW.md §8
-- ============================================================

-- 1. New enum for payout visibility
DO $$ BEGIN
  CREATE TYPE "PayoutVisibility" AS ENUM ('public', 'pin_gated');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 2. New enum for player payout method
DO $$ BEGIN
  CREATE TYPE "PlayerPayoutMethod" AS ENUM ('venmo', 'zelle', 'cashapp', 'cash');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 3. Board table — host payment handles + payout settings
ALTER TABLE boards
  ADD COLUMN IF NOT EXISTS host_venmo            TEXT,
  ADD COLUMN IF NOT EXISTS host_zelle            TEXT,
  ADD COLUMN IF NOT EXISTS host_cashapp          TEXT,
  ADD COLUMN IF NOT EXISTS payout_visibility     "PayoutVisibility" NOT NULL DEFAULT 'public',
  ADD COLUMN IF NOT EXISTS require_player_payout BOOLEAN NOT NULL DEFAULT false;

-- 4. Square table — player contact + payout info
ALTER TABLE squares
  ADD COLUMN IF NOT EXISTS player_phone          TEXT,
  ADD COLUMN IF NOT EXISTS player_payout_method  "PlayerPayoutMethod",
  ADD COLUMN IF NOT EXISTS player_payout_handle  TEXT,
  ADD COLUMN IF NOT EXISTS sms_opt_in            BOOLEAN NOT NULL DEFAULT false;
EOF_MIGRATION
echo "  ✓ migrations/payout-coordination.sql"

# ============================================================
# 2. UPDATE PRISMA SCHEMA — add new enums + fields
# ============================================================

# Add PayoutVisibility enum after PaymentMethod enum
if ! grep -q "PayoutVisibility" prisma/schema.prisma; then
  sed -i '/^enum PaymentMethod {$/,/^}$/a\
\
enum PayoutVisibility {\
  public\
  pin_gated\
}\
\
enum PlayerPayoutMethod {\
  venmo\
  zelle\
  cashapp\
  cash\
}' prisma/schema.prisma
  echo "  ✓ Added PayoutVisibility + PlayerPayoutMethod enums to schema"
fi

# Add Board fields before the host relation line
if ! grep -q "hostVenmo" prisma/schema.prisma; then
  sed -i '/cashLiabilityAccepted.*Boolean/a\
  hostVenmo              String?          @map("host_venmo")\
  hostZelle              String?          @map("host_zelle")\
  hostCashapp            String?          @map("host_cashapp")\
  payoutVisibility       PayoutVisibility @default(public) @map("payout_visibility")\
  requirePlayerPayout    Boolean          @default(false) @map("require_player_payout")' prisma/schema.prisma
  echo "  ✓ Added payout fields to Board model"
fi

# Add Square fields before the board relation line
if ! grep -q "playerPhone" prisma/schema.prisma; then
  sed -i '/paymentMethod.*PaymentMethod.*@default(stripe)/a\
  playerPhone           String?              @map("player_phone")\
  playerPayoutMethod    PlayerPayoutMethod?  @map("player_payout_method")\
  playerPayoutHandle    String?              @map("player_payout_handle")\
  smsOptIn              Boolean              @default(false) @map("sms_opt_in")' prisma/schema.prisma
  echo "  ✓ Added payout fields to Square model"
fi

# ============================================================
# 3. BOARD CREATION FORM — add payout coordination section
# ============================================================
mkdir -p "$(dirname 'src/app/host/boards/new/form.tsx')"
cat > 'src/app/host/boards/new/form.tsx' << 'FORM_EOF'
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

const PERIOD_LABELS = ["H1", "Final"];
const DEFAULT_PAYOUTS: Record<string, number> = { H1: 50, Final: 50 };

export default function NewBoardForm() {
  const router = useRouter();
  const [gameName, setGameName] = useState("");
  const [teamCol, setTeamCol] = useState("");
  const [teamRow, setTeamRow] = useState("");
  const [squarePrice, setSquarePrice] = useState("");
  const [hostCut, setHostCut] = useState("0");
  const [payouts, setPayouts] = useState(DEFAULT_PAYOUTS);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Payout coordination fields
  const [hostVenmo, setHostVenmo] = useState("");
  const [hostZelle, setHostZelle] = useState("");
  const [hostCashapp, setHostCashapp] = useState("");
  const [payoutVisibility, setPayoutVisibility] = useState<"public" | "pin_gated">("public");
  const [requirePlayerPayout, setRequirePlayerPayout] = useState(false);
  const [showPayoutSection, setShowPayoutSection] = useState(false);

  const payoutTotal = PERIOD_LABELS.reduce(
    (sum, label) => sum + (payouts[label] ?? 0),
    0
  );
  const payoutValid = payoutTotal === 100;

  const priceNum = parseInt(squarePrice, 10);
  const priceValid = !isNaN(priceNum) && priceNum >= 100; // $1 min in cents
  const totalPot = priceValid ? priceNum * 100 : 0;

  const hostCutNum = parseInt(hostCut, 10);
  const hostCutValid = !isNaN(hostCutNum) && hostCutNum >= 0 && hostCutNum <= 50;
  const playerPool = hostCutValid ? Math.round(totalPot * (1 - hostCutNum / 100)) : 0;

  function updatePayout(label: string, value: string) {
    const num = parseInt(value, 10);
    setPayouts((p) => ({ ...p, [label]: isNaN(num) ? 0 : num }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!gameName.trim() || !teamCol.trim() || !teamRow.trim()) {
      setError("Game name and both team names are required.");
      return;
    }
    if (!priceValid) {
      setError("Price must be at least $1 (enter in cents).");
      return;
    }
    if (!hostCutValid) {
      setError("Host cut must be 0–50%.");
      return;
    }
    if (!payoutValid) {
      setError("Payout percentages must total 100%.");
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/boards", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          gameName: gameName.trim(),
          teamCol: teamCol.trim(),
          teamRow: teamRow.trim(),
          squarePrice: priceNum,
          hostCutPercent: hostCutNum,
          payoutStructure: payouts,
          // Payout coordination
          hostVenmo: hostVenmo.trim() || null,
          hostZelle: hostZelle.trim() || null,
          hostCashapp: hostCashapp.trim() || null,
          payoutVisibility,
          requirePlayerPayout,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Failed to create board.");
        setLoading(false);
        return;
      }
      router.push(`/host/boards/${data.boardId}`);
    } catch {
      setError("Network error. Please try again.");
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {error && (
        <div className="rounded-lg border border-red-900/50 bg-red-950/30 p-3">
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}

      {/* Game Name */}
      <div>
        <label htmlFor="gameName" className="block text-sm text-gray-400 mb-1.5">
          Game
        </label>
        <input
          id="gameName"
          type="text"
          value={gameName}
          onChange={(e) => setGameName(e.target.value)}
          placeholder="March Madness — Duke vs. Vermont"
          className="w-full rounded-lg border border-gray-800 bg-gray-900 px-3 py-2.5 text-sm text-white outline-none focus:border-gray-600 transition-colors"
        />
      </div>

      {/* Team Names */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor="teamCol" className="block text-sm text-gray-400 mb-1.5">
            Team (columns)
          </label>
          <input
            id="teamCol"
            type="text"
            value={teamCol}
            onChange={(e) => setTeamCol(e.target.value)}
            placeholder="Duke"
            className="w-full rounded-lg border border-gray-800 bg-gray-900 px-3 py-2.5 text-sm text-white outline-none focus:border-gray-600 transition-colors"
          />
        </div>
        <div>
          <label htmlFor="teamRow" className="block text-sm text-gray-400 mb-1.5">
            Team (rows)
          </label>
          <input
            id="teamRow"
            type="text"
            value={teamRow}
            onChange={(e) => setTeamRow(e.target.value)}
            placeholder="Vermont"
            className="w-full rounded-lg border border-gray-800 bg-gray-900 px-3 py-2.5 text-sm text-white outline-none focus:border-gray-600 transition-colors"
          />
        </div>
      </div>

      {/* Price Per Square */}
      <div>
        <label htmlFor="squarePrice" className="block text-sm text-gray-400 mb-1.5">
          Price per square (cents)
        </label>
        <input
          id="squarePrice"
          type="number"
          min="100"
          step="1"
          value={squarePrice}
          onChange={(e) => setSquarePrice(e.target.value)}
          placeholder="1000 = $10"
          className="w-full rounded-lg border border-gray-800 bg-gray-900 px-3 py-2.5 text-sm text-white outline-none focus:border-gray-600 transition-colors"
        />
        {priceValid && (
          <p className="text-xs text-gray-600 mt-1.5">
            ${(priceNum / 100).toFixed(2)} per square · ${(totalPot / 100).toFixed(2)} total pot
          </p>
        )}
      </div>

      {/* Host Cut */}
      <div>
        <label htmlFor="hostCut" className="block text-sm text-gray-400 mb-1.5">
          Your cut
        </label>
        <div className="relative">
          <input
            id="hostCut"
            type="number"
            min="0"
            max="50"
            step="1"
            value={hostCut}
            onChange={(e) => setHostCut(e.target.value)}
            className="w-full rounded-lg border border-gray-800 bg-gray-900 px-3 py-2.5 text-sm text-white text-center outline-none focus:border-gray-600 transition-colors"
          />
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-600 text-xs">%</span>
        </div>
        {totalPot > 0 && hostCutValid && (
          <p className="text-xs text-gray-600 mt-1.5">
            You keep ${Math.round(totalPot * (hostCutNum / 100)) / 100} · Players split ${(playerPool / 100).toFixed(2)}
          </p>
        )}
        {!hostCutValid && (
          <p className="text-xs text-red-400 mt-1.5">Must be 0–50%</p>
        )}
      </div>

      {/* Payout Structure */}
      <div>
        <label className="block text-sm text-gray-400 mb-1.5">
          Player payout split
        </label>
        <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${PERIOD_LABELS.length}, 1fr)` }}>
          {PERIOD_LABELS.map((label) => (
            <div key={label}>
              <div className="text-xs text-gray-500 mb-1 text-center">{label}</div>
              <div className="relative">
                <input
                  type="number"
                  min="0"
                  max="100"
                  step="1"
                  value={payouts[label] || ""}
                  onChange={(e) => updatePayout(label, e.target.value)}
                  className="w-full rounded-lg border border-gray-800 bg-gray-900 px-2 py-2 text-sm text-white text-center outline-none focus:border-gray-600 transition-colors"
                />
                <span className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-600 text-xs">%</span>
              </div>
            </div>
          ))}
        </div>
        <p className={`text-xs mt-1.5 ${payoutValid ? "text-gray-600" : "text-red-400"}`}>
          Total: {payoutTotal}%{!payoutValid && " — must equal 100%"}
        </p>
      </div>

      {/* ============================================ */}
      {/* PAYOUT COORDINATION SECTION                  */}
      {/* ============================================ */}
      <div className="border-t border-gray-800 pt-6">
        <button
          type="button"
          onClick={() => setShowPayoutSection(!showPayoutSection)}
          className="flex items-center justify-between w-full text-left"
        >
          <div>
            <p className="text-sm font-medium text-gray-300">How will you pay winners?</p>
            <p className="text-xs text-gray-600 mt-0.5">
              Add your Venmo, Zelle, or CashApp so players know where winnings come from
            </p>
          </div>
          <svg
            className={`w-5 h-5 text-gray-500 transition-transform ${showPayoutSection ? "rotate-180" : ""}`}
            fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
          >
            <path d="M19 9l-7 7-7-7" />
          </svg>
        </button>

        {showPayoutSection && (
          <div className="mt-4 space-y-4">
            {/* Venmo */}
            <div>
              <label htmlFor="hostVenmo" className="block text-xs text-gray-500 mb-1">
                Venmo
              </label>
              <input
                id="hostVenmo"
                type="text"
                value={hostVenmo}
                onChange={(e) => setHostVenmo(e.target.value)}
                placeholder="@your-venmo"
                className="w-full rounded-lg border border-gray-800 bg-gray-900 px-3 py-2 text-sm text-white outline-none focus:border-gray-600 transition-colors"
              />
            </div>

            {/* Zelle */}
            <div>
              <label htmlFor="hostZelle" className="block text-xs text-gray-500 mb-1">
                Zelle
              </label>
              <input
                id="hostZelle"
                type="text"
                value={hostZelle}
                onChange={(e) => setHostZelle(e.target.value)}
                placeholder="email or phone"
                className="w-full rounded-lg border border-gray-800 bg-gray-900 px-3 py-2 text-sm text-white outline-none focus:border-gray-600 transition-colors"
              />
            </div>

            {/* CashApp */}
            <div>
              <label htmlFor="hostCashapp" className="block text-xs text-gray-500 mb-1">
                CashApp
              </label>
              <input
                id="hostCashapp"
                type="text"
                value={hostCashapp}
                onChange={(e) => setHostCashapp(e.target.value)}
                placeholder="$your-cashapp"
                className="w-full rounded-lg border border-gray-800 bg-gray-900 px-3 py-2 text-sm text-white outline-none focus:border-gray-600 transition-colors"
              />
            </div>

            {/* Visibility Toggle */}
            <div className="flex items-center justify-between rounded-lg border border-gray-800 bg-gray-900 p-3">
              <div>
                <p className="text-xs text-gray-300">Show payment info to everyone</p>
                <p className="text-[10px] text-gray-600">Or only after players enter the PIN</p>
              </div>
              <button
                type="button"
                onClick={() => setPayoutVisibility(payoutVisibility === "public" ? "pin_gated" : "public")}
                className={`relative w-10 h-5 rounded-full transition-colors ${
                  payoutVisibility === "public" ? "bg-green-600" : "bg-gray-700"
                }`}
              >
                <span
                  className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                    payoutVisibility === "public" ? "translate-x-5" : ""
                  }`}
                />
              </button>
            </div>

            {/* Require Player Payout Toggle */}
            <div className="flex items-center justify-between rounded-lg border border-gray-800 bg-gray-900 p-3">
              <div>
                <p className="text-xs text-gray-300">Require players to share payout info</p>
                <p className="text-[10px] text-gray-600">Helps you pay winners faster</p>
              </div>
              <button
                type="button"
                onClick={() => setRequirePlayerPayout(!requirePlayerPayout)}
                className={`relative w-10 h-5 rounded-full transition-colors ${
                  requirePlayerPayout ? "bg-green-600" : "bg-gray-700"
                }`}
              >
                <span
                  className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                    requirePlayerPayout ? "translate-x-5" : ""
                  }`}
                />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Submit */}
      <button
        type="submit"
        disabled={loading || !gameName.trim() || !priceValid || !payoutValid || !hostCutValid}
        className="w-full rounded-lg bg-white text-gray-950 px-4 py-3 text-sm font-semibold hover:bg-gray-200 active:bg-gray-300 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        {loading ? "Creating…" : "Create Board"}
      </button>
    </form>
  );
}
FORM_EOF
echo "  ✓ src/app/host/boards/new/form.tsx (with payout coordination)"

# ============================================================
# 4. WINNER PAYOUT DISPLAY COMPONENT
# ============================================================
mkdir -p "src/app/host/boards/[id]"
cat > 'src/app/host/boards/[id]/winner-payout-card.tsx' << 'WINNER_EOF'
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
WINNER_EOF
echo "  ✓ src/app/host/boards/[id]/winner-payout-card.tsx"

# ============================================================
# 5. HOST PAYMENT INFO DISPLAY (for player board)
# ============================================================
mkdir -p "src/components"
cat > 'src/components/host-payment-info.tsx' << 'HOSTPAY_EOF'
"use client";

interface HostPaymentInfoProps {
  venmo: string | null;
  zelle: string | null;
  cashapp: string | null;
  visibility: "public" | "pin_gated";
  pinVerified: boolean;
}

export default function HostPaymentInfo({
  venmo,
  zelle,
  cashapp,
  visibility,
  pinVerified,
}: HostPaymentInfoProps) {
  const hasAny = venmo || zelle || cashapp;
  if (!hasAny) return null;

  // PIN-gated and not verified
  if (visibility === "pin_gated" && !pinVerified) {
    return (
      <div className="rounded-lg border border-gray-800 bg-gray-900/50 p-3 mb-4">
        <p className="text-xs text-gray-500">
          🔒 Host payment info available after PIN entry
        </p>
      </div>
    );
  }

  const methods: string[] = [];
  if (venmo) methods.push(`Venmo: ${venmo}`);
  if (zelle) methods.push(`Zelle: ${zelle}`);
  if (cashapp) methods.push(`CashApp: ${cashapp}`);

  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900/50 p-3 mb-4">
      <p className="text-xs text-gray-400">
        💰 Host pays winners via: {methods.join(" · ")}
      </p>
    </div>
  );
}
HOSTPAY_EOF
echo "  ✓ src/components/host-payment-info.tsx"

# ============================================================
# 6. PLAYER PAYOUT SELECTOR COMPONENT
# ============================================================
cat > 'src/components/player-payout-select.tsx' << 'PAYSELECT_EOF'
"use client";

interface PlayerPayoutSelectProps {
  hostVenmo: string | null;
  hostZelle: string | null;
  hostCashapp: string | null;
  required: boolean;
  selectedMethod: string;
  handle: string;
  onMethodChange: (method: string) => void;
  onHandleChange: (handle: string) => void;
}

export default function PlayerPayoutSelect({
  hostVenmo,
  hostZelle,
  hostCashapp,
  required,
  selectedMethod,
  handle,
  onMethodChange,
  onHandleChange,
}: PlayerPayoutSelectProps) {
  // Build options filtered to host's available methods + cash
  const options: { value: string; label: string; needsHandle: boolean }[] = [];
  if (hostVenmo) options.push({ value: "venmo", label: "Venmo", needsHandle: true });
  if (hostZelle) options.push({ value: "zelle", label: "Zelle", needsHandle: true });
  if (hostCashapp) options.push({ value: "cashapp", label: "CashApp", needsHandle: true });
  options.push({ value: "cash", label: "Cash (in person)", needsHandle: false });

  if (options.length === 1 && options[0].value === "cash") {
    // Only cash available and no host handles — don't show selector
    return null;
  }

  const selected = options.find((o) => o.value === selectedMethod);

  return (
    <div>
      <label className="block text-xs text-gray-400 mb-1">
        How should the host pay you?
        {!required && (
          <span className="text-gray-600 ml-1">(optional)</span>
        )}
      </label>
      <select
        value={selectedMethod}
        onChange={(e) => {
          onMethodChange(e.target.value);
          onHandleChange("");
        }}
        required={required}
        className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2.5 text-sm text-white focus:outline-none focus:border-indigo-600 focus:ring-1 focus:ring-indigo-600"
      >
        <option value="">Select…</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {!required && !selectedMethod && (
        <p className="text-[10px] text-gray-600 mt-1">
          Helps the host pay you faster if you win
        </p>
      )}

      {/* Handle input — only for non-cash methods */}
      {selected?.needsHandle && (
        <div className="mt-2">
          <input
            type="text"
            value={handle}
            onChange={(e) => onHandleChange(e.target.value)}
            required={required}
            placeholder={
              selectedMethod === "venmo"
                ? "@your-venmo"
                : selectedMethod === "zelle"
                  ? "email or phone"
                  : "$your-cashapp"
            }
            className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2.5 text-sm text-white placeholder:text-gray-600 focus:outline-none focus:border-indigo-600 focus:ring-1 focus:ring-indigo-600"
          />
        </div>
      )}
    </div>
  );
}
PAYSELECT_EOF
echo "  ✓ src/components/player-payout-select.tsx"

# ============================================================
# 7. LOCALSTORAGE SAVE/LOAD UTILITY
# ============================================================
mkdir -p "src/lib"
cat > 'src/lib/player-storage.ts' << 'STORAGE_EOF'
// ============================================================
// Player "Save my info" — localStorage only
// Saves: name, email, phone
// Does NOT save: payout preference (varies per board)
// Reference: payout-coordination-memo.docx §2D
// ============================================================

const STORAGE_KEY = "squares_player_info";

interface SavedPlayerInfo {
  name: string;
  email: string;
  phone: string;
}

export function loadPlayerInfo(): SavedPlayerInfo | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed.name && (parsed.email || parsed.phone)) {
      return {
        name: parsed.name || "",
        email: parsed.email || "",
        phone: parsed.phone || "",
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function savePlayerInfo(info: SavedPlayerInfo): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(info));
  } catch {
    // localStorage not available — silently ignore
  }
}

export function clearPlayerInfo(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
STORAGE_EOF
echo "  ✓ src/lib/player-storage.ts"

echo ""
echo "=============================="
echo "✅ Files written. Next steps:"
echo ""
echo "1. Run the migration against your database:"
echo "   psql \$DATABASE_URL -f migrations/payout-coordination.sql"
echo ""
echo "2. Regenerate Prisma client:"
echo "   npx prisma generate"
echo ""
echo "3. UPDATE EXISTING FILES MANUALLY (see below)"
echo ""
echo "=============================="
echo "📋 MANUAL EDITS REQUIRED"
echo "=============================="
echo ""
echo "These files need surgical edits that are safer to do by hand"
echo "than to overwrite with this script. See SYSTEM-FLOW.md §8 for context."
echo ""
echo "A. src/app/api/boards/route.ts (board creation API)"
echo "   — Accept new fields in POST body: hostVenmo, hostZelle,"
echo "     hostCashapp, payoutVisibility, requirePlayerPayout"
echo "   — Pass them through to prisma.board.create()"
echo ""
echo "B. src/app/api/checkout/route.ts (card checkout API)"
echo "   — Accept new fields: playerPhone, playerPayoutMethod,"
echo "     playerPayoutHandle, smsOptIn"
echo "   — Pass to square update in the lock step"
echo ""
echo "C. src/app/api/board/[slug]/cash-reserve/route.ts"
echo "   — Accept new fields: playerPhone, playerEmail (optional),"
echo "     playerPayoutMethod, playerPayoutHandle, smsOptIn"
echo "   — Pass to square update"
echo ""
echo "D. src/app/board/[slug]/page.tsx (player board server component)"
echo "   — Pass new board props to PlayerBoard: hostVenmo, hostZelle,"
echo "     hostCashapp, payoutVisibility, requirePlayerPayout"
echo ""
echo "E. src/app/board/[slug]/player-board.tsx (player board client)"
echo "   — Add phone field (required both flows)"
echo "   — Add PlayerPayoutSelect component"
echo "   — Add SMS opt-in checkbox"
echo "   — Add Save my info checkbox"
echo "   — Add HostPaymentInfo display"
echo "   — Import and use loadPlayerInfo/savePlayerInfo"
echo ""
echo "F. src/app/host/boards/[id]/page.tsx (host dashboard)"
echo "   — Import WinnerPayoutCard"
echo "   — Update squares query to include new fields"
echo "   — Replace winner display with WinnerPayoutCard"
echo ""
echo "After all edits, test the full flow per SYSTEM-FLOW.md §5."
echo ""
echo "git add -A"
echo "git commit -m 'feat: payout coordination — host handles, player payout info, phone, SMS opt-in, save my info'"
