#!/usr/bin/env node
// scripts/set-board-theme.ts — docs/public-theme-spec.md v3.1 §2, §2.1, §5, §6.
//
// Sets, independently, a fundraiser board's public THEME, its Donate Only
// DEFAULT, and its ORGANIZER LABEL. There is no host settings UI in v1; this is
// the only writer of those three fields.
//
//   DATABASE_URL=… node --experimental-strip-types scripts/set-board-theme.ts <slug> [options]
//
//   --theme <#RRGGBB> --surface <LIGHT|DARK>   create a theme and point the board at it
//   --clear-theme                              board.theme_id = null (the theme row is kept)
//   --donation-default <cents>                 one of the Donate Only presets
//   --clear-donation-default                   back to today's $25
//   --label <text>                             trimmed; empty is null; at most 60 characters
//   --clear-label
//   --dry-run                                  read and print the plan; write nothing
//
// Each field is set or cleared on its own. Clearing the theme never touches
// the label or the default, and vice versa (spec §2.1, §8 Rollback).
//
// ROLLBACK NEVER DELETES A THEME. `--clear-theme` only nulls boards.theme_id;
// the FK is ON DELETE RESTRICT precisely so a theme a board still points at
// cannot vanish underneath it (spec §2).
//
// DATABASE_URL MUST BE SET EXPLICITLY. Plain node does not read .env, which is
// deliberate: this script must be pointed at a database on purpose. The target
// is printed before anything else, and the connection string never is.

import { pathToFileURL } from "node:url";
import { prisma } from "../src/lib/prisma.ts";
import { DONATION_PRESETS_CENTS } from "../src/lib/contributions.ts";
import { deriveProjectRef } from "../src/lib/db-target.ts";
import {
  normalizeOrganizerLabel,
  validateTheme,
  type BrandTokens,
  type PublicThemeInput,
} from "../src/lib/public-theme.ts";

type Change<T> = { kind: "keep" } | { kind: "set"; value: T } | { kind: "clear" };

interface Plan {
  slug: string;
  dryRun: boolean;
  theme: Change<PublicThemeInput>;
  donationDefault: Change<number>;
  label: Change<string>;
}

class Refusal extends Error {}

function refuse(message: string): never {
  throw new Refusal(message);
}

/** Argument parsing. Every field is validated HERE, before any database read,
 *  so a bad value never gets as far as a connection. */
export function parseArgs(argv: string[]): Plan {
  const args = [...argv];
  const slug = args.shift();
  if (!slug || slug.startsWith("--")) refuse("the first argument must be a board slug");

  const flags = new Map<string, string | true>();
  const valued = new Set(["--theme", "--surface", "--donation-default", "--label"]);
  const bare = new Set(["--clear-theme", "--clear-donation-default", "--clear-label", "--dry-run"]);
  while (args.length) {
    const a = args.shift()!;
    if (flags.has(a)) refuse(`${a} given twice`);
    if (valued.has(a)) {
      if (!args.length) refuse(`${a} needs a value`);
      flags.set(a, args.shift()!);
    } else if (bare.has(a)) {
      flags.set(a, true);
    } else {
      refuse(`unknown argument ${JSON.stringify(a)}`);
    }
  }

  const plan: Plan = {
    slug,
    dryRun: flags.has("--dry-run"),
    theme: { kind: "keep" },
    donationDefault: { kind: "keep" },
    label: { kind: "keep" },
  };

  // THEME
  if (flags.has("--theme") && flags.has("--clear-theme")) refuse("--theme and --clear-theme conflict");
  if (flags.has("--surface") && !flags.has("--theme")) refuse("--surface only makes sense with --theme");
  if (flags.has("--theme")) {
    // No silent surface default: the database's DEFAULT 'DARK' exists for the
    // column, not as a guess about what an organizer wanted.
    if (!flags.has("--surface")) refuse("--theme requires --surface LIGHT or DARK");
    const v = validateTheme({
      primaryColor: String(flags.get("--theme")),
      surface: String(flags.get("--surface")),
    });
    if (!v.ok) refuse(v.reason);
    plan.theme = { kind: "set", value: v.theme };
  } else if (flags.has("--clear-theme")) {
    plan.theme = { kind: "clear" };
  }

  // DONATION DEFAULT — null or a preset (spec §5). The check lives here, in
  // code, so the preset list stays the single source in contributions.ts.
  if (flags.has("--donation-default") && flags.has("--clear-donation-default")) {
    refuse("--donation-default and --clear-donation-default conflict");
  }
  if (flags.has("--donation-default")) {
    const raw = String(flags.get("--donation-default"));
    const cents = /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (!DONATION_PRESETS_CENTS.includes(cents)) {
      refuse(`--donation-default must be one of ${DONATION_PRESETS_CENTS.join(", ")} (cents); got ${raw}`);
    }
    plan.donationDefault = { kind: "set", value: cents };
  } else if (flags.has("--clear-donation-default")) {
    plan.donationDefault = { kind: "clear" };
  }

  // LABEL — trim, empty is null, 60 characters (spec §2.1).
  if (flags.has("--label") && flags.has("--clear-label")) refuse("--label and --clear-label conflict");
  if (flags.has("--label")) {
    let normalized: string | null;
    try {
      normalized = normalizeOrganizerLabel(String(flags.get("--label")));
    } catch (e) {
      refuse((e as Error).message);
    }
    plan.label = normalized === null ? { kind: "clear" } : { kind: "set", value: normalized };
  } else if (flags.has("--clear-label")) {
    plan.label = { kind: "clear" };
  }

  if (plan.theme.kind === "keep" && plan.donationDefault.kind === "keep" && plan.label.kind === "keep") {
    refuse("nothing to do: give at least one of --theme, --clear-theme, --donation-default, " +
      "--clear-donation-default, --label, --clear-label");
  }
  return plan;
}

