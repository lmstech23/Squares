"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// OWNER: invite a manager, and cancel an invitation that has not been used.
//
// collaborators v2.2 §5. The smallest surface that makes delegation real.
//
// COPY-AND-SHARE, NOT APP-SENT — ruled 2026-09-08. The link is shown ONCE and
// the owner sends it however they like. That keeps this slice independent of the
// communications backlog and matches the token model: shown once, never stored,
// only the hash persists. An owner who loses it cancels and makes another, which
// is the correct outcome for a credential.

export interface PendingInvite {
  id: string;
  boundEmail: string | null;
  expiresAt: string;
}

export interface ActiveManager {
  id: string;
  /** The address they were INVITED at, when there was one. Never Host.email. */
  invitedAs: string | null;
  acceptedAt: string | null;
}

export default function ManagersPanel({
  boardId,
  invites,
  managers,
}: {
  boardId: string;
  invites: PendingInvite[];
  managers: ActiveManager[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The raw link, held in memory only. Never fetched again — it cannot be. */
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  /** Which manager the owner is confirming removal of. Null = nobody. */
  const [confirming, setConfirming] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/host/boards/${boardId}/invites`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ boundEmail: email.trim() || null }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Could not create the invitation.");
        setBusy(false);
        return;
      }
      setLink(data.url);
      setEmail("");
      router.refresh();
    } catch {
      setError("Could not create the invitation.");
    }
    setBusy(false);
  }

  async function revoke(id: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/host/boards/${boardId}/collaborators`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ collaboratorId: id }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Could not remove that manager.");
      } else if (data.invitesRevoked > 0) {
        // SAID OUT LOUD. An owner who removes a manager and is not told that a
        // pending invitation went with them has been told half of what
        // happened — invariant 119 acted, and it is their board.
        setNotice(
          data.invitesRevoked === 1
            ? "Manager removed. Their unused invitation was cancelled too."
            : `Manager removed. ${data.invitesRevoked} unused invitations were cancelled too.`
        );
      } else {
        setNotice("Manager removed. Their access ended immediately.");
      }
      setConfirming(null);
      router.refresh();
    } catch {
      setError("Could not remove that manager.");
    }
    setBusy(false);
  }

  async function cancel(id: string) {
    setBusy(true);
    try {
      await fetch(`/api/host/boards/${boardId}/invites`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inviteId: id }),
      });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-4 rounded-lg border border-gray-800 bg-gray-900 p-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium text-white">Managers</p>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="text-xs text-gray-400 hover:text-white transition-colors"
        >
          {open ? "Close" : "Invite a manager"}
        </button>
      </div>
      <p className="text-xs text-gray-500 mt-1 leading-relaxed">
        A manager can record and confirm payments, manage the roster and
        volunteers, and edit the board. They cannot close it, run a draw, change
        prices or payment details.
      </p>

      {/* ---- active managers ------------------------------------------------
          Listed above the invite form: an owner opening this panel most often
          wants to see who is on the board, not to add somebody. */}
      {managers.length > 0 && (
        <div className="mt-3 space-y-1.5">
          {managers.map((m) => (
            <div
              key={m.id}
              className="rounded-lg border border-gray-800 bg-gray-950 px-3 py-2"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-xs text-gray-300 truncate">
                    {m.invitedAs ?? "Manager"}
                  </p>
                  {m.acceptedAt && (
                    <p className="text-[11px] text-gray-600">
                      Since{" "}
                      {new Date(m.acceptedAt).toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                      })}
                    </p>
                  )}
                </div>
                {confirming !== m.id && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setConfirming(m.id);
                      setNotice(null);
                    }}
                    className="text-xs text-gray-500 hover:text-red-400 transition-colors flex-shrink-0"
                  >
                    Remove
                  </button>
                )}
              </div>

              {/* CONFIRMATION IN PLACE, not a browser confirm(). It has to say
                  what actually happens: access ends now, and any unused
                  invitation to them is cancelled with it. */}
              {confirming === m.id && (
                <div className="mt-2 rounded-lg border border-red-900/60 bg-red-950/20 p-2.5">
                  <p className="text-xs text-red-200 leading-relaxed">
                    Remove this manager? Their access ends immediately, and any
                    unused invitation sent to them is cancelled. What they
                    already recorded stays on the board.
                  </p>
                  <div className="mt-2 flex gap-2">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => revoke(m.id)}
                      className="rounded-lg bg-red-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-400 disabled:opacity-50 transition-colors"
                    >
                      {busy ? "Removing…" : "Remove manager"}
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => setConfirming(null)}
                      className="rounded-lg border border-gray-700 px-3 py-1.5 text-xs text-gray-300 hover:text-white transition-colors"
                    >
                      Keep
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {notice && (
        <p className="mt-3 text-xs text-green-400 leading-relaxed">{notice}</p>
      )}

      {open && (
        <div className="mt-3 space-y-3">
          {/* SAID BEFORE THEY CREATE ANYTHING. An owner who assumes the app
              emailed the invitation will wait for a manager who never heard
              about it. Ruled 2026-09-08: delivery is copy-and-share. */}
          <div className="rounded-lg border border-gray-800 bg-gray-950 p-3">
            <p className="text-xs text-gray-300 leading-relaxed">
              <strong>No email or text is sent by Daali Boards.</strong> Create
              the invitation, then copy the link and send it to your manager
              yourself.
            </p>
          </div>

          <div>
            <label className="block text-xs text-gray-500 mb-1" htmlFor="inviteEmail">
              Their email <span className="text-gray-600">(recommended)</span>
            </label>
            <input
              id="inviteEmail"
              type="email"
              inputMode="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="renee@example.com"
              className="w-full rounded-lg border border-gray-800 bg-gray-950 px-3 py-2 text-sm text-white placeholder:text-gray-600 outline-none focus:border-gray-600 transition-colors"
            />
            {/* THE TRADE-OFF, STATED. An owner choosing to leave this blank
                should know what they are choosing: a bearer link, and one that
                revoking a manager later cannot reach — invariant 119 covers
                bound invitations only. */}
            <p className="mt-1 text-xs text-gray-600 leading-relaxed">
              With an email, only that person can accept. Leave it blank and
              anyone with the link can accept — and removing a manager later
              will not cancel it.
            </p>
          </div>

          <button
            type="button"
            onClick={create}
            disabled={busy}
            className="w-full rounded-lg bg-white px-3 py-2 text-sm font-medium text-gray-950 hover:bg-gray-200 disabled:opacity-50 transition-colors"
          >
            {busy ? "One moment…" : "Create invitation"}
          </button>

          {error && <p className="text-xs text-red-400">{error}</p>}

          {link && (
            <div className="rounded-lg border border-green-900/60 bg-green-950/20 p-3">
              {/* SHOWN ONCE, and the copy says so. It is not stored and cannot
                  be recovered; there is no screen that will show it again. */}
              <p className="text-xs text-green-200 font-medium">
                Copy this link now. It will not be shown again.
              </p>
              <p className="mt-1 text-xs text-green-200/70 leading-relaxed">
                Send it to your manager yourself — Daali Boards does not send it.
              </p>
              <p className="mt-2 break-all rounded bg-gray-950 px-2 py-1.5 text-[11px] text-gray-300">
                {link}
              </p>
              <button
                type="button"
                onClick={async () => {
                  await navigator.clipboard.writeText(link);
                  setCopied(true);
                }}
                className="mt-2 rounded-lg border border-green-800 px-3 py-1.5 text-xs text-green-100 hover:border-green-600 transition-colors"
              >
                {copied ? "Copied" : "Copy link"}
              </button>
            </div>
          )}
        </div>
      )}

      {invites.length > 0 && (
        <div className="mt-3 space-y-1.5">
          <p className="text-xs text-gray-500">Pending invitations</p>
          {invites.map((i) => (
            <div
              key={i.id}
              className="flex items-center justify-between gap-3 rounded-lg border border-gray-800 bg-gray-950 px-3 py-2"
            >
              <div className="min-w-0">
                <p className="text-xs text-gray-300 truncate">
                  {i.boundEmail ?? "Anyone with the link"}
                </p>
                <p className="text-[11px] text-gray-600">
                  Expires {new Date(i.expiresAt).toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                  })}
                </p>
              </div>
              <button
                type="button"
                disabled={busy}
                onClick={() => cancel(i.id)}
                className="text-xs text-gray-500 hover:text-red-400 transition-colors flex-shrink-0"
              >
                Cancel
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
