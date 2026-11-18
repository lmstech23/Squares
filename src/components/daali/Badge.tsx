import type { ReactNode } from "react";
import styles from "./Badge.module.css";

// Type and status pills — UI System 1.0. Only the tones Slice 1 shows:
//   type   the organizer type, e.g. "Fundraiser"
//   live   "Live"
//   draft  "Draft"
//   closed "Closed" — neutral, in the type-chip style (ruled S1.3, built S1.6)
// The label is always text; colour never carries the meaning alone.

export type BadgeTone = "type" | "live" | "draft" | "closed";

export function Badge({ tone, children }: { tone: BadgeTone; children: ReactNode }) {
  return <span className={`${styles.badge} ${styles[tone]}`}>{children}</span>;
}