function describeTarget(url: string): string {
  const ref = deriveProjectRef(url);
  if (ref) return `Supabase project ${ref}`;
  try {
    const u = new URL(url);
    return `${u.hostname}${u.port ? ":" + u.port : ""}${u.pathname}`;
  } catch {
    return "(unparseable DATABASE_URL)";
  }
}

const show = (v: unknown) => (v === null || v === undefined ? "null" : JSON.stringify(v));

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) refuse("DATABASE_URL is not set. It is read from the environment only, never from .env.");
  const plan = parseArgs(process.argv.slice(2));

  console.log(`target     ${describeTarget(url)}`);
  console.log(`board      ${plan.slug}${plan.dryRun ? "   (DRY RUN — nothing will be written)" : ""}`);

  const board = await prisma.board.findUnique({
    where: { slug: plan.slug },
    select: {
      boardId: true,
      boardType: true,
      themeId: true,
      donationDefaultCents: true,
      publicOrganizerLabel: true,
      host: { select: { id: true, supabaseUserId: true } },
    },
  });
  if (!board) refuse(`no board with slug ${JSON.stringify(plan.slug)}`);

  // Theming is a fundraiser-page capability (spec §1). A theme on a Game Day
  // board would be stored and never rendered, which reads as a bug later.
  if (board.boardType !== "fundraiser") refuse(`${plan.slug} is a ${board.boardType} board, not a fundraiser`);

  // THE NULL-UID GUARD (spec §2). public_themes.organizer_user_id is NOT NULL
  // and means hosts.supabase_user_id; a host without one has no organizer
  // identity to record, so nothing is written for them at all.
  const organizerUserId = board.host.supabaseUserId;
  if (!organizerUserId) refuse(`host ${board.host.id} has no supabase_user_id; refusing to write`);

  const current = board.themeId
    ? await prisma.publicTheme.findUnique({
        where: { themeId: board.themeId },
        select: { themeId: true, primaryColor: true, surface: true },
      })
    : null;

  console.log("\ncurrent");
  console.log(`  theme              ${current ? `${current.primaryColor} ${current.surface} (${current.themeId})` : "null"}`);
  console.log(`  donation default   ${show(board.donationDefaultCents)}`);
  console.log(`  organizer label    ${show(board.publicOrganizerLabel)}`);

  let tokens: BrandTokens | null = null;
  console.log("\nplan");
  switch (plan.theme.kind) {
    case "set": {
      const v = validateTheme(plan.theme.value);
      if (!v.ok) refuse(v.reason);
      tokens = v.tokens;
      console.log(`  theme              NEW ${v.theme.primaryColor} ${v.theme.surface} ` +
        `(accent ${v.accentContrast.toFixed(2)}:1 on its surface; organizer ${organizerUserId})`);
      console.log(`                     brand ${tokens.brand}  hover ${tokens.brandHover}  on-brand ${tokens.onBrand}`);
      break;
    }
    case "clear":
      console.log("  theme              -> null (the theme row is kept)");
      break;
    case "keep":
      console.log("  theme              unchanged");
  }
  console.log(`  donation default   ${plan.donationDefault.kind === "set" ? `-> ${plan.donationDefault.value}` : plan.donationDefault.kind === "clear" ? "-> null" : "unchanged"}`);
  console.log(`  organizer label    ${plan.label.kind === "set" ? `-> ${JSON.stringify(plan.label.value)} (${[...plan.label.value].length} characters)` : plan.label.kind === "clear" ? "-> null" : "unchanged"}`);

  if (plan.dryRun) {
    console.log("\nDRY RUN — nothing written.");
    return;
  }

  await prisma.$transaction(async (tx) => {
    const data: { themeId?: string | null; donationDefaultCents?: number | null; publicOrganizerLabel?: string | null } = {};
    if (plan.theme.kind === "set") {
      const created = await tx.publicTheme.create({
        data: {
          organizerUserId,
          primaryColor: plan.theme.value.primaryColor,
          surface: plan.theme.value.surface,
        },
        select: { themeId: true },
      });
      data.themeId = created.themeId;
    } else if (plan.theme.kind === "clear") {
      data.themeId = null;
    }
    if (plan.donationDefault.kind !== "keep") {
      data.donationDefaultCents = plan.donationDefault.kind === "set" ? plan.donationDefault.value : null;
    }
    if (plan.label.kind !== "keep") {
      data.publicOrganizerLabel = plan.label.kind === "set" ? plan.label.value : null;
    }
    await tx.board.update({ where: { boardId: board.boardId }, data });
  });

  const after = await prisma.board.findUnique({
    where: { boardId: board.boardId },
    select: { themeId: true, donationDefaultCents: true, publicOrganizerLabel: true },
  });
  console.log("\nwritten");
  console.log(`  theme_id              ${show(after?.themeId)}`);
  console.log(`  donation_default      ${show(after?.donationDefaultCents)}`);
  console.log(`  public_organizer_label ${show(after?.publicOrganizerLabel)}`);
}

// Run only when executed directly, so the tests can import parseArgs.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .catch((e) => {
      console.error(e instanceof Refusal ? `\nREFUSED — ${e.message}\n` : e);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
