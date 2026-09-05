"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// Record a cash donation — donations §7, invariant 65.
//
// ONE ACTION. There is no reserve step and no expiry: a cash donation holds no
// inventory, so a hold would be a state with no purpose. No minimum either —
// the host is recording money already in her hand.
//
// Email is optional, and this is the only surface where that is true (§10).

const inputClass =
  "w-full rounded-lg border border-gray-800 bg-gray-900 px-3 py-2.5 text-sm text-white placeholder:text-gray-600 outline-none focus:border-gray-600 transition-colors";
const labelClass = "block text-sm text-gray-400 mb-1.5";

export default function CashDonationForm({ boardId }: { boardId: string }) {
  const router = useRouter();
  const [amountText, setAmountText] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit() {
    const cents = Math.round(parseFloat(amountText) * 100);
    if (!Number.isFinite(cents) || cents <= 0) {
      setError("Enter an amount greater than zero.");
      return;
    }
    if (!name.trim()) {
      setError("A contributor name is required.");
      return;
    }
    setError(null);
    setOk(null);
    setLoading(true);
    try {
      const res = await fetch(`/api/host/boards/${boardId}/cash-donation`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amountCents: cents,
          donorName: name.trim(),
          donorEmail: email.trim() || null,
          donorPhone: phone.trim() || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Something went wrong.");
        setLoading(false);
        return;
      }
      setOk(`Recorded $${(cents / 100).toFixed(2)} from ${name.trim()}.`);
      setAmountText("");
      setName("");
      setEmail("");
      setPhone("");
      setLoading(false);
      router.refresh();
    } catch {
      setError("Something went wrong.");
      setLoading(false);
    }
  }

  return (
    <div className="rounded-lg border border-gray-800 bg-gray-950 p-4">
      <h2 className="text-sm font-medium">Record a cash donation</h2>
      <p className="mt-1 text-xs text-gray-500 leading-relaxed">
        Money already in hand. Recorded as received immediately — there is
        nothing to reserve and nothing to expire.
      </p>

      <div className="mt-4 space-y-3">
        <div>
          <label className={labelClass} htmlFor="cd-amount">
            Amount in dollars
          </label>
          <input
            id="cd-amount"
            inputMode="decimal"
            value={amountText}
            onChange={(e) => setAmountText(e.target.value)}
            placeholder="40"
            className={inputClass}
          />
        </div>
        <div>
          <label className={labelClass} htmlFor="cd-name">
            Contributor name
          </label>
          <input
            id="cd-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={inputClass}
          />
        </div>
        <div>
          <label className={labelClass} htmlFor="cd-email">
            Email <span className="text-gray-600">(optional)</span>
          </label>
          <input
            id="cd-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className={inputClass}
          />
        </div>
        <div>
          <label className={labelClass} htmlFor="cd-phone">
            Phone <span className="text-gray-600">(optional)</span>
          </label>
          <input
            id="cd-phone"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            className={inputClass}
          />
        </div>
      </div>

      {error && (
        <p className="mt-3 text-sm text-red-400" role="alert">
          {error}
        </p>
      )}
      {ok && <p className="mt-3 text-sm text-emerald-400">{ok}</p>}

      <button
        type="button"
        onClick={submit}
        disabled={loading}
        className="mt-4 w-full rounded-lg bg-white px-4 py-2.5 text-sm font-medium text-gray-950 hover:bg-gray-200 disabled:opacity-40 transition-colors"
      >
        {loading ? "Recording…" : "Record donation"}
      </button>
    </div>
  );
}
