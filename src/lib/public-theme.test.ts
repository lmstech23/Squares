import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  LIGHT_TABLE,
  DARK_SURFACE_COLOR,
  composite,
  contrastRatio,
  deriveBrandTokens,
  normalizeOrganizerLabel,
  normalizePrimaryColor,
  organizerAttribution,
  surfaceColor,
  themeStyle,
  validateTheme,
  type LightToken,
} from "./public-theme.ts";
import { DONATION_PRESETS_CENTS, initialDonationCents } from "./contributions.ts";
import { parseArgs } from "../../scripts/set-board-theme.ts";

// docs/public-theme-spec.md v3.1. Invariant numbers below are that spec's §7.

const ROOT = path.resolve(import.meta.dirname, "../..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) walk(rel, out);
    else if (/\.(ts|tsx|mts|mjs)$/.test(e.name)) out.push(rel.split(path.sep).join("/"));
  }
  return out;
}

// ---------------------------------------------------------------- invariants

describe("invariant 5 — primary_color is referenced only where the spec allows", () => {
  test("no other code file names primaryColor or primary_color", () => {
    const ALLOWED = new Set([
      "src/lib/public-theme.ts",
      "src/lib/public-theme.test.ts",
      "src/app/board/[slug]/page.tsx",
      "src/app/reservation/[id]/page.tsx",
      "src/app/passes/[batch]/page.tsx",
      "scripts/set-board-theme.ts",
    ]);
    const offenders = [...walk("src"), ...walk("scripts")].filter(
      (f) => !ALLOWED.has(f) && /primaryColor|primary_color/.test(read(f))
    );
    assert.deepEqual(offenders, [], "primary_color leaked into a component or other module");
  });

  test("the twelve converted components never mention it", () => {
    for (const f of walk("src/app/board/[slug]").filter((f) => !f.endsWith("page.tsx"))) {
      assert.ok(!/primaryColor/.test(read(f)), f);
    }
  });
});

