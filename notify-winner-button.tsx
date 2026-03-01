"use client";

// src/app/host/boards/[id]/notify-winner-button.tsx

import { useState } from "react";

interface NotifyWinnerButtonProps {
  boardId: string;
  periodLabel: string;
  winnerName: string | null;
  squareNumber: number;
  smsOptIn: boolean;
  alreadyNotified: boolean;
}

export default function NotifyWinnerButton({
  boardId,
  periodLabel,
  winnerName,
  squareNumber,
  smsOptIn,
  alreadyNotified: initialAlreadyNotified,
}: NotifyWinnerButtonProps) {
  const [showModal, setShowModal] = useState(false);
  const [sending, setSending] = useState(false);
  const [notified, setNotified] = useState(initialAlreadyNotified);
  const [sendFailed, setSendFailed] = useState(false);
  const [notifiedAt, setNotifiedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Already notified + SMS sent successfully
  if (notified && !sendFailed) {
    return (
      <p className="text-[11px] text-green-400 font-medium">
        ✅ Winner notified{notifiedAt ? ` at ${notifiedAt}` : ""}
      </p>
    );
  }

  // Already notified but SMS failed — show retry
  if (sendFailed) {
    return (
      <div>
        <p className="text-[11px] text-amber-400 mb-1">⚠️ Couldn't send SMS.</p>
        <button
          onClick={handleResend}
          disabled={sending}
          className="text-[11px] text-amber-300 underline disabled:opacity-50"
        >
          {sending ? "Retrying..." : "Retry SMS"}
        </button>
        {error && <p className="text-[10px] text-red-400 mt-1">{error}</p>}
      </div>
    );
  }

  // Player did not opt in
  if (!smsOptIn) {
    return (
      <p className="text-[11px] text-gray-500">Player did not opt in to SMS</p>
    );
  }

  async function handleNotify() {
    setSending(true);
    setError(null);

    try {
      const res = await fetch(`/api/host/boards/${boardId}/notify-winner`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ periodLabel }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Something went wrong.");
        setSending(false);
        setShowModal(false);
        return;
      }

      setNotified(true);
      if (!data.smsSent) {
        setSendFailed(true);
      } else {
        setNotifiedAt(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
      }
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setSending(false);
      setShowModal(false);
    }
  }

  async function handleResend() {
    setSending(true);
    setError(null);

    try {
      const res = await fetch(`/api/host/boards/${boardId}/resend-winner-sms`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ periodLabel }),
      });

      const data = await res.json();

      if (!res.ok || !data.smsSent) {
        setError(data.error || "Retry failed.");
        setSending(false);
        return;
      }

      setSendFailed(false);
      setNotifiedAt(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setSending(false);
    }
  }

  return (
    <>
      <button
        onClick={() => setShowModal(true)}
        className="text-[11px] bg-yellow-950 text-yellow-300 border border-yellow-800 rounded px-2 py-1 hover:bg-yellow-900 transition-colors"
      >
        Notify Winner 🎉
      </button>

      {error && <p className="text-[10px] text-red-400 mt-1">{error}</p>}

      {/* Confirmation modal */}
      {showModal && (
        <>
          <div
            className="fixed inset-0 bg-black/60 z-40"
            onClick={() => setShowModal(false)}
          />
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div className="bg-gray-900 border border-gray-700 rounded-xl p-5 max-w-sm w-full">
              <p className="text-sm font-medium mb-1">Send winner SMS?</p>
              <p className="text-xs text-gray-400 mb-5">
                Notify {winnerName ?? "this player"} (Square #{squareNumber}) that they won {periodLabel}.
              </p>
              <div className="flex gap-3">
                <button
                  onClick={() => setShowModal(false)}
                  className="flex-1 rounded-lg border border-gray-700 bg-gray-800 px-4 py-2 text-sm text-gray-300 hover:bg-gray-700 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleNotify}
                  disabled={sending}
                  className="flex-1 rounded-lg bg-yellow-500 text-gray-950 px-4 py-2 text-sm font-medium hover:bg-yellow-400 disabled:opacity-50 transition-colors"
                >
                  {sending ? "Sending..." : "Send SMS"}
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </>
  );
}
