import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { AppShell } from "@/components/daali/AppShell";
import { AvatarMenu } from "@/components/daali/AvatarMenu";
import { Badge } from "@/components/daali/Badge";
import { Button } from "@/components/daali/Button";
import { Card } from "@/components/daali/Card";
import { EmptyState } from "@/components/daali/EmptyState";
import { TextField } from "@/components/daali/TextField";
import g from "./gallery.module.css";

// DEV-ONLY COMPONENT GALLERY — Daali Slice 1, S1.3. For reviewing UI System 1.0
// against the Figma boards; not a product page.
//
// TWO LOCKS. The `.dev.tsx` extension is a page only when next.config.ts adds it
// to pageExtensions, which it does in development alone — so a production build
// has no /dev/ui route at all. And if that ever changed, this page still
// refuses to render in production.

export const metadata: Metadata = {
  title: "UI System 1.0 — dev gallery",
  robots: { index: false, follow: false },
};

const COLORS = [
  ["Canvas", "--daali-canvas", "#F4F0E9"],
  ["Surface", "--daali-surface", "#FFFEFB"],
  ["Ink", "--daali-ink", "#17212B"],
  ["Accent", "--daali-accent", "#A84F35"],
] as const;

const SPACING = [
  [8, "Tight"],
  [16, "Element"],
  [24, "Group"],
  [32, "Card"],
  [48, "Region"],
  [64, "Section"],
] as const;

const RADII = [
  [8, "Small controls"],
  [12, "Inputs"],
  [18, "Cards"],
  [24, "Feature panels"],
] as const;

export default function DevGallery() {
  if (process.env.NODE_ENV === "production") notFound();

  return (
    <AppShell displayName="Daaliyah Tate" breadcrumb="UI system 1.0" legacyBoardsHref="/host/boards">
      <div className={g.intro}>
        <p className={g.eyebrow}>Dev gallery · not in production builds</p>
        <h1 className={g.display}>UI System 1.0</h1>
        <p className={g.lede}>Tokens and the components Slice 1 screens use (D-S1-3).</p>
      </div>

      <div className={g.grid}>
        <Card title="Color foundation" subtitle="Soft neutrals, dark ink, and one restrained warm accent.">
          <div className={g.swatches}>
            {COLORS.map(([name, token, hex]) => (
              <div key={token}>
                <div className={g.swatch} style={{ background: `var(${token})` }} />
                <div className={g.swatchName}>{name}</div>
                <div className={g.swatchHex}>{hex}</div>
              </div>
            ))}
          </div>
        </Card>

        <Card title="Layout & spacing" subtitle="Desktop: 1440 px page, 88 px gutters, 1264 px content. Mobile: 390, 24 px gutters.">
          <div className={g.stack} style={{ gap: 12 }}>
            {SPACING.map(([px, name]) => (
              <div key={px} className={g.spaceRow}>
                <span className={g.spaceBar} style={{ width: px }} />
                <strong>{String(px).padStart(2, "0")}</strong>
                <span className={g.note}>{name}</span>
              </div>
            ))}
          </div>
        </Card>

        <Card title="Heading hierarchy" subtitle="Lora carries warmth; Inter keeps planning clear.">
          <div className={g.stack} style={{ gap: 16 }}>
            <p className={g.h1}>What are you organizing?</p>
            <p className={g.h2}>Your Daali</p>
            <p className={g.h3}>Homecoming Tailgate</p>
            <p className={g.bodyText}>Complete, plain-language guidance for every organizer.</p>
            <p className={g.label}>Section label</p>
          </div>
        </Card>

        <Card title="Buttons & states" subtitle="48 px controls; primary is warm, secondary stays quiet. Hover and focus are interactive.">
          <div className={g.stack} style={{ gap: 16 }}>
            <div className={g.row}>
              <Button>Primary</Button>
              <Button variant="secondary">Secondary</Button>
              <Button variant="text">Text action</Button>
            </div>
            <div className={g.row}>
              <Button disabled>Disabled</Button>
              <Button variant="secondary" href="/dev/ui">
                Link as button
              </Button>
            </div>
            <Button fullWidth>Full-width primary</Button>
          </div>
        </Card>

        <Card title="Form fields" subtitle="Labels remain visible; helper text is optional and concise.">
          <div className={g.stack}>
            <TextField label="What should we call you?" placeholder="e.g., Daaliyah Tate" />
            <TextField label="Email" type="email" placeholder="you@example.com" helper="We'll send a sign-in link here." />
            <TextField
              label="Mobile number"
              type="tel"
              defaultValue="555 01"
              error="Enter a 10-digit US mobile number."
            />
          </div>
        </Card>

        <Card title="Chips, badges & status" subtitle="Pills support scanning without adding dashboard color.">
          <div className={g.row}>
            <Badge tone="type">Fundraiser</Badge>
            <Badge tone="type">Event</Badge>
            <Badge tone="live">Live</Badge>
            <Badge tone="draft">Draft</Badge>
          </div>
        </Card>

        <Card title="Avatar menu" subtitle="D-S1-5: only items with a working destination. Open each to compare.">
          <div className={g.stack} style={{ gap: 12 }}>
            <p className={g.note}>Entitled (legacy_boards_enabled): Legacy Boards and Sign out.</p>
            <div className={g.menuDemo}>
              <AvatarMenu displayName="Daaliyah Tate" legacyBoardsHref="/host/boards" />
            </div>
            <p className={g.note}>Not entitled: Sign out only.</p>
            <div className={g.menuDemo}>
              <AvatarMenu displayName="Jordan Ellis" />
            </div>
            <p className={g.note}>Sign out here is real: it ends the dev session.</p>
          </div>
        </Card>

        <Card title="Empty state" subtitle="Confident guidance without childish illustration.">
          <EmptyState title="Nothing here yet. Your first Daali starts above." body="Keep the next step visible and reassuring." titleAs="h3" />
        </Card>

        <Card className={g.wide} title="Radii" subtitle="8 small controls · 12 inputs · 18 cards · 24 feature panels.">
          <div className={g.radii}>
            {RADII.map(([px, name]) => (
              <div key={px} className={g.radius}>
                <span className={g.radiusSample} style={{ borderRadius: px }} />
                <span>
                  <strong>{px} px</strong>
                  <br />
                  <span className={g.note}>{name}</span>
                </span>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </AppShell>
  );
}