describe("invariant 6 — no runtime value contains var(--color-…)", () => {
  const SAMPLES = ["#004AAD", "#0B6E4F", "#8A1538", "#1F1F1F", "#7C3AED", "#FFD400", "#00B3E6"];
  for (const surface of ["LIGHT", "DARK"] as const) {
    test(`themeStyle output is literal only (${surface})`, () => {
      for (const primaryColor of SAMPLES) {
        const out = JSON.stringify(themeStyle({ primaryColor, surface }));
        assert.ok(!out.includes("var("), `${primaryColor}/${surface}: ${out}`);
        const style = themeStyle({ primaryColor, surface }).style as Record<string, string> | undefined;
        for (const v of Object.values(style ?? {})) assert.match(v, /^#[0-9A-F]{6}$/);
      }
    });
  }

  test("the LIGHT rule in globals.css holds literals only", () => {
    const rule = lightRule();
    assert.ok(!rule.includes("var("), "LIGHT rule references a palette variable");
  });
});

describe("invariant 7 — public-theme.ts imports nothing from Prisma or Board modules", () => {
  test("its only import is a type from react", () => {
    const src = read("src/lib/public-theme.ts");
    const specifiers = [...src.matchAll(/^\s*import\s[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
    assert.deepEqual(specifiers, ["react"]);
    assert.ok(!/@prisma|prisma|board/i.test(specifiers.join(" ")));
  });
});

describe("invariant 1 — a null theme adds nothing to the root", () => {
  test("themeStyle(null) and themeStyle(undefined) are empty objects", () => {
    assert.deepEqual(themeStyle(null), {});
    assert.deepEqual(themeStyle(undefined), {});
    assert.deepEqual(Object.keys({ ...themeStyle(null) }), []);
  });

  test("a theme adds data-surface and exactly the five brand tokens", () => {
    const t = themeStyle({ primaryColor: "#004AAD", surface: "LIGHT" });
    assert.equal(t["data-surface"], "light");
    assert.deepEqual(Object.keys(t.style ?? {}).sort(), [
      "--color-brand", "--color-brand-hover", "--color-brand-line", "--color-brand-wash", "--color-on-brand",
    ]);
    assert.equal(themeStyle({ primaryColor: "#004AAD", surface: "DARK" })["data-surface"], "dark");
  });
});

// ------------------------------------------------------------- LIGHT table

function lightRule(): string {
  const css = read("src/app/globals.css");
  const m = css.match(/\[data-surface="light"\]\s*\{([^}]*)\}/);
  assert.ok(m, "no [data-surface=\"light\"] rule in globals.css");
  return m[1];
}

describe("LIGHT table — contrast (spec §3.2: text at 4.5:1)", () => {
  const T = (k: LightToken) => LIGHT_TABLE[k];
  const surface = T("tone-950");
  const card = T("tone-900");
  const panel = (fam: "ok" | "bad" | "warn" | "caution", a: number) =>
    composite(T(`${fam}-950` as LightToken), a, surface);

  // [text token, opacity it is actually used at, backgrounds it actually sits on]
  const CHECKS: [LightToken, number, [string, string][]][] = [
    ...(["tone-fg", "tone-100", "tone-200", "tone-300", "tone-400", "tone-500", "tone-600"] as const).map(
      (t) => [t, 1, [["surface", surface], ["card/input", card]]] as [LightToken, number, [string, string][]]
    ),
    ["ok-100", 1, [["surface", surface], ["ok panel", panel("ok", 0.3)]]],
    ["ok-200", 0.8, [["surface", surface], ["ok panel", panel("ok", 0.3)]]],
    ["ok-200", 0.7, [["surface", surface], ["ok panel", panel("ok", 0.3)]]],
    ["ok-300", 1, [["surface", surface], ["early-bird chip", composite(T("ok-500"), 0.15, panel("ok", 0.3))]]],
    ["bad-400", 1, [["surface", surface], ["card", card], ["bad panel", panel("bad", 0.3)]]],
    ["warn-100", 1, [["surface", surface], ["warn panel", panel("warn", 0.3)]]],
    ["warn-200", 1, [["surface", surface], ["warn panel", panel("warn", 0.3)]]],
    ["warn-200", 0.7, [["surface", surface], ["warn panel", panel("warn", 0.3)]]],
    ["warn-200", 0.6, [["surface", surface], ["warn panel", panel("warn", 0.3)]]],
    ["caution-200", 1, [["surface", surface], ["caution panel", panel("caution", 0.2)]]],
    ["caution-300", 0.8, [["surface", surface], ["card", card], ["caution panel", panel("caution", 0.2)]]],
  ];
  for (const [token, alpha, bgs] of CHECKS) {
    test(`${token}${alpha < 1 ? `/${alpha * 100}` : ""} ≥ 4.5:1 on ${bgs.map(([n]) => n).join(", ")}`, () => {
      for (const [name, bg] of bgs) {
        const r = contrastRatio(composite(T(token), alpha, bg), bg);
        assert.ok(r >= 4.5, `${token} on ${name}: ${r.toFixed(2)}:1`);
      }
    });
  }

  test("status-coloured buttons: tone-950 text on ok/warn 200 (rest) and 100 (hover) ≥ 4.5:1", () => {
    for (const bg of ["ok-200", "ok-100", "warn-200", "warn-100"] as const) {
      assert.ok(contrastRatio(T("tone-950"), T(bg)) >= 4.5, bg);
    }
  });

  test("a 100 step is distinct from its 200, so LIGHT hover still changes colour", () => {
    assert.notEqual(T("ok-100"), T("ok-200"));
    assert.notEqual(T("warn-100"), T("warn-200"));
  });

  test("globals.css [data-surface=light] matches LIGHT_TABLE exactly", () => {
    const declared = Object.fromEntries(
      [...lightRule().matchAll(/--color-([a-z]+-(?:\d+|fg)):\s*(#[0-9A-Fa-f]{6});/g)].map((m) => [m[1], m[2]])
    );
    assert.deepEqual(declared, { ...LIGHT_TABLE });
  });

  test("every @theme default points at the stock palette value it replaced", () => {
    const css = read("src/app/globals.css");
    const block = css.slice(css.indexOf("@theme {"));
    const defs = Object.fromEntries(
      [...block.matchAll(/--color-([a-z-]+?(?:-\d+|-fg)?):\s*var\(--color-([a-z]+(?:-\d+)?)\);/g)].map((m) => [m[1], m[2]])
    );
    const STOCK = { tone: "gray", ok: "green", bad: "red", warn: "yellow", caution: "amber" } as const;
    for (const [tok, ref] of Object.entries(defs)) {
      const m = tok.match(/^(tone|ok|bad|warn|caution)-(\d+)$/);
      if (m) assert.equal(ref, `${STOCK[m[1] as keyof typeof STOCK]}-${m[2]}`, tok);
    }
    assert.equal(defs["tone-fg"], "white");
    assert.equal(defs["brand"], "white");
    assert.equal(defs["brand-hover"], "gray-200");
    assert.equal(defs["on-brand"], "gray-950");
    assert.equal(defs["brand-line"], "green-500");
    assert.equal(defs["brand-wash"], "green-950");
    for (const k of Object.keys(LIGHT_TABLE)) assert.ok(k in defs, `${k} has no @theme default`);
  });
});

// ------------------------------------------------------------ validation

describe("theme validation (spec §3.4)", () => {
  test("Hampton Blue #004AAD: 8.13:1 on white, on-brand resolves to white (spec §10)", () => {
    assert.equal(contrastRatio("#004AAD", "#FFFFFF").toFixed(2), "8.13");
    const v = validateTheme({ primaryColor: "#004AAD", surface: "LIGHT" });
    assert.ok(v.ok);
    assert.equal(v.tokens.onBrand, "#FFFFFF");
    assert.ok(contrastRatio(v.tokens.onBrand, v.tokens.brandHover) >= 4.5);
    assert.notEqual(v.tokens.brandHover, v.tokens.brand, "hover must be darkened");
  });

  test("an accent under 3:1 against its surface is rejected, never adjusted", () => {
    const light = validateTheme({ primaryColor: "#FFE14D", surface: "LIGHT" });
    assert.equal(light.ok, false);
    const dark = validateTheme({ primaryColor: "#1A1A2E", surface: "DARK" });
    assert.equal(dark.ok, false);
    assert.ok(contrastRatio("#1A1A2E", DARK_SURFACE_COLOR) < 3);
  });

  test("on-brand is always ≥ 4.5:1 and brand-hover keeps it there", () => {
    for (const c of ["#004AAD", "#FFD400", "#00B3E6", "#7C3AED", "#8A1538"]) {
      const t = deriveBrandTokens(c);
      assert.ok(t, c);
      assert.ok(contrastRatio(t.onBrand, t.brand) >= 4.5, `${c} on-brand`);
      assert.ok(contrastRatio(t.onBrand, t.brandHover) >= 4.5, `${c} hover`);
      assert.equal(t.brandLine, t.brand);
      assert.equal(t.brandWash, t.brand);
    }
  });

  test("a colour no hover step can keep readable is rejected at write, not rendered", () => {
    // #767676: black on-brand is 4.62:1, and every darkening step drops it
    // under 4.5:1. The rule is 'darkened, with on-brand still ≥ 4.5:1', so
    // there is no compliant hover — the write is refused instead.
    assert.equal(deriveBrandTokens("#767676"), null);
    const v = validateTheme({ primaryColor: "#767676", surface: "LIGHT" });
    assert.equal(v.ok, false);
    assert.match(!v.ok ? v.reason : "", /4\.5:1/);
  });

  test("hex is normalized to the uppercase form the CHECK requires; junk is refused", () => {
    assert.equal(normalizePrimaryColor("#004aad"), "#004AAD");
    for (const bad of ["004AAD", "#04A", "#004AAG", "blue", "var(--color-blue-500)"]) {
      assert.throws(() => normalizePrimaryColor(bad), bad);
    }
    assert.equal(validateTheme({ primaryColor: "#004AAD", surface: "light" }).ok, false);
  });

  test("surfaceColor is the page each accent is measured against", () => {
    assert.equal(surfaceColor("LIGHT"), LIGHT_TABLE["tone-950"]);
    assert.equal(surfaceColor("DARK"), DARK_SURFACE_COLOR);
  });
});

// -------------------------------------------------- organizer label (§8)

describe("organizer label — write rules (spec §2.1)", () => {
  test("trims, and an empty result becomes null", () => {
    assert.equal(normalizeOrganizerLabel("  Class of 2013  "), "Class of 2013");
    assert.equal(normalizeOrganizerLabel("\t QT ’13 \n"), "QT ’13");
    assert.equal(normalizeOrganizerLabel(""), null);
    assert.equal(normalizeOrganizerLabel("    "), null);
    assert.equal(normalizeOrganizerLabel(null), null);
    assert.equal(normalizeOrganizerLabel(undefined), null);
  });

  test("60 characters is the limit, counted as characters, not bytes or UTF-16 units", () => {
    assert.equal(normalizeOrganizerLabel("x".repeat(60)), "x".repeat(60));
    assert.throws(() => normalizeOrganizerLabel("x".repeat(61)));
    // 60 characters of U+2019 is 180 UTF-8 bytes — still 60 characters.
    assert.equal(normalizeOrganizerLabel("’".repeat(60))?.length, 60);
    // An astral character is ONE character (one char_length), two UTF-16 units.
    const astral = "🎓".repeat(60);
    assert.equal(astral.length, 120);
    assert.equal(normalizeOrganizerLabel(astral), astral);
    assert.throws(() => normalizeOrganizerLabel("🎓".repeat(61)));
  });

  test("QT ’13 round-trips unchanged — U+2019 preserved, 6 characters", () => {
    const hampton = "QT ’13";
    const out = normalizeOrganizerLabel(hampton);
    assert.equal(out, hampton);
    assert.equal(out?.codePointAt(3), 0x2019);
    assert.equal([...(out ?? "")].length, 6);
    assert.ok(!out?.includes("'"), "must not be flattened to an ASCII apostrophe");
  });
});

describe("organizer label — precedence (spec §9)", () => {
  test("label present -> label, whether or not there is a host name", () => {
    assert.deepEqual(organizerAttribution("QT ’13", "Dana"), { kind: "label", label: "QT ’13" });
    assert.deepEqual(organizerAttribution("QT ’13", null), { kind: "label", label: "QT ’13" });
  });

  test("label null with a host name -> today's hosted-by line", () => {
    assert.deepEqual(organizerAttribution(null, "Dana"), { kind: "host", hostName: "Dana" });
    assert.deepEqual(organizerAttribution(undefined, "Dana"), { kind: "host", hostName: "Dana" });
  });

  test("both null -> nothing, as today", () => {
    assert.equal(organizerAttribution(null, null), null);
    // Truthiness, as today's `hostName && …`: an empty host name renders nothing.
    assert.equal(organizerAttribution(null, ""), null);
  });
});

// --------------------------------------------------- donation default (§5)

describe("donation default (spec §5)", () => {
  test("null -> $25, today's behaviour", () => {
    assert.equal(initialDonationCents(null), 2500);
    assert.equal(initialDonationCents(undefined), 2500);
  });

  test("a preset is used as given", () => {
    for (const p of DONATION_PRESETS_CENTS) assert.equal(initialDonationCents(p), p);
    assert.equal(initialDonationCents(5000), 5000);
  });

  test("a non-preset falls back to $25 — it never preselects Other", () => {
    assert.equal(initialDonationCents(3000), 2500);
    assert.equal(initialDonationCents(0), 2500);
  });

  test("donate-sheet keeps no preset list of its own", () => {
    const src = read("src/app/board/[slug]/donate-sheet.tsx");
    assert.ok(!/\bPRESETS\b/.test(src));
    assert.ok(!/\[1000,\s*2500/.test(src));
  });
});

// ------------------------------------------------------- the write script

describe("scripts/set-board-theme.ts — argument rules", () => {
  test("each field is settable and clearable on its own", () => {
    assert.deepEqual(parseArgs(["b", "--label", "QT ’13"]).label, { kind: "set", value: "QT ’13" });
    assert.deepEqual(parseArgs(["b", "--clear-label"]).label, { kind: "clear" });
    assert.deepEqual(parseArgs(["b", "--donation-default", "5000"]).donationDefault, { kind: "set", value: 5000 });
    assert.deepEqual(parseArgs(["b", "--clear-donation-default"]).donationDefault, { kind: "clear" });
    assert.deepEqual(parseArgs(["b", "--clear-theme"]).theme, { kind: "clear" });
    const p = parseArgs(["b", "--theme", "#004aad", "--surface", "LIGHT"]);
    assert.deepEqual(p.theme, { kind: "set", value: { primaryColor: "#004AAD", surface: "LIGHT" } });
    assert.equal(p.label.kind, "keep");
    assert.equal(p.donationDefault.kind, "keep");
  });

  test("an empty --label is a clear, per the write rules", () => {
    assert.deepEqual(parseArgs(["b", "--label", "   "]).label, { kind: "clear" });
  });

  test("refusals", () => {
    assert.throws(() => parseArgs([]), /slug/);
    assert.throws(() => parseArgs(["b"]), /nothing to do/);
    assert.throws(() => parseArgs(["b", "--theme", "#004AAD"]), /--surface/);
    assert.throws(() => parseArgs(["b", "--theme", "#FFE14D", "--surface", "LIGHT"]), /3:1/);
    assert.throws(() => parseArgs(["b", "--donation-default", "3000"]), /one of/);
    assert.throws(() => parseArgs(["b", "--label", "x".repeat(61)]), /60/);
    assert.throws(() => parseArgs(["b", "--label", "a", "--clear-label"]), /conflict/);
    assert.throws(() => parseArgs(["b", "--theme", "#004AAD", "--surface", "LIGHT", "--clear-theme"]), /conflict/);
    assert.throws(() => parseArgs(["b", "--bogus"]), /unknown/);
  });

  test("dry run is a flag, not a default", () => {
    assert.equal(parseArgs(["b", "--clear-label"]).dryRun, false);
    assert.equal(parseArgs(["b", "--clear-label", "--dry-run"]).dryRun, true);
  });
});
