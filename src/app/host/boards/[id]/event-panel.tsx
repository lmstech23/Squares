"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// Event panel — fundraiser-board-v2.md §9, addendum §6.
//
// Expected counts active and used passes on active supporters. Donated
// purchases contribute zero, which is the point of the checkbox.
//
// The unpaid line counts admissions that WOULD exist if outstanding direct
// payments confirm — a chase list before she orders food, mirroring the amber
// and green split she already reads on the grid. It is a forecast, never a
// headcount, and it never reaches the volunteer roster.

export interface GrantRow {
  grantId: string;
  name: string;
  email: string;
  tickets: number;
  donated: boolean;
  usedCount: number;
}

interface Props {
  boardId: string;
  expected: number;
  unpaidForecast: number;
  grants: GrantRow[];
}

export default function EventPanel({
  boardId,
  expected,
  unpaidForecast,
  grants,
}: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function toggle(grantId: string, donate: boolean) {
    setBusy(grantId);
    setError(null);
    try {
      const res = await fetch(`/api/host/boards/${boardId}/donate-flag`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ grantId, donate }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Something went wrong.");
        return;
      }
      router.refresh();
    } catch {
      setError("Network error.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900 p-4">
      <p className="text-sm font-medium mb-1">Event</p>
      <p className="text-sm text-gray-400">
        <span className="text-white font-semibold tabular-nums">{expected}</span>{" "}
        expected
        {unpaidForecast > 0 && (
          <>
            <span className="text-gray-600"> · </span>
            <span className="tabular-nums">{unpaidForecast}</span> if everyone
            awaiting payment confirms
          </>
        )}
      </p>

      {error && (
        <div className="rounded-lg border border-red-900/50 bg-red-950/30 p-3 mt-3">
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}

      {grants.length > 0 && (
        <div className="mt-4">
          <p className="text-[10px] font-medium text-gray-500 uppercase tracking-wider mb-2">
            Tickets by purchase
          </p>
          <div className="space-y-1.5">
            {grants.map((g) => (
              <div
                key={g.grantId}
                className="flex items-center justify-between gap-3 rounded-lg border border-gray-800 bg-gray-950 px-3 py-2.5"
              >
                <div className="min-w-0">
                  <p className="text-sm truncate">{g.name}</p>
                  <p className="text-xs text-gray-500 truncate">
                    {g.donated
                      ? "Donated — no tickets"
                      : `${g.tickets} ${g.tickets === 1 ? "ticket" : "tickets"}`}
                    {g.usedCount > 0 && ` · ${g.usedCount} scanned`}
                  </p>
                </div>

                {/* A used pass is never voidable. The control is absent rather
                    than disabled — the host cannot act, so offering the action
                    and refusing it is worse than not offering it. */}
                {g.donated || g.usedCount === 0 ? (
                  <button
                    type="button"
                    disabled={busy === g.grantId}
                    onClick={() => toggle(g.grantId, !g.donated)}
                    className="flex-shrink-0 rounded-lg border border-gray-700 px-3 py-1.5 text-xs text-gray-300 hover:text-white hover:border-gray-600 disabled:opacity-50 transition-colors"
                  >
                    {busy === g.grantId
                      ? "…"
                      : g.donated
                        ? "Give them tickets"
                        : "Donate tickets"}
                  </button>
                ) : (
                  <span className="flex-shrink-0 text-xs text-gray-600">
                    Scanned
                  </span>
                )}
              </div>
            ))}
          </div>
          <p className="text-xs text-gray-600 mt-2.5 leading-relaxed">
            Donating voids that purchase&apos;s unused tickets. Giving them back
            issues new ones — the old codes never work again.
          </p>
        </div>
      )}
    </div>
  );
}
