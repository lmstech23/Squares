"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { reservationSearchTerms } from "@/lib/reference-code";

// The host's direct-payment reservation worklist — v2 §20.2.
//
// One card per reservation: code, buyer, tier lines, amount, rail, age. Two
// buttons. Nothing else.
//
// BINARY AND WHOLE-RESERVATION. `quantityConfirmed` can express a partly-paid
// reservation and the database enforces its bounds, but this surface does not
// offer it. Partial payment is real and will need a surface; a per-line control
// on the first version would be five decisions where a host expects one.
//
// NO AGING WARNING AND NO EXPIRY BADGE. There is no expiry and no reminder
// system, so a badge would imply a deadline that does not exist. The age is
// stated plainly and the host decides what it means.

export interface ReservationRow {
  id: string;
  referenceCode: string;
  contributorName: string;
  contributorEmail: string;
  railLabel: string;
  totalCents: number;
  createdAt: string;
  ageLabel: string;
  lines: { tier: string; priceBasis: string; unitPriceCents: number; quantity: number }[];
}

function money(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

const TIER_LABEL: Record<string, string> = { ADULT: "Adult", CHILD: "Child" };

export default function ReservationWorklist({
  boardId,
  reservations,
}: {
  boardId: string;
  reservations: ReservationRow[];
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  const pendingTotal = reservations.reduce((n, r) => n + r.totalCents, 0);

  // SEARCH IS A UNION, NEVER A CHOICE.
  //
  // The reference-code normaliser folds letters onto digits, so a five-letter
  // name comes out code-shaped - `Holly` normalises to `H011Y`. Branching on
  // that would send a host looking for Holly into a code lookup that finds
  // nothing and never search the names at all.
  //
  // So the RAW text always matches name and email, and the normalised value
  // ADDS a code match when it could be one. Neither suppresses the other.
  const visible = useMemo(() => {
    const { text, code } = reservationSearchTerms(query);
    if (!text) return reservations;
    const needle = text.toLowerCase();
    return reservations.filter(
      (r) =>
        r.contributorName.toLowerCase().includes(needle) ||
        r.contributorEmail.toLowerCase().includes(needle) ||
        (code !== null && r.referenceCode === code)
    );
  }, [query, reservations]);

  async function act(id: string, action: "confirm" | "release") {
    setError(null);
    setBusy(id);
    try {
      const res = await fetch(`/api/host/boards/${boardId}/entry-reservation`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reservationId: id, action }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Something went wrong.");
        setBusy(null);
        return;
      }
      setConfirming(null);
      router.refresh();
    } catch {
      setError("Something went wrong.");
    }
    setBusy(null);
  }

  if (reservations.length === 0) return null;

  return (
    <div className="mt-5 rounded-lg border border-amber-900/60 bg-amber-950/10 p-4">
      <p className="text-sm font-medium">Ticket reservations awaiting payment</p>

      {/* THE TOTAL, AND WHAT IT IS NOT. A host reading this beside "raised"
          must never take it for money she has. It is what people said they
          would send. */}
      <div className="mt-2 flex items-baseline gap-2">
        <span className="text-xl font-bold tabular-nums">{money(pendingTotal)}</span>
        <span className="text-xs text-gray-500">
          across {reservations.length}{" "}
          {reservations.length === 1 ? "reservation" : "reservations"}
        </span>
      </div>
      <p className="mt-1 text-xs text-amber-200/80 leading-relaxed">
        Not counted toward raised. This money is not yours until you confirm you
        received it.
      </p>

      {/* SAID UP FRONT, not discovered when she presses Close. */}
      <p className="mt-1.5 text-xs text-gray-500 leading-relaxed">
        Every one of these must be confirmed or released before the campaign can
        finish closing.
      </p>

      {reservations.length > 3 && (
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search name, email, or reference code"
          className="mt-3 w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-white placeholder:text-gray-600 outline-none focus:border-gray-500"
        />
      )}

      {error && <p className="mt-3 text-sm text-red-400">{error}</p>}

      <ul className="mt-3 space-y-2">
        {visible.length === 0 && (
          <li className="py-3 text-center text-sm text-gray-500">
            No match. Check the spelling, or try their email.
          </li>
        )}
        {visible.map((r) => (
          <li
            key={r.id}
            className="rounded-lg border border-gray-800 bg-gray-900 p-3"
          >
            <div className="flex items-baseline justify-between gap-3">
              <span className="font-mono text-base font-semibold tracking-wider">
                {r.referenceCode}
              </span>
              <span className="tabular-nums text-base font-medium">
                {money(r.totalCents)}
              </span>
            </div>

            <p className="mt-1 text-sm text-gray-200">{r.contributorName}</p>
            <p className="text-xs text-gray-600 truncate">{r.contributorEmail}</p>

            <p className="mt-1.5 text-xs text-gray-400">
              {r.lines
                .map(
                  (l) =>
                    `${l.quantity} ${TIER_LABEL[l.tier] ?? l.tier}${
                      l.priceBasis === "EARLY" ? " (early)" : ""
                    } @ ${money(l.unitPriceCents)}`
                )
                .join(" · ")}
            </p>
            <p className="mt-0.5 text-xs text-gray-600">
              {r.railLabel} · reserved {r.ageLabel}
            </p>

            {confirming === r.id ? (
              // Confirming mints passes and writes money. One extra tap, because
              // the undo for this is a void and a support conversation.
              <div className="mt-2.5">
                <p className="text-xs text-gray-300">
                  Confirm you received {money(r.totalCents)} from{" "}
                  {r.contributorName}?
                </p>
                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    disabled={busy === r.id}
                    onClick={() => act(r.id, "confirm")}
                    className="flex-1 rounded-lg bg-white px-3 py-2 text-sm font-medium text-gray-950 hover:bg-gray-200 disabled:opacity-50 transition-colors"
                  >
                    {busy === r.id ? "Confirming…" : "Yes, received"}
                  </button>
                  <button
                    type="button"
                    disabled={busy === r.id}
                    onClick={() => setConfirming(null)}
                    className="rounded-lg border border-gray-700 px-3 py-2 text-sm text-gray-300 hover:border-gray-500 transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div className="mt-2.5 flex gap-2">
                <button
                  type="button"
                  disabled={busy === r.id}
                  onClick={() => setConfirming(r.id)}
                  className="flex-1 rounded-lg bg-white px-3 py-2 text-sm font-medium text-gray-950 hover:bg-gray-200 disabled:opacity-50 transition-colors"
                >
                  Confirm payment
                </button>
                <button
                  type="button"
                  disabled={busy === r.id}
                  onClick={() => act(r.id, "release")}
                  className="rounded-lg border border-gray-700 px-3 py-2 text-sm text-gray-300 hover:border-gray-500 disabled:opacity-50 transition-colors"
                >
                  Release
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>

      <p className="mt-3 text-xs text-gray-600 leading-relaxed">
        Releasing emails the buyer to say nothing is owed, so someone who has
        already sent money knows to contact you.
      </p>
    </div>
  );
}
