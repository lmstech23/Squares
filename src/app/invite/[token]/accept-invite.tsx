"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// The Accept button, and the only thing that consumes an invitation.
//
// A POST BEHIND A CLICK. The page it sits on is a GET that reads and renders
// and changes nothing; acceptance happens here or not at all. That separation
// is what stops a link prefetcher or a mail scanner spending the invitation
// before the recipient has read it.

export default function AcceptInvite({ token }: { token: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function accept() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/invites/${encodeURIComponent(token)}/accept`, {
        method: "POST",
      });
      const data = await res.json();

      if (!res.ok) {
        // ALREADY A MANAGER IS NOT AN ERROR TO ACT ON. They have the access the
        // link was offering, so send them to the board rather than showing a
        // refusal for something that is already true.
        if (data.status === "already" && data.boardId) {
          router.push(`/host/boards/${data.boardId}`);
          return;
        }
        setError(data.error ?? "Something went wrong. Please try again.");
        setBusy(false);
        return;
      }

      // Straight to the board they now manage. A full navigation, not a client
      // push: the board page reads the grant server-side and must not be served
      // from a cache built before it existed.
      window.location.href = `/host/boards/${data.boardId}`;
    } catch {
      setError("Something went wrong. Please try again.");
      setBusy(false);
    }
  }

  return (
    <div className="mt-5">
      <button
        type="button"
        onClick={accept}
        disabled={busy}
        className="w-full rounded-lg bg-white px-4 py-3 text-sm font-medium text-gray-950 hover:bg-gray-200 disabled:opacity-50 transition-colors"
      >
        {busy ? "One moment…" : "Accept invitation"}
      </button>
      {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
    </div>
  );
}
