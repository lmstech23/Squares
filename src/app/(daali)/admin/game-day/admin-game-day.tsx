"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Badge, type BadgeTone } from "@/components/daali/Badge";
import { Button } from "@/components/daali/Button";
import { Card } from "@/components/daali/Card";
import { PageHeading, Stack, Text } from "@/components/daali/Layout";
import { TextField } from "@/components/daali/TextField";

// The administrator's Game Day controls. INTERIM, pending design review.
// Every button calls an endpoint under /api/admin/game-day, and every one of
// those checks the administrator itself.

type LinkStatus = "unused" | "used" | "expired" | "revoked";
type LinkRow = { id: string; status: LinkStatus; createdAt: string; expiresAt: string; usedAt: string | null; usedBy: string | null };
type Account = { userId: string; label: string };

const TONE: Record<LinkStatus, BadgeTone> = { unused: "live", used: "type", expired: "closed", revoked: "closed" };
const LABEL: Record<LinkStatus, string> = { unused: "Unused", used: "Used", expired: "Expired", revoked: "Revoked" };
const day = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC", timeZoneName: "short" });
const when = (iso: string) => day.format(new Date(iso));

export function AdminGameDay({ links, accounts }: { links: LinkRow[]; accounts: Account[] }) {
  const router = useRouter();
  const [created, setCreated] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function call(url: string) {
    setBusy(true);
    setMessage(null);
    const res = await fetch(url, { method: "POST" });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    setBusy(false);
    return { res, body };
  }

  async function createLink() {
    const { res, body } = await call("/api/admin/game-day/links");
    if (!res.ok) return setMessage("The link was not created.");
    setCreated(`${window.location.origin}${body.path as string}`);
    router.refresh();
  }

  async function revoke(id: string) {
    const { body } = await call(`/api/admin/game-day/links/${id}/revoke`);
    const outcome = body.outcome as string | undefined;
    setMessage(
      outcome === "revoked"
        ? "Link revoked."
        : outcome === "already-used"
          ? "That link was already used, so it can't be revoked as unused."
          : outcome === "already-revoked"
            ? "That link was already revoked."
            : "That link was not found."
    );
    router.refresh();
  }

  async function remove(account: Account) {
    const { body } = await call(`/api/admin/game-day/access/${encodeURIComponent(account.userId)}/remove`);
    setMessage(body.removed ? `Game Day access removed from ${account.label}. Their existing boards are unchanged.` : "No change.");
    router.refresh();
  }

  return (
    <Stack gap={24}>
      <PageHeading eyebrow="Administrator" title="Game Day access" />
      {message ? <Text>{message}</Text> : null}

      <Card title="Create a link" subtitle="One person, one use. It expires after 14 days if unused.">
        <Stack gap={16}>
          {created ? (
            <>
              <TextField label="Copy this link now. It won't be shown again." value={created} readOnly onFocus={(e) => e.currentTarget.select()} />
              <Button variant="secondary" onClick={() => navigator.clipboard?.writeText(created)}>
                Copy link
              </Button>
            </>
          ) : null}
          <Button onClick={createLink} disabled={busy}>
            Create a Game Day link
          </Button>
        </Stack>
      </Card>

      <Card title="Links" subtitle={links.length ? undefined : "No links yet."}>
        {links.length ? (
          <Stack gap={16}>
            {links.map((l) => (
              <div key={l.id} data-link-id={l.id}>
                <Stack gap={8}>
                  <div>
                    <Badge tone={TONE[l.status]}>{LABEL[l.status]}</Badge>
                  </div>
                  <Text size="small" muted>
                    Created {when(l.createdAt)} · expires {when(l.expiresAt)}
                    {l.status === "used" && l.usedAt ? ` · used by ${l.usedBy ?? "an account"} on ${when(l.usedAt)}` : ""}
                  </Text>
                  {l.status === "unused" ? (
                    <div>
                      <Button variant="text" onClick={() => revoke(l.id)} disabled={busy}>
                        Revoke
                      </Button>
                    </div>
                  ) : null}
                </Stack>
              </div>
            ))}
          </Stack>
        ) : null}
      </Card>

      <Card title="Accounts with Game Day" subtitle="Removing access stops new Game Day boards. Existing boards are untouched.">
        {accounts.length ? (
          <Stack gap={8}>
            {accounts.map((a) => (
              <div key={a.userId} data-account-id={a.userId}>
                <Text>{a.label}</Text>
                <Button variant="text" onClick={() => remove(a)} disabled={busy}>
                  Remove access
                </Button>
              </div>
            ))}
          </Stack>
        ) : (
          <Text muted>No accounts have Game Day.</Text>
        )}
      </Card>
    </Stack>
  );
}
