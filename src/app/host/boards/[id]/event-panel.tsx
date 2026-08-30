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
// headcount, and it never reaches the check-in roster.

export interface CheckinStaffLink {
  id: string;
  label: string;
  revoked: boolean;
}

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
  links: CheckinStaffLink[];
}

export default function EventPanel({
  boardId,
  expected,
  unpaidForecast,
  grants,
  links,
}: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  // Shown once, immediately after creation. The raw value is never stored, so
  // this is the only moment it can be copied.
  const [freshLink, setFreshLink] = useState<string | null>(null);

  async function createLink() {
    if (!label.trim()) return;
    setBusy("create");
    setError(null);
    try {
      const res = await fetch(`/api/host/boards/${boardId}/check-in-staff`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Could not create the link.");
        return;
      }
      setFreshLink(`${window.location.origin}/gate/${data.token}`);
      setLabel("");
      router.refresh();
    } catch {
      setError("Network error.");
    } finally {
      setBusy(null);
    }
  }

  async function revoke(checkinStaffId: string) {
    setBusy(checkinStaffId);
    setError(null);
    try {
      const res = await fetch(`/api/host/boards/${boardId}/check-in-staff`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ checkinStaffId }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Could not revoke.");
        return;
      }
      router.refresh();
    } catch {
      setError("Network error.");
    } finally {
      setBusy(null);
    }
  }

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

      {/* Check-in staff links — v2 6B */}
      <div className="mt-5 pt-4 border-t border-gray-800">
        <p className="text-[10px] font-medium text-gray-500 uppercase tracking-wider mb-2">
          Check-in staff links
        </p>

        <div className="flex gap-2">
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Renee - main gate"
            className="flex-1 rounded-lg border border-gray-800 bg-gray-950 px-3 py-2 text-sm text-white placeholder:text-gray-600 outline-none focus:border-gray-600"
          />
          <button
            type="button"
            disabled={busy === "create" || !label.trim()}
            onClick={createLink}
            className="rounded-lg border border-gray-700 px-3 py-2 text-xs text-gray-300 hover:text-white disabled:opacity-50 transition-colors"
          >
            {busy === "create" ? "..." : "Create link"}
          </button>
        </div>

        {freshLink && (
          <div className="mt-3 rounded-lg border border-green-900/50 bg-green-950/30 p-3">
            <p className="text-xs text-green-200 font-medium">
              Copy this now &mdash; it is shown once and cannot be retrieved.
            </p>
            <p className="text-xs text-green-100/90 mt-1.5 break-all font-mono">
              {freshLink}
            </p>
            {/* The gotcha, in the share UI rather than a support doc nobody
                reads. iOS blocks camera access inside in-app browsers, so a
                link opened from Facebook or Instagram fails the camera
                silently and the staff member never learns why. */}
            <p className="text-xs text-green-200/80 mt-2 leading-relaxed">
              <strong>Send this by text or email.</strong> Sharing it through
              Facebook or Instagram opens it in their in-app browser, where the
              camera is blocked and scanning silently fails. Search still works,
              but nobody will know why the scanner did not.
            </p>
          </div>
        )}

        {links.length > 0 && (
          <div className="space-y-1.5 mt-3">
            {links.map((l) => (
              <div
                key={l.id}
                className="flex items-center justify-between gap-3 rounded-lg border border-gray-800 bg-gray-950 px-3 py-2"
              >
                <span
                  className={`text-sm truncate ${l.revoked ? "text-gray-600 line-through" : ""}`}
                >
                  {l.label}
                </span>
                {l.revoked ? (
                  <span className="text-xs text-gray-600 flex-shrink-0">
                    Revoked
                  </span>
                ) : (
                  <button
                    type="button"
                    disabled={busy === l.id}
                    onClick={() => revoke(l.id)}
                    className="flex-shrink-0 text-xs text-gray-500 hover:text-red-400 disabled:opacity-50 transition-colors"
                  >
                    {busy === l.id ? "..." : "Revoke"}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
