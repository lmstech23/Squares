"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import GridTypePicker from "./grid-type-picker";
import NewBoardForm from "./form";

type GridType = "standard" | "double";

export default function NewBoardFlow() {
  const router = useRouter();
  const [gridType, setGridType] = useState<GridType | null>(null);

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