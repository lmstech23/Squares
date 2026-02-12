"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

interface QuarterScore {
  col: number;
  row: number;
}

interface Scores {
  q1?: QuarterScore;
  q2?: QuarterScore;
  q3?: QuarterScore;
  final?: QuarterScore;
}

interface ScoreEntryProps {
  boardId: string;
  teamCol: string;
  teamRow: string;
  existingScores: Scores | null;
}

const QUARTERS = [
  { key: "q1" as const, label: "Q1" },
  { key: "q2" as const, label: "Q2" },
  { key: "q3" as const, label: "Q3" },
  { key: "final" as const, label: "Final" },
];

export default function ScoreEntry({
  boardId,
  teamCol,
  teamRow,
  existingScores,
}: ScoreEntryProps) {
  const router = useRouter();
  const [scores, setScores] = useState<Scores>(existingScores ?? {});
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState("");

  // Track input values as strings so empty fields work cleanly
  const [inputs, setInputs] = useState<
    Record<string, { col: string; row: string }>
  >(() => {
    const init: Record<string, { col: string; row: string }> = {};
    for (const q of QUARTERS) {
      const s = existingScores?.[q.key];
      init[q.key] = {
        col: s !== undefined ? String(s.col) : "",
        row: s !== undefined ? String(s.row) : "",
      };
    }
    return init;
  });

  function updateInput(quarter: string, team: "col" | "row", value: string) {
    setInputs((prev) => ({
      ...prev,
      [quarter]: { ...prev[quarter], [team]: value },
    }));
  }

  async function saveQuarter(quarterKey: string) {
    const input = inputs[quarterKey];
    const colVal = parseInt(input.col, 10);
    const rowVal = parseInt(input.row, 10);

    if (isNaN(colVal) || isNaN(rowVal) || colVal < 0 || rowVal < 0) {
      setError("Enter valid scores for both teams.");
      return;
    }

    setSaving(quarterKey);
    setError("");

    try {
      const res = await fetch(`/api/boards/${boardId}/scores`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          [quarterKey]: { col: colVal, row: rowVal },
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        setError(data.error || "Failed to save score.");
        setSaving(null);
        return;
      }

      const data = await res.json();
      setScores(data.scores);
      setSaving(null);
      router.refresh();
    } catch {
      setError("Network error. Try again.");
      setSaving(null);
    }
  }

  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900 p-4">
      <p className="text-sm font-medium mb-3">Enter Scores</p>

      {/* Header row */}
      <div className="grid grid-cols-[1fr_80px_80px_64px] gap-2 mb-2 text-[10px] text-gray-500 uppercase tracking-wider">
        <div />
        <div className="text-center">{teamCol}</div>
        <div className="text-center">{teamRow}</div>
        <div />
      </div>

      {/* Quarter rows */}
      {QUARTERS.map((q) => {
        const saved = scores[q.key];
        const isSaving = saving === q.key;

        return (
          <div
            key={q.key}
            className="grid grid-cols-[1fr_80px_80px_64px] gap-2 items-center mb-2"
          >
            <div className="text-xs text-gray-400 font-medium">{q.label}</div>
            <input
              type="number"
              min="0"
              value={inputs[q.key]?.col ?? ""}
              onChange={(e) => updateInput(q.key, "col", e.target.value)}
              className="rounded border border-gray-700 bg-gray-800 px-2 py-1.5 text-sm text-white text-center outline-none focus:border-gray-500 transition-colors w-full"
              placeholder="—"
            />
            <input
              type="number"
              min="0"
              value={inputs[q.key]?.row ?? ""}
              onChange={(e) => updateInput(q.key, "row", e.target.value)}
              className="rounded border border-gray-700 bg-gray-800 px-2 py-1.5 text-sm text-white text-center outline-none focus:border-gray-500 transition-colors w-full"
              placeholder="—"
            />
            <button
              onClick={() => saveQuarter(q.key)}
              disabled={isSaving}
              className={`rounded px-2 py-1.5 text-xs font-medium transition-colors ${
                saved
                  ? "bg-green-950 text-green-400 border border-green-900 hover:bg-green-900"
                  : "bg-gray-800 text-gray-300 border border-gray-700 hover:bg-gray-700"
              } disabled:opacity-50`}
            >
              {isSaving ? "…" : saved ? "✓ Saved" : "Save"}
            </button>
          </div>
        );
      })}

      {error && <p className="text-xs text-red-400 mt-2">{error}</p>}
    </div>
  );
}
