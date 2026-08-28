"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import BoardTypePicker from "./board-type-picker";
import GridTypePicker from "./grid-type-picker";
import NewBoardForm from "./form";

type BoardType = "game" | "fundraiser";
type GridType = "standard" | "double";

export default function NewBoardFlow() {
  const router = useRouter();
  const [boardType, setBoardType] = useState<BoardType | null>(null);
  const [gridType, setGridType] = useState<GridType | null>(null);

  // Step 1 — Game Day vs Fundraiser (v2 §4)
  if (!boardType) {
    return (
      <BoardTypePicker
        onContinue={(type) => setBoardType(type)}
        onCancel={() => router.push("/host/boards")}
      />
    );
  }

  // Fundraiser skips the grid-type picker — square count is a field on the
  // fundraiser form instead (v2 §4).
  //
  // A2 SCAFFOLD — the fundraiser form is A3. Until it lands this branch cannot
  // create a board, so it must not ship to hosts. Replace the whole block with
  // <FundraiserForm /> in A3; nothing else here changes.
  if (boardType === "fundraiser") {
    return (
      <div className="fixed inset-0 bg-black/60 flex items-center justify-center p-4 z-50">
        <div className="bg-gray-950 border border-gray-800 rounded-lg max-w-md w-full p-6">
          <h2 className="text-lg font-semibold mb-1">Fundraiser boards</h2>
          <p className="text-sm text-gray-500 mb-5">
            Not available yet. The fundraiser form is the next step of the
            build.
          </p>
          <div className="flex justify-end gap-2 pt-3 border-t border-gray-800">
            <button
              type="button"
              onClick={() => setBoardType(null)}
              className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors"
            >
              Back
            </button>
            <button
              type="button"
              onClick={() => router.push("/host/boards")}
              className="px-4 py-2 text-sm font-medium rounded-md bg-white text-gray-950 hover:bg-gray-200 transition-colors"
            >
              Back to boards
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Step 2 — Game Day only: Standard vs Double, then the existing form.
  // Cancel returns to the dashboard, not to step 1 — SYSTEM-FLOW §3B documents
  // that behavior and Game Day stays exactly as documented.
  if (!gridType) {
    return (
      <GridTypePicker
        onContinue={(type) => setGridType(type)}
        onCancel={() => router.push("/host/boards")}
      />
    );
  }

  return <NewBoardForm gridType={gridType} />;
}
