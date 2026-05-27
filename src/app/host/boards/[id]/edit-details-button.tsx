"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

interface EditDetailsButtonProps {
  boardId: string;
  gameName: string;
  teamCol: string;
  teamRow: string;
}

export default function EditDetailsButton({
  boardId,
  gameName: initialGameName,
  teamCol: initialTeamCol,
  teamRow: initialTeamRow,
}: EditDetailsButtonProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [gameName, setGameName] = useState(initialGameName);
  const [teamCol, setTeamCol] = useState(initialTeamCol);
  const [teamRow, setTeamRow] = useState(initialTeamRow);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const firstInputRef = useRef<HTMLInputElement>(null);

  const hasChanges =
    gameName.trim() !== initialGameName ||
    teamCol.trim() !== initialTeamCol ||
    teamRow.trim() !== initialTeamRow;

  const valid =
    gameName.trim().length > 0 &&
    teamCol.trim().length > 0 &&
    teamRow.trim().length > 0;

  // Esc-to-close + focus first input on open
  useEffect(() => {
    if (!open) return;

    firstInputRef.current?.focus();

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !saving) {
        setGameName(initialGameName);
        setTeamCol(initialTeamCol);
        setTeamRow(initialTeamRow);
        setError(null);
        setOpen(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, saving, initialGameName, initialTeamCol, initialTeamRow]);

  async function save() {
    setSaving(true);
    setError(null);

    try {
      const res = await fetch(`/api/host/boards/${boardId}/details`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          gameName: gameName.trim(),
          teamCol: teamCol.trim(),
          teamRow: teamRow.trim(),
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Failed to save.");
        setSaving(false);
        return;
      }

      setSaving(false);
      setOpen(false);
      router.refresh();
    } catch {
      setError("Network error. Try again.");
      setSaving(false);
    }
  }

  function cancel() {
    setGameName(initialGameName);
    setTeamCol(initialTeamCol);
    setTeamRow(initialTeamRow);
    setError(null);
    setOpen(false);
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
      >
        Edit details
      </button>
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={(e) => {
        // Backdrop click — only close if clicking the backdrop itself
        if (e.target === e.currentTarget && !saving) cancel();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="edit-details-title"
        className="w-full max-w-md rounded-lg border border-gray-800 bg-gray-950 p-5"
      >
        <h2
          id="edit-details-title"
          className="text-base font-medium mb-1"
        >
          Edit board details
        </h2>
        <p className="text-xs text-gray-500 mb-4">
          Update the game and team names. Players will see the new names on
          their next page load.
        </p>

        <div className="space-y-4">
          <div>
            <label
              htmlFor="edit-gameName"
              className="block text-xs text-gray-400 mb-1.5"
            >
              Game
            </label>
            <input
              id="edit-gameName"
              ref={firstInputRef}
              type="text"
              value={gameName}
              onChange={(e) => setGameName(e.target.value)}
              maxLength={100}
              className="w-full rounded-lg border border-gray-800 bg-gray-900 px-3 py-2 text-sm text-white outline-none focus:border-gray-600 transition-colors"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label
                htmlFor="edit-teamCol"
                className="block text-xs text-gray-400 mb-1.5"
              >
                Team across top
              </label>
              <input
                id="edit-teamCol"
                type="text"
                value={teamCol}
                onChange={(e) => setTeamCol(e.target.value)}
                maxLength={50}
                className="w-full rounded-lg border border-gray-800 bg-gray-900 px-3 py-2 text-sm text-white outline-none focus:border-gray-600 transition-colors"
              />
            </div>
            <div>
              <label
                htmlFor="edit-teamRow"
                className="block text-xs text-gray-400 mb-1.5"
              >
                Team down side
              </label>
              <input
                id="edit-teamRow"
                type="text"
                value={teamRow}
                onChange={(e) => setTeamRow(e.target.value)}
                maxLength={50}
                className="w-full rounded-lg border border-gray-800 bg-gray-900 px-3 py-2 text-sm text-white outline-none focus:border-gray-600 transition-colors"
              />
            </div>
          </div>
        </div>

        {error && <p className="text-xs text-red-400 mt-3">{error}</p>}

        <div className="flex gap-2 mt-5">
          <button
            onClick={cancel}
            disabled={saving}
            className="flex-1 rounded-lg border border-gray-800 bg-gray-900 px-3 py-2 text-sm text-gray-300 hover:bg-gray-800 transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={save}
            disabled={saving || !valid || !hasChanges}
            className="flex-1 rounded-lg bg-white px-3 py-2 text-sm font-medium text-gray-950 hover:bg-gray-200 transition-colors disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save changes"}
          </button>
        </div>
      </div>
    </div>
  );
}
