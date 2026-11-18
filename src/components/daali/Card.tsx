import type { ReactNode } from "react";
import styles from "./Card.module.css";

// A surface card — UI System 1.0. Title (Lora) and subtitle are optional; with
// neither, it is just the surface.

export type CardProps = {
  title?: ReactNode;
  subtitle?: ReactNode;
  /** Heading level for the title. Defaults to h2. */
  titleAs?: "h1" | "h2" | "h3";
  as?: "section" | "div" | "article";
  children?: ReactNode;
  className?: string;
};

export function Card({ title, subtitle, titleAs: Title = "h2", as: Tag = "section", children, className }: CardProps) {
  return (
    <Tag className={[styles.card, className ?? ""].filter(Boolean).join(" ")}>
      {title ? <Title className={styles.title}>{title}</Title> : null}
      {subtitle ? <p className={styles.subtitle}>{subtitle}</p> : null}
      {children ? <div className={styles.body}>{children}</div> : null}
    </Tag>
  );
}
