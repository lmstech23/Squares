import Link from "next/link";
import type { ReactNode } from "react";
import { AvatarMenu, type AvatarMenuProps } from "./AvatarMenu";
import styles from "./AppShell.module.css";

// The signed-in shell — UI System 1.0 "Minimal navigation". The D mark and
// wordmark on the left, an optional breadcrumb, the organizer's avatar menu on
// the right. No sidebar.

export type AppShellProps = AvatarMenuProps & {
  /** Context after the wordmark, e.g. an item's title. Hidden on mobile. */
  breadcrumb?: ReactNode;
  /** Makes the wordmark a link. Omitted until the destination exists. */
  homeHref?: string;
  children: ReactNode;
};

export function AppShell({ breadcrumb, homeHref, children, ...menu }: AppShellProps) {
  const brand = (
    <>
      <span className={styles.mark} aria-hidden="true">
        D
      </span>
      Daali
    </>
  );

  return (
    <>
      <header className={styles.header}>
        <div className={styles.bar}>
          <div className={styles.brand}>
            {homeHref ? (
              <Link href={homeHref} className={styles.wordmark}>
                {brand}
              </Link>
            ) : (
              <span className={styles.wordmark}>{brand}</span>
            )}
            {breadcrumb ? <span className={styles.crumb}>/ {breadcrumb}</span> : null}
          </div>
          <AvatarMenu {...menu} />
        </div>
      </header>
      <main className={styles.main}>{children}</main>
    </>
  );
}
