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

/** An accent eyebrow over a Lora display line — the page's h1. */
export function PageHeading({ eyebrow, title }: { eyebrow?: ReactNode; title: ReactNode }) {
  return (
    <header className={styles.pageHeading}>
      {eyebrow ? <p className={styles.eyebrow}>{eyebrow}</p> : null}
      <h1 className={styles.display}>{title}</h1>
    </header>
  );
}

/** A section's Lora h2, with an optional muted line under it. */
export function SectionHeading({ title, subtitle }: { title: ReactNode; subtitle?: ReactNode }) {
  return (
    <div className={styles.sectionHeading}>
      <h2 className={styles.sectionTitle}>{title}</h2>
      {subtitle ? <p className={styles.sectionSubtitle}>{subtitle}</p> : null}
    </div>
  );
}

/** The organizer footer: "Organized with care by Daali." */
export function OrganizerFooter() {
  return <footer className={styles.footer}>Organized with care by Daali.</footer>;
}
