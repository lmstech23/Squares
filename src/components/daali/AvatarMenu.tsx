"use client";

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import styles from "./AppShell.module.css";

// The organizer identity and its menu, right of the AppShell bar.
//
// D-S1-5: ONLY ITEMS WITH A WORKING DESTINATION. Legacy Boards, when the
// organizer is entitled (the caller passes its href), and Sign out. Organizer
// profile and Settings join when their pages exist.

export type AvatarMenuProps = {
  displayName: string;
  avatarUrl?: string | null;
  /** The Legacy Boards destination. Omitted or null: the item is not rendered. */
  legacyBoardsHref?: string | null;
  /** Where Sign out lands. /login until /sign-in exists (S1.4). */
  signedOutHref?: string;
};

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "";
  const first = parts[0][0] ?? "";
  const last = parts.length > 1 ? parts[parts.length - 1][0] ?? "" : "";
  return (first + last).toUpperCase();
}

function Chevron() {
  return (
    <svg className={styles.chevron} width="10" height="6" viewBox="0 0 10 6" fill="none" aria-hidden="true">
      <path d="M1 1l4 4 4-4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function AvatarMenu({ displayName, avatarUrl, legacyBoardsHref, signedOutHref = "/login" }: AvatarMenuProps) {
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const router = useRouter();

  useEffect(() => {
    if (!open) return;
    // First item takes focus when the menu opens.
    wrapRef.current?.querySelector<HTMLElement>("[data-menu-item]")?.focus();

    const onPointer = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  async function signOut() {
    setSigningOut(true);
    await createClient().auth.signOut();
    router.push(signedOutHref);
  }

  const label = initials(displayName);

  return (
    <div className={styles.menuWrap} ref={wrapRef}>
      <button
        ref={triggerRef}
        type="button"
        className={styles.trigger}
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label={`Account menu for ${displayName}`}
        onClick={() => setOpen((o) => !o)}
      >
        <span className={styles.avatar} aria-hidden="true">
          {avatarUrl ? <img src={avatarUrl} alt="" /> : label}
        </span>
        <span className={styles.who}>
          <span className={styles.name}>{displayName}</span>
          <span className={styles.role}>Organizer</span>
        </span>
        <Chevron />
      </button>

      {open ? (
        <ul id={menuId} className={styles.menu}>
          {legacyBoardsHref ? (
            <li>
              <Link href={legacyBoardsHref} className={styles.item} data-menu-item onClick={() => setOpen(false)}>
                Legacy Boards
              </Link>
            </li>
          ) : null}
          <li>
            <button type="button" className={styles.item} data-menu-item onClick={signOut} disabled={signingOut}>
              {signingOut ? "Signing out…" : "Sign out"}
            </button>
          </li>
        </ul>
      ) : null}
    </div>
  );
}
