import Link from "next/link";
import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from "react";
import styles from "./Button.module.css";

// Primary, secondary and text actions — UI System 1.0. A Button with an `href`
// renders a link styled the same way; without one it is a <button>.

export type ButtonVariant = "primary" | "secondary" | "text";

type Common = {
  variant?: ButtonVariant;
  /** Stretch to the container — mobile primary actions are full width. */
  fullWidth?: boolean;
  children: ReactNode;
  className?: string;
};

type AsButton = Common & Omit<ButtonHTMLAttributes<HTMLButtonElement>, keyof Common> & { href?: undefined };
type AsLink = Common & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, keyof Common> & { href: string };

export type ButtonProps = AsButton | AsLink;

export function Button(props: ButtonProps) {
  const { variant = "primary", fullWidth = false, className, children, ...rest } = props;
  const cls = [styles.button, styles[variant], fullWidth ? styles.fullWidth : "", className ?? ""]
    .filter(Boolean)
    .join(" ");

  if (rest.href !== undefined) {
    const { href, ...anchor } = rest as Omit<AsLink, keyof Common>;
    return (
      <Link href={href} className={cls} {...anchor}>
        {children}
      </Link>
    );
  }

  const { type = "button", ...button } = rest as Omit<AsButton, keyof Common>;
  return (
    <button type={type} className={cls} {...button}>
      {children}
    </button>
  );
}
