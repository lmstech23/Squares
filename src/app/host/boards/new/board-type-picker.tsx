"use client";

import { useState } from "react";

type BoardType = "game" | "fundraiser";

interface Props {
  onContinue: (boardType: BoardType) => void;
  onCancel: () => void;
}

export default function BoardTypePicker({ onContinue, onCancel }: Props) {
  const [selected, setSelected] = useState<BoardType | null>(null);

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center p-4 z-50">
      <div className="bg-gray-950 border border-gray-800 rounded-lg max-w-2xl w-full p-6">
        <h2 className="text-lg font-semibold mb-1">What kind of board?</h2>
        <p className="text-sm text-gray-500 mb-5">
          You can&apos;t switch after the first square is claimed.
        </p>

        <div className="grid grid-cols-2 gap-3 mb-5">
          {/* Game Day */}
          <button
            type="button"
            onClick={() => setSelected("game")}
            className={`text-left rounded-lg border p-4 transition-colors ${
              selected === "game"
                ? "border-green-500 bg-green-950/20"
                : "border-gray-800 bg-gray-900 hover:border-gray-700"
            }`}
          >
            <div className="text-sm font-medium mb-2">Game Day</div>
            <div className="grid grid-cols-10 gap-px p-1.5 bg-gray-800 rounded mb-3 w-32 mx-auto">
              {Array.from({ length: 100 }).map((_, i) => (
                <div key={i} className="aspect-square bg-gray-700/40 rounded-sm" />
              ))}
            </div>
            <div className="text-xs font-medium mb-1">Tied to a game</div>
            <p className="text-xs text-gray-500 leading-relaxed">
              Players pick squares. Winners come from the last digit of each
              team&apos;s score.
            </p>
          </button>

          {/* Fundraiser */}
          <button
            type="button"
            onClick={() => setSelected("fundraiser")}
            className={`text-left rounded-lg border p-4 transition-colors ${
              selected === "fundraiser"
                ? "border-green-500 bg-green-950/20"
                : "border-gray-800 bg-gray-900 hover:border-gray-700"
            }`}
          >
            <div className="text-sm font-medium mb-2">Fundraiser</div>
            <div className="p-1.5 bg-gray-800 rounded mb-3 w-32 mx-auto">
              <div className="grid grid-cols-10 gap-px mb-1.5">
                {Array.from({ length: 30 }).map((_, i) => (
                  <div
                    key={i}
                    className={`aspect-square rounded-sm ${
                      i < 19 ? "bg-green-600/50" : "bg-gray-700/40"
                    }`}
                  />
                ))}
              </div>
              <div className="h-1 rounded-full bg-gray-700/60 overflow-hidden">
                <div className="h-full w-[63%] bg-green-600/70" />
              </div>
            </div>
            <div className="text-xs font-medium mb-1">Tied to a cause</div>
            <p className="text-xs text-gray-500 leading-relaxed">
              Squares are contributions toward a goal. No teams, no scores, no
              digits.
            </p>
          </button>
        </div>

        <div className="flex justify-end gap-2 pt-3 border-t border-gray-800">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!selected}
            onClick={() => selected && onContinue(selected)}
            className="px-4 py-2 text-sm font-medium rounded-md bg-white text-gray-950 hover:bg-gray-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {selected
              ? `Continue with ${selected === "game" ? "Game Day" : "Fundraiser"}`
              : "Continue"}
          </button>
        </div>
      </div>
    </div>
  );
}
