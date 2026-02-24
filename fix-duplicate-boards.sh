#!/bin/bash
set -e
echo "Fixing duplicate pending boards (3 files)..."
echo ""

# --- 1. Add "Back to Boards" link to new board page ---
cat > 'src/app/host/boards/new/page.tsx' << 'EOF'
import { getHost } from "@/lib/auth";
import { redirect } from "next/navigation";
import NewBoardForm from "./form";
import Link from "next/link";

export default async function NewBoardPage() {
  const host = await getHost();
  if (!host) redirect("/login");

  if (!host.stripeChargesEnabled) {
    redirect("/host/stripe");
  }

  return (
    <div className="max-w-lg mx-auto">
      <Link
        href="/host/boards"
        className="text-sm text-gray-400 hover:text-white mb-6 inline-block"
      >
        ← Back to Boards
      </Link>
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
echo "  ✓ src/app/host/boards/new/page.tsx (added Back to Boards link)"

# --- 2. Add double-submit guard to form ---
cat > 'src/app/host/boards/new/form.tsx' << 'EOF'
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
  const [hostCut, setHostCut] = useState("20");
  const [payouts, setPayouts] = useState(DEFAULT_PAYOUTS);
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const payoutTotal = PERIOD_LABELS.reduce(
    (sum, label) => sum + (payouts[label] ?? 0),
    0
  );
  const payoutValid = Math.abs(payoutTotal - 100) <= 0.01;
  const priceNum = parseFloat(squarePrice);
  const hostCutNum = parseInt(hostCut, 10) || 0;
  const hostCutValid = hostCutNum >= 0 && hostCutNum <= 50;
  const formValid =
    gameName.trim().length > 0 &&
    teamCol.trim().length > 0 &&
    teamRow.trim().length > 0 &&
    priceNum >= 1 &&
    payoutValid &&
    hostCutValid;

  const totalPot = priceNum >= 1 ? priceNum * 100 : 0;
  const playerPool = Math.round(totalPot * (1 - hostCutNum / 100));

  function updatePayout(label: string, value: string) {
    const num = parseFloat(value) || 0;
    setPayouts((prev) => ({ ...prev, [label]: num }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!formValid || submitted) return;

    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/boards", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          gameName: gameName.trim(),
          squarePrice: priceNum,
          teamRow: teamRow.trim(),
          teamCol: teamCol.trim(),
          periodType: "halves",
          hostCutPercent: hostCutNum,
          payoutStructure: payouts,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        // If there's already a pending board, redirect to dashboard
        if (res.status === 409 && data.pendingBoardId) {
          router.push("/host/boards");
          return;
        }
        setError(data.error || "Something went wrong");
        setLoading(false);
        return;
      }

      setSubmitted(true);
      router.push(`/host/boards/${data.boardId}`);
    } catch {
      setError("Failed to create board");
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {/* Game Name */}
      <div>
        <label htmlFor="gameName" className="block text-sm text-gray-400 mb-1.5">
          Game
        </label>
        <input
          id="gameName"
          type="text"
          required
          value={gameName}
          onChange={(e) => setGameName(e.target.value)}
          placeholder="e.g. UNC vs Duke"
          className="w-full rounded-lg bg-gray-900 border border-gray-800 px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-gray-600"
        />
      </div>

      {/* Team Names */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor="teamCol" className="block text-sm text-gray-400 mb-1.5">
            Team across top
          </label>
          <input
            id="teamCol"
            type="text"
            required
            value={teamCol}
            onChange={(e) => setTeamCol(e.target.value)}
            placeholder="e.g. UNC"
            className="w-full rounded-lg bg-gray-900 border border-gray-800 px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-gray-600"
          />
        </div>
        <div>
          <label htmlFor="teamRow" className="block text-sm text-gray-400 mb-1.5">
            Team down side
          </label>
          <input
            id="teamRow"
            type="text"
            required
            value={teamRow}
            onChange={(e) => setTeamRow(e.target.value)}
            placeholder="e.g. Duke"
            className="w-full rounded-lg bg-gray-900 border border-gray-800 px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-gray-600"
          />
        </div>
      </div>

      {/* Price */}
      <div>
        <label htmlFor="squarePrice" className="block text-sm text-gray-400 mb-1.5">
          Price per square
        </label>
        <div className="relative">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 text-sm">
            $
          </span>
          <input
            id="squarePrice"
            type="number"
            min="1"
            step="1"
            required
            value={squarePrice}
            onChange={(e) => setSquarePrice(e.target.value)}
            placeholder="10"
            className="w-full rounded-lg bg-gray-900 border border-gray-800 pl-7 pr-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-gray-600"
          />
        </div>
        {priceNum >= 1 && (
          <p className="text-xs text-gray-600 mt-1">
            100 squares × ${priceNum} = ${priceNum * 100} total pot
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
            className="w-full rounded-lg bg-gray-900 border border-gray-800 px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-gray-600 pr-8"
          />
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 text-sm">
            %
          </span>
        </div>
        {totalPot > 0 && hostCutValid && (
          <p className="text-xs text-gray-600 mt-1">
            You keep ${Math.round(totalPot * (hostCutNum / 100))} · Players
            split ${playerPool}
          </p>
        )}
      </div>

      {/* Payout Split */}
      <div>
        <label className="block text-sm text-gray-400 mb-1.5">
          Player payout split
        </label>
        <div className="grid grid-cols-2 gap-3">
          {PERIOD_LABELS.map((label) => (
            <div key={label}>
              <p className="text-xs text-gray-500 mb-1 text-center">{label}</p>
              <div className="relative">
                <input
                  type="number"
                  min="0"
                  max="100"
                  step="1"
                  value={payouts[label] ?? ""}
                  onChange={(e) => updatePayout(label, e.target.value)}
                  className="w-full rounded-lg bg-gray-900 border border-gray-800 px-3 py-2 text-sm text-white text-center focus:outline-none focus:border-gray-600 pr-8"
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 text-sm">
                  %
                </span>
              </div>
            </div>
          ))}
        </div>
        <p
          className={`text-xs mt-1.5 ${
            payoutValid
              ? "text-gray-600" : "text-red-400"
          }`}
        >
          Total: {payoutTotal}%{!payoutValid && " — must equal 100%"}
        </p>
        {payoutValid && totalPot > 0 && hostCutValid && (
          <p className="text-xs text-gray-600 mt-0.5">
            {PERIOD_LABELS.map(
              (label) =>
                `${label}: $${Math.round(playerPool * ((payouts[label] ?? 0) / 100))}`
            ).join(" · ")}
          </p>
        )}
      </div>

      {/* Error */}
      {error && (
        <div className="rounded-lg border border-red-900/50 bg-red-950/30 p-3">
          <p className="text-sm text-red-300">{error}</p>
        </div>
      )}

      {/* Submit */}
      <button
        type="submit"
        disabled={!formValid || loading || submitted}
        className="w-full rounded-lg bg-white text-gray-950 py-2.5 text-sm font-medium hover:bg-gray-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        {submitted ? "Board Created — Redirecting…" : loading ? "Creating…" : "Create Board"}
      </button>
    </form>
  );
}
EOF
echo "  ✓ src/app/host/boards/new/form.tsx (added submitted guard + 409 handling)"

# --- 3. Patch API route: add pending board duplicate guard ---
# Insert the check right after the credit gate (after the 402 block)
node -e "
const fs = require('fs');
const file = 'src/app/api/boards/route.ts';
let s = fs.readFileSync(file, 'utf8');

// Find the credit gate block — insert pending check right before it
const creditGate = '// 2b. Credit gate — platform owner bypasses';
const idx = s.indexOf(creditGate);
if (idx === -1) {
  console.error('Could not find credit gate marker in', file);
  process.exit(1);
}

const pendingCheck = \`// 2b. Pending board duplicate guard — one pending board per host
    const existingPending = await prisma.board.findFirst({
      where: { hostId: host.id, status: 'pending_payment' },
    });
    if (existingPending) {
      return NextResponse.json(
        {
          error: 'You have a pending board awaiting payment. Complete or cancel it first.',
          pendingBoardId: existingPending.boardId,
        },
        { status: 409 }
      );
    }

    \`;

s = s.slice(0, idx) + pendingCheck + s.slice(idx);
fs.writeFileSync(file, s, 'utf8');
console.log('  ✓', file, '(added pending board duplicate guard)');
"

echo ""
echo "Done. 3 files patched."
echo ""
echo "Next:"
echo "  1. Clean up duplicate pending boards in Supabase SQL editor:"
echo "     DELETE FROM squares WHERE board_id IN (SELECT board_id FROM boards WHERE status = 'pending_payment' AND host_id = (SELECT id FROM hosts WHERE email = 'dtate@lmstechs.net'));"
echo "     DELETE FROM boards WHERE status = 'pending_payment' AND host_id = (SELECT id FROM hosts WHERE email = 'dtate@lmstechs.net');"
echo ""
echo "  2. git add -A && git commit -m 'fix: prevent duplicate pending boards + add navigation guards' && git push origin main"
