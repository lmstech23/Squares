import type { ReactNode } from "react";
import styles from "./Layout.module.css";

// Spacing and copy primitives on the UI System 1.0 scale, so screens compose
// without page-level styling.

export function Stack({ gap = 16, children }: { gap?: 8 | 16 | 24 | 32; children: ReactNode }) {
  return <div className={`${styles.stack} ${styles[`gap${gap}`]}`}>{children}</div>;
}

export function Text({
  size = "body",
  muted = false,
  children,
}: {
  size?: "body" | "small";
  muted?: boolean;
  children: ReactNode;
}) {
  const cls = [styles.text, size === "small" ? styles.small : "", muted ? styles.muted : ""].filter(Boolean).join(" ");
  return <p className={cls}>{children}</p>;
}

/** A labelled rule, e.g. the "or" between Google and the email field. */
export function Divider({ children }: { children: ReactNode }) {
  return (
    <div className={styles.divider} role="separator">
      {children}
    </div>
  );
}
