import type { ReactNode } from "react";
import styles from "./EmptyState.module.css";

// Empty state — UI System 1.0. A heading, one line of guidance, and an
// optional next step. The copy comes from the screen that uses it.

export type EmptyStateProps = {
  title: ReactNode;
  body?: ReactNode;
  action?: ReactNode;
  /** Heading level for the title. Defaults to h2. */
  titleAs?: "h2" | "h3";
};

function PlusIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path d="M7 1v12M1 7h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export function EmptyState({ title, body, action, titleAs: Title = "h2" }: EmptyStateProps) {
  return (
    <div className={styles.empty}>
      <span className={styles.icon}>
        <PlusIcon />
      </span>
      <Title className={styles.title}>{title}</Title>
      {body ? <p className={styles.body}>{body}</p> : null}
      {action ? <div className={styles.action}>{action}</div> : null}
    </div>
  );
}
