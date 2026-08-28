"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import BoardTypePicker from "./board-type-picker";
import GridTypePicker from "./grid-type-picker";
import FundraiserForm from "./fundraiser-form";
import NewBoardForm from "./form";

type BoardType = "game" | "fundraiser";
type GridType = "standard" | "double";

interface Props {
  isCashHost: boolean;
}

export default function NewBoardFlow({ isCashHost }: Props) {
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
  if (boardType === "fundraiser") {
    return (
      <FundraiserForm
        isCashHost={isCashHost}
        onBack={() => setBoardType(null)}
      />
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
