// ============================================================
// src/app/host/dashboard/credit-badge.tsx
//
// Shows current credit balance. Always visible on dashboard
// and board creation page. No surprises.
//
// credits > 0  → "2 free boards remaining"
// credits = 0  → "Additional boards: $9 each"
// ============================================================

"use client";

import { CREDIT_PRICE_DISPLAY } from "@/lib/constants";

interface CreditBadgeProps {
  credits: number;
}

export default function CreditBadge({ credits }: CreditBadgeProps) {
  if (credits > 0) {
    return (
      <div className="inline-flex items-center gap-2 rounded-full bg-green-50 px-4 py-2 text-sm text-green-700 border border-green-200">
        <span className="font-medium">
          {credits} free board{credits !== 1 ? "s" : ""} remaining
        </span>
      </div>
    );
  }

  return (
    <div className="inline-flex items-center gap-2 rounded-full bg-gray-50 px-4 py-2 text-sm text-gray-600 border border-gray-200">
      <span>
        Additional boards: {CREDIT_PRICE_DISPLAY} each
      </span>
    </div>
  );
}
