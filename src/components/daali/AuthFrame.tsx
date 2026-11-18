import type { ReactNode } from "react";
import { Card } from "./Card";
import shell from "./AppShell.module.css";
import styles from "./AuthFrame.module.css";

// The signed-out frame for account screens (/start, /sign-in, /auth/confirm):
// the AppShell bar's wordmark with no organizer menu, then one card. The card
// title is the page's h1.

export type AuthFrameProps = {
  title: ReactNode;
  subtitle?: ReactNode;
  /** Below the card, e.g. "Already have a Daali account? Sign in". */
  footer?: ReactNode;
  children?: ReactNode;
};

export function AuthFrame({ title, subtitle, footer, children }: AuthFrameProps) {
  return (
    <>
      <header className={shell.header}>
        <div className={shell.bar}>
          <div className={shell.brand}>
            <span className={shell.wordmark}>
              <span className={shell.mark} aria-hidden="true">
                D
              </span>
              Daali
            </span>
          </div>
        </div>
      </header>
      <main className={styles.column}>
        <Card title={title} titleAs="h1" subtitle={subtitle}>
          {children}
        </Card>
        {footer ? <p className={styles.footer}>{footer}</p> : null}
      </main>
    </>
  );
}
