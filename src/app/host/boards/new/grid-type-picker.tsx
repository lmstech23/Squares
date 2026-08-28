"use client";

import { useState } from "react";

type GridType = "standard" | "double";

interface Props {
  onContinue: (gridType: GridType) => void;
  onCancel: () => void;
}

export default function GridTypePicker({ onContinue, onCancel }: Props) {
  const [selected, setSelected] = useState<GridType | null>(null);

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center p-4 z-50">
      <div className="bg-gray-950 border border-gray-800 rounded-lg max-w-2xl w-full p-6">
        <h2 className="text-lg font-semibold mb-1">Pick your grid</h2>
        <p className="text-sm text-gray-500 mb-5">
          You can&apos;t switch after players start buying squares.
        </p>

        <div className="grid grid-cols-2 gap-3 mb-5">
          {/* Standard */}
          <button
            type="button"
            onClick={() => setSelected("standard")}
            className={`text-left rounded-lg border p-4 transition-colors ${
              selected === "standard"
                ? "border-green-500 bg-green-950/20"
                : "border-gray-800 bg-gray-900 hover:border-gray-700"
            }`}
          >
            <div className="text-sm font-medium mb-2">Standard</div>
            <div className="grid grid-cols-10 gap-px p-1.5 bg-gray-800 rounded mb-3 w-32 mx-auto">
              {Array.from({ length: 100 }).map((_, i) => (
                <div key={i} className="aspect-square bg-gray-700/40 rounded-sm" />
              ))}
            </div>
            <div className="text-xs font-medium mb-1">100 squares</div>
            <p className="text-xs text-gray-500 leading-relaxed">
              Each row and column covers one number. The classic format.
            </p>
          </button>

          {/* Double */}
          <button
            type="button"
            onClick={() => setSelected("double")}
            className={`text-left rounded-lg border p-4 transition-colors ${
              selected === "double"
                ? "border-green-500 bg-green-950/20"
                : "border-gray-800 bg-gray-900 hover:border-gray-700"
            }`}
          >
            <div className="text-sm font-medium mb-2">Double</div>
            <div className="grid grid-cols-5 gap-0.5 p-1.5 bg-gray-800 rounded mb-3 w-32 mx-auto">
              {Array.from({ length: 25 }).map((_, i) => (
                <div key={i} className="aspect-square bg-gray-700/40 rounded-sm" />
              ))}
            </div>
            <div className="text-xs font-medium mb-1">25 squares</div>
            <p className="text-xs text-gray-500 leading-relaxed">
              Each row and column covers two numbers. Smaller pool, bigger
              chance to win per square.
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
              ? `Continue with ${selected === "standard" ? "Standard" : "Double"}`
              : "Continue"}
          </button>
        </div>
      </div>
    </div>
  );
}