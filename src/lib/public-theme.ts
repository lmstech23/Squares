// Public-page theming — docs/public-theme-spec.md v3.1.
//
// PURE, AND THAT IS ENFORCED. This module imports nothing from Prisma or from
// any Board module (invariant 7, asserted by public-theme.test.ts). A board
// points at a theme; the theme logic knows nothing about boards. Callers hand
// it plain values.
//
// THE MECHANISM, verified by the browser spike (spec §3.1):
//   - Every token has a DEFAULT in globals.css `@theme` that points at the stock
//     palette, so an unthemed page resolves to exactly today's colours.
//   - The LIGHT surface is a plain `[data-surface="light"]` rule of LITERALS.
//   - The organizer's colour reaches the page only as LITERALS in an inline
//     style on the page's root element, written by `themeStyle`.
//   - Nothing ever writes `var(--color-…)` at runtime. A palette variable no
//     class references is never emitted, and a reference to it renders
//     TRANSPARENT with no error. Invariant 6, asserted by the tests.

import type { CSSProperties } from "react";

export type ThemeSurfaceName = "LIGHT" | "DARK";

/** What a page needs from a stored theme. Structural, so a Prisma row with
 *  extra fields still fits, and this module never names a Prisma type. */
export interface PublicThemeInput {
  primaryColor: string;
  surface: ThemeSurfaceName;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled theme surface: ${JSON.stringify(value)}`);
}

// ---------------------------------------------------------------- LIGHT ----

/**
 * THE LIGHT TABLE — product-owned literals (spec §3.2).
 *
 * Chosen for how each step is actually used, including its opacity, rather
 * than as a strict reversal. Every token that renders as TEXT meets 4.5:1 at
 * its real opacity against every background it sits on: the page surface
 * (tone-950), cards and inputs (tone-900), and its own status panel. Hues are
 * the stock hue of the family they replace.
 *
 * Every token that draws a CONTROL BOUNDARY meets 3:1 against both the page and
 * a card (WCAG 1.4.11): tone-800 is the border on buttons, chips, inputs and
 * steppers; tone-700 is the secondary-button border and the hover step. On
 * LIGHT a fill barely differs from the page, so the border is what makes a
 * control read as a control. Hover still steps darker: 600 < 700 < 800.
 * tone-800 and tone-700 are BORDERS ONLY; the one fill that used tone-800,
 * the progress track, has its own token, tone-track (amendment, Sep 12).
 *
 * MIRRORED as literals into globals.css `[data-surface="light"]`. The test
 * parses that rule and fails if the two ever disagree, so this object is the
 * single source and the CSS is its rendering.
 *
 * Brand tokens are absent on purpose: they come only from `themeStyle`.
 */
export const LIGHT_TABLE = {
  "tone-950": "#FFFFFF",
  "tone-900": "#F3F4F6",
  "tone-800": "#868B96",
  "tone-700": "#757A87",
  "tone-600": "#686E7C",
  "tone-500": "#5B6472",
  "tone-400": "#4B5563",
  "tone-300": "#374151",
  "tone-200": "#1F2937",
  "tone-100": "#111827",
  "tone-fg": "#030712",
  // The progress TRACK — a fill, not a border. Light, so the organizer's fill
  // reads against it; validateTheme holds every accent at 3:1 to it.
  "tone-track": "#E5E7EB",
  "ok-950": "#DCFCE7",
  "ok-900": "#86EFAC",
  "ok-800": "#4ADE80",
  "ok-500": "#16A34A",
  "ok-300": "#147739",
  "ok-200": "#0F4423",
  "ok-100": "#0B3019",
  "bad-950": "#FEE2E2",
  "bad-900": "#FCA5A5",
  "bad-400": "#B91C1C",
  "warn-950": "#FEF9C3",
  "warn-900": "#FDE047",
  "warn-800": "#EAB308",
  "warn-600": "#A16207",
  "warn-200": "#251604",
  "warn-100": "#1A0F03",
  "caution-950": "#FEF3C7",
  "caution-900": "#FCD34D",
  "caution-300": "#833C07",
  "caution-200": "#693006",
} as const;

export type LightToken = keyof typeof LIGHT_TABLE;

/** The DARK page surface — stock gray-950, today's background. */
export const DARK_SURFACE_COLOR = "#030712";

/** The DARK progress track — stock gray-800, as the build emits it. */
export const DARK_TRACK_COLOR = "#1E2939";

/** The colour a theme's accent is measured against (spec §3.4). */
export function surfaceColor(surface: ThemeSurfaceName): string {
  switch (surface) {
    case "LIGHT":
      return LIGHT_TABLE["tone-950"];
    case "DARK":
      return DARK_SURFACE_COLOR;
    default:
      return assertNever(surface);
  }
}

/** The progress track the organizer's fill is drawn over. An accent must
 *  read against it at 3:1, or the bar stops saying how much was raised. */
export function trackColor(surface: ThemeSurfaceName): string {
  switch (surface) {
    case "LIGHT":
      return LIGHT_TABLE["tone-track"];
    case "DARK":
      return DARK_TRACK_COLOR;
    default:
      return assertNever(surface);
  }
}

function surfaceAttribute(surface: ThemeSurfaceName): "light" | "dark" {
  switch (surface) {
    case "LIGHT":
      return "light";
    case "DARK":
      return "dark";
    default:
      return assertNever(surface);
  }
}

// ------------------------------------------------------------- contrast ----

function channels(hex: string): [number, number, number] {
  const h = hex.replace(/^#/, "");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}

function toHex(rgb: readonly number[]): string {
  return (
    "#" +
    rgb
      .map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0"))
      .join("")
      .toUpperCase()
  );
}

/** WCAG 2.x relative luminance of an sRGB hex colour. */
export function relativeLuminance(hex: string): number {
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = channels(hex);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG 2.x contrast ratio, 1–21. */
export function contrastRatio(a: string, b: string): number {
  const x = relativeLuminance(a);
  const y = relativeLuminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** `fg` at `alpha` composited over opaque `bg`, as the browser paints it. */
export function composite(fg: string, alpha: number, bg: string): string {
  const f = channels(fg);
  const g = channels(bg);
  return toHex(f.map((v, i) => alpha * v + (1 - alpha) * g[i]));
}

function darken(hex: string, amount: number): string {
  return toHex(channels(hex).map((v) => v * (1 - amount)));
}

// ------------------------------------------------------------ validation ----

/** Accepts `#RRGGBB` in either case; returns the uppercase form the database
 *  CHECK requires. Anything else throws — a colour is never guessed at. */
export function normalizePrimaryColor(input: string): string {
  const v = input.trim();
  if (!/^#[0-9a-fA-F]{6}$/.test(v)) {
    throw new Error(`primary colour must be #RRGGBB, got ${JSON.stringify(input)}`);
  }
  return v.toUpperCase();
}

export function isThemeSurface(value: string): value is ThemeSurfaceName {
  return value === "LIGHT" || value === "DARK";
}

/** The five brand tokens, all literals, all derived from one colour. */
export interface BrandTokens {
  brand: string;
  brandHover: string;
  onBrand: string;
  brandLine: string;
  brandWash: string;
}

const ON_BRAND_LIGHT = "#FFFFFF";
const ON_BRAND_DARK = "#000000";
const HOVER_STEPS = [0.15, 0.12, 0.09, 0.06, 0.03];

/**
 * Spec §3.2's brand-role table.
 *
 *   brand        primary_color
 *   on-brand     black or white, whichever reads better; always ≥ 4.5:1
 *   brand-hover  primary darkened — the largest step that keeps on-brand ≥ 4.5:1
 *   brand-line   primary_color
 *   brand-wash   primary_color (the class keeps its /20 modifier)
 *
 * Returns null when no hover step keeps on-brand at 4.5:1. That colour is
 * rejected at write rather than rendered with a failing hover.
 */
export function deriveBrandTokens(primaryColor: string): BrandTokens | null {
  const brand = normalizePrimaryColor(primaryColor);
  const onBrand =
    contrastRatio(ON_BRAND_LIGHT, brand) >= contrastRatio(ON_BRAND_DARK, brand)
      ? ON_BRAND_LIGHT
      : ON_BRAND_DARK;
  if (contrastRatio(onBrand, brand) < 4.5) return null;
  const brandHover = HOVER_STEPS.map((k) => darken(brand, k)).find(
    (c) => contrastRatio(onBrand, c) >= 4.5
  );
  if (!brandHover) return null;
  return { brand, brandHover, onBrand, brandLine: brand, brandWash: brand };
}

export type ThemeValidation =
  | {
      ok: true;
      theme: PublicThemeInput;
      tokens: BrandTokens;
      accentContrast: number;
      trackContrast: number;
    }
  | { ok: false; reason: string };

/**
 * The write-time gate (spec §3.4). An accent under 3:1 against its own surface
 * is REJECTED — never silently lightened or darkened into something the
 * organizer did not choose.
 *
 * It must ALSO reach 3:1 against that surface's progress track (amendment,
 * Sep 12): the accent is the bar's fill, and a fill that disappears into its
 * track tells nobody how much was raised. Both surfaces: a light accent fails
 * against LIGHT's pale track, a very dark one against DARK's gray-800 track.
 */
export function validateTheme(input: { primaryColor: string; surface: string }): ThemeValidation {
  if (!isThemeSurface(input.surface)) {
    return { ok: false, reason: `surface must be LIGHT or DARK, got ${JSON.stringify(input.surface)}` };
  }
  let primaryColor: string;
  try {
    primaryColor = normalizePrimaryColor(input.primaryColor);
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
  const accentContrast = contrastRatio(primaryColor, surfaceColor(input.surface));
  if (accentContrast < 3) {
    return {
      ok: false,
      reason:
        `${primaryColor} is ${accentContrast.toFixed(2)}:1 against the ${input.surface} surface; ` +
        `the minimum is 3:1. Choose a colour with more contrast — it is not adjusted automatically.`,
    };
  }
  const trackContrast = contrastRatio(primaryColor, trackColor(input.surface));
  if (trackContrast < 3) {
    return {
      ok: false,
      reason:
        `${primaryColor} is ${trackContrast.toFixed(2)}:1 against the ${input.surface} progress track; ` +
        `the minimum is 3:1, or the bar's fill disappears into its track. Choose a colour with more contrast.`,
    };
  }
  const tokens = deriveBrandTokens(primaryColor);
  if (!tokens) {
    return { ok: false, reason: `${primaryColor} cannot carry readable button text at 4.5:1` };
  }
  return {
    ok: true,
    theme: { primaryColor, surface: input.surface },
    tokens,
    accentContrast,
    trackContrast,
  };
}

// ------------------------------------------------------------ rendering ----

export type ThemeAttributes = {
  "data-surface"?: "light" | "dark";
  style?: CSSProperties;
};

/**
 * What a page's root element receives. Spread it onto the root:
 *
 *   <div className="…" {...themeStyle(theme)}>
 *
 * NULL THEME RETURNS AN EMPTY OBJECT — no data-surface, no style attribute, so
 * the element is byte-for-byte what it was before theming existed (invariant 1).
 *
 * A theme returns the surface attribute and the five brand tokens as LITERAL
 * colours. Never a `var(…)`: invariant 6.
 */
export function themeStyle(theme: PublicThemeInput | null | undefined): ThemeAttributes {
  if (!theme) return {};
  const tokens = deriveBrandTokens(theme.primaryColor);
  if (!tokens) return { "data-surface": surfaceAttribute(theme.surface) };
  return {
    "data-surface": surfaceAttribute(theme.surface),
    style: {
      "--color-brand": tokens.brand,
      "--color-brand-hover": tokens.brandHover,
      "--color-on-brand": tokens.onBrand,
      "--color-brand-line": tokens.brandLine,
      "--color-brand-wash": tokens.brandWash,
    } as CSSProperties,
  };
}

// ---------------------------------------------------- organizer label ----
//
// NOT A THEME FIELD. `boards.public_organizer_label` is board configuration for
// attribution (spec §2.1). It lives in this module only because the module is
// pure and already imported by the fundraiser page; it renders whether or not
// the board has a theme, and clearing the theme never clears it.

export const ORGANIZER_LABEL_MAX = 60;

/**
 * The write rules (spec §2.1), backed by the database CHECK:
 *   trim; an empty result is null; at most 60 CHARACTERS (code points, as
 *   Postgres `char_length` counts them — not bytes, not UTF-16 units); stored
 *   exactly as given otherwise, so `’` (U+2019) is preserved. No normalization.
 */
export function normalizeOrganizerLabel(input: string | null | undefined): string | null {
  if (input == null) return null;
  const trimmed = input.trim();
  if (trimmed === "") return null;
  const length = [...trimmed].length;
  if (length > ORGANIZER_LABEL_MAX) {
    throw new Error(
      `organizer label is ${length} characters; the maximum is ${ORGANIZER_LABEL_MAX}`
    );
  }
  return trimmed;
}

export type Attribution =
  | { kind: "label"; label: string }
  | { kind: "host"; hostName: string }
  | null;

/**
 * The fundraiser attribution slot, in the approved order (spec §9):
 *   1. label present           -> "Organized by {label}"
 *   2. label null, host name   -> today's "hosted by {hostName}" line
 *   3. both null               -> nothing
 * Truthiness, not presence, matches today's `hostName && …` exactly.
 */
export function organizerAttribution(
  label: string | null | undefined,
  hostName: string | null | undefined
): Attribution {
  if (label) return { kind: "label", label };
  if (hostName) return { kind: "host", hostName };
  return null;
}
