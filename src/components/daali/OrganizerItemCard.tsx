import Link from "next/link";
import type { OrganizerItem } from "@/lib/organizer-items";
import { Badge } from "./Badge";
import styles from "./OrganizerItemCard.module.css";

// One OrganizerItem on Your Daali — Daali Slice 1, S1.6. Product Flow Spec,
// "Organizer item card".
//
// It receives an OrganizerItem and nothing else: no Board type, no query, no
// Board status value. Actions: Manage, and View page (new tab) when there is a
// public URL. No AI shortcut, because no insight is built for any type yet; the
// spec says an unbuilt shortcut is absent, never "Coming soon".
//
// The date is the item's creation date, labelled "Created" (ruled Oct 11:
// boards have no updated_at).

const TYPE_LABEL: Record<OrganizerItem["type"], string> = { FUNDRAISER: "Fundraiser", EVENT: "Event", RAFFLE: "Raffle" };
const STATUS_LABEL: Record<OrganizerItem["status"], string> = { LIVE: "Live", DRAFT: "Draft", CLOSED: "Closed" };
const STATUS_TONE = { LIVE: "live", DRAFT: "draft", CLOSED: "closed" } as const;

const dateFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

function FundraiserIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="M10 16.5s-6-3.6-6-8A3.3 3.3 0 0 1 10 6.4 3.3 3.3 0 0 1 16 8.5c0 4.4-6 8-6 8Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function OrganizerItemCard({ item }: { item: OrganizerItem }) {
  const type = TYPE_LABEL[item.type];
  const status = STATUS_LABEL[item.status];
  const meta = `Created ${dateFormat.format(item.createdAt)}`;

  return (
    <article className={styles.card}>
      <span className={styles.icon}>
        <FundraiserIcon />
      </span>
      <div className={styles.body}>
        <h3 className={styles.title}>{item.title}</h3>
        <div className={styles.chips}>
          <Badge tone="type">{type}</Badge>
          <Badge tone={STATUS_TONE[item.status]}>{status}</Badge>
          <span className={styles.meta}>{meta}</span>
        </div>
        <p className={styles.compactMeta}>
          {type} · {status} · {meta}
        </p>
        <div className={styles.actions}>
          <Link href={item.manageUrl} className={`${styles.action} ${styles.manage}`}>
            Manage
          </Link>
          {item.publicUrl ? (
            <a href={item.publicUrl} target="_blank" rel="noopener noreferrer" className={`${styles.action} ${styles.view}`}>
              View page
            </a>
          ) : null}
        </div>
      </div>
    </article>
  );
}
