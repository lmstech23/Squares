"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

interface ScoreEntryProps {
  boardId: string;
  teamCol: string;
  teamRow: string;
  periodLabels: string[];
  existingScoresA: number[] | null;
  existingScoresB: number[] | null;
}

export default function ScoreEntry({
  boardId,
  teamCol,
  teamRow,
  periodLabels,
  existingScoresA,
  existingScoresB,
}: ScoreEntryProps) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  // Track input values as strings so empty fields work cleanly
  const [inputsA, setInputsA] = useState<string[]>(() =>
    periodLabels.map((_, i) =>
      existingScoresA?.[i] !== undefined && existingScoresA?.[i] !== null
        ? String(existingScoresA[i])
        : ""
    )
  );
  const [inputsB, setInputsB] = useState<string[]>(() =>
    periodLabels.map((_, i) =>
      existingScoresB?.[i] !== undefined && existingScoresB?.[i] !== null
        ? String(existingScoresB[i])
        : ""
    )
  );

  function updateInput(
    team: "a" | "b",
    index: number,
    value: string
  ) {
    if (team === "a") {
      setInputsA((prev) => {
        const next = [...prev];
        next[index] = value;
        return next;
      });
    } else {
      setInputsB((prev) => {
        const next = [...prev];
        next[index] = value;
        return next;
      });
    }
    setSaved(false);
  }

  // Check if at least one complete period has scores
  function hasAnyScores(): boolean {
    return periodLabels.some(
      (_, i) => inputsA[i] !== "" && inputsB[i] !== ""
    );
  }

  async function saveScores() {
    // Build arrays — fill incomplete periods with existing values or 0
    const scoresA = periodLabels.map((_, i) => {
      const val = parseInt(inputsA[i], 10);
      return isNaN(val) ? (existingScoresA?.[i] ?? 0) : val;
    });
    const scoresB = periodLabels.map((_, i) => {
      const val = parseInt(inputsB[i], 10);
      return isNaN(val) ? (existingScoresB?.[i] ?? 0) : val;
    });

    // Validate all values are non-negative
    if (scoresA.some((v) => v < 0) || scoresB.some((v) => v < 0)) {
      setError("Scores must be non-negative.");
      return;
    }

    setSaving(true);
    setError("");

    try {
      const res = await fetch(`/api/boards/${boardId}/scores`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scoresTeamA: scoresA,
          scoresTeamB: scoresB,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        setError(data.error || "Failed to save scores.");
        setSaving(false);
        return;
      }

      setSaving(false);
      setSaved(true);
      router.refresh();
    } catch {
      setError("Network error. Try again.");
      setSaving(false);
    }
  }

  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900 p-4">
      <p className="text-sm font-medium mb-3">Enter Scores</p>

      {/* Header row */}
      <div className="grid grid-cols-[1fr_80px_80px] gap-2 mb-2 text-[10px] text-gray-500 uppercase tracking-wider">
        <div />
        <div className="text-center">{teamCol}</div>
        <div className="text-center">{teamRow}</div>
      </div>

      {/* Period rows — dynamic from periodLabels */}
      {periodLabels.map((label, i) => (
        <div
          key={label}
          className="grid grid-cols-[1fr_80px_80px] gap-2 items-center mb-2"
        >
          <div className="text-xs text-gray-400 font-medium">{label}</div>
          <input
            type="number"
            min="0"
            value={inputsA[i] ?? ""}
            onChange={(e) => updateInput("a", i, e.target.value)}
            className="rounded border border-gray-700 bg-gray-800 px-2 py-1.5 text-sm text-white text-center outline-none focus:border-gray-500 transition-colors w-full"
            placeholder="—"
          />
          <input
            type="number"
            min="0"
            value={inputsB[i] ?? ""}
            onChange={(e) => updateInput("b", i, e.target.value)}
            className="rounded border border-gray-700 bg-gray-800 px-2 py-1.5 text-sm text-white text-center outline-none focus:border-gray-500 transition-colors w-full"
            placeholder="—"
          />
        </div>
      ))}

      {/* Save button */}
      <button
        onClick={saveScores}
        disabled={saving || !hasAnyScores()}
        className={`mt-2 w-full rounded px-3 py-2 text-sm font-medium transition-colors ${
          saved
            ? "bg-green-950 text-green-400 border border-green-900"
            : "bg-gray-800 text-gray-300 border border-gray-700 hover:bg-gray-700"
        } disabled:opacity-50`}
      >
        {saving ? "Saving…" : saved ? "✓ Scores Saved" : "Save Scores"}
      </button>

      {error && <p className="text-xs text-red-400 mt-2">{error}</p>}
    </div>
  );
}
