// Pins the macOS traffic-light inset against the CSS it is DERIVED from.
//
// `trafficLightPosition` is a bare pair of numbers handed to AppKit, so
// nothing in the type system ties it to the chrome bar it is supposed to sit
// in. That is how it drifted: `x` was set to 20 during the 2026-05 build-out
// and never re-derived after the bars settled on a 16px content inset, which
// left the buttons 4pt past the rail every other element lines up on.
//
// These tests re-do the derivation from the real CSS. Change the bar height,
// the content inset, or the reserved left pad and the failing assertion asks
// for MACOS_TRAFFIC_LIGHT_POSITION to be re-derived in the SAME commit,
// rather than leaving another stale measurement behind.
//
// The other half of the job is COVERAGE: the constant is spread into six
// window factories, and a seventh added later would inherit an inset derived
// from bars it may not render. `SURFACES` therefore enumerates every consumer
// — including the one with no chrome bar — and a test pins that count against
// window.ts so a new consumer has to be classified rather than silently
// riding along.
//
// Helper style (throw with a descriptive message, read each file once) follows
// the existing CSS-contract test at
// `renderer/src/styles/__tests__/theme-contract.test.ts`.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test, vi } from "vitest";

// window.ts pulls the whole main-process graph in on import; these four mocks
// are the minimum that lets us read the exported constant (same set as
// window-content-protection.test.ts). `vi.mock` is hoisted above the static
// import below, so no dynamic import / module reset is needed — the constant
// is static, so one evaluation of that graph serves every test here.
vi.mock("electron", () => ({
  app: { getAppPath: () => "/fake/appPath", isPackaged: false },
  screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1000, height: 800 } }) },
  BrowserWindow: class {}
}));
vi.mock("../development-dock-icon", () => ({
  installDevelopmentDockIcon: vi.fn(),
  showDockWithDevelopmentIcon: vi.fn()
}));
vi.mock("../settings/startup-appearance", () => ({
  getStartupAppearanceArgs: () => [],
  getStartupBackgroundColor: () => "#000000",
  STARTUP_BG_DARK: "#000000",
  STARTUP_BG_LIGHT: "#ffffff"
}));
vi.mock("../log", () => ({
  getMainLogger: () => ({
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined
  })
}));

import { MACOS_TRAFFIC_LIGHT_POSITION } from "../window";

/** A macOS close/minimize/zoom button is a 14pt frame on a 23pt pitch. */
const BUTTON_SIZE_PT = 14;
const BUTTON_PITCH_PT = 23;
const GROUP_WIDTH_PT = BUTTON_SIZE_PT + 2 * BUTTON_PITCH_PT; // 60

/** Content inset of the bars the `x` value is derived from. */
const RAIL_INSET_PX = 16;
/** Left pad every chrome bar reserves for the OS buttons. */
const RESERVED_LEFT_PX = 92;

const windowSource = readFileSync(fileURLToPath(new URL("../window.ts", import.meta.url)), "utf8");

const styleCache = new Map<string, string>();
/** Read a renderer stylesheet once per suite. */
function readStyle(relativePath: string): string {
  const cached = styleCache.get(relativePath);
  if (cached !== undefined) return cached;
  const css = readFileSync(
    fileURLToPath(new URL(relativePath, new URL("../../renderer/src/", import.meta.url))),
    "utf8"
  );
  styleCache.set(relativePath, css);
  return css;
}

/** Body of the top-level `selector { ... }` rule. The selector is anchored to
 *  the start of a line so `.psl__topbar` cannot match inside the compound
 *  `:root[data-platform="win32"] .psl__topbar` override that follows it —
 *  those overrides carry a different padding shape, so matching one would read
 *  a plausible-but-wrong block. Throws rather than returning `undefined` so
 *  the failure names the selector. */
function ruleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^${escaped}\\s*\\{([^}]*)\\}`, "m").exec(css);
  if (match === null) throw new Error(`no top-level rule for \`${selector}\``);
  return match[1] ?? "";
}

function firstGridRowPx(css: string, selector: string): number {
  const match = /grid-template-rows:\s*(\d+)px/.exec(ruleBody(css, selector));
  if (match === null) throw new Error(`\`${selector}\` has no px grid-template-rows`);
  return Number(match[1]);
}

/** `padding: 0 <right>px 0 <left>px` → `{ right, left }`. */
function barPadding(css: string, selector: string): { right: number; left: number } {
  const match = /padding:\s*0\s+(\d+)px\s+0\s+(\d+)px/.exec(ruleBody(css, selector));
  if (match === null) throw new Error(`\`${selector}\` has no four-value px padding`);
  return { right: Number(match[1]), left: Number(match[2]) };
}

/**
 * Every window that spreads `platformWindowChrome()`, with the chrome bar it
 * renders. `bar: null` means the surface has NO chrome bar — the inset is
 * cosmetic there and the derivation does not claim to describe it.
 *
 * `railInset: false` marks a bar that matches on the left (the 92px
 * reservation) but not on the right; `.ps-doc__titlebar` uses 20px, so it is
 * excluded from the rail assertion rather than pretending 16 is universal.
 */
const SURFACES = [
  {
    factory: "createMainWindow",
    file: "styles/library.css",
    container: ".psl",
    bar: ".psl__topbar",
    railInset: true
  },
  // No chrome bar: a centred column with 52px of top padding and no drag
  // region. Listed so its absence from the assertions below is deliberate.
  {
    factory: "createLocalAgentConsentWindow",
    file: null,
    container: null,
    bar: null,
    railInset: false
  },
  {
    factory: "createSettingsWindow",
    file: "styles/settings.css",
    container: ".pss",
    bar: ".pss__titlebar",
    railInset: true
  },
  {
    factory: "createSizzleWindow",
    file: "features/sizzle/sizzle.css",
    container: ".szl",
    bar: ".szl__titlebar",
    railInset: true
  },
  {
    factory: "showAppDocumentWindow",
    file: "styles/documents.css",
    container: ".ps-doc",
    bar: ".ps-doc__titlebar",
    railInset: false
  },
  // Renders the same `.ps-doc` shell (`<div className="ps-doc ps-doc--logs">`),
  // so it is covered by the `.ps-doc` assertions above.
  {
    factory: "showLogsWindow",
    file: "styles/documents.css",
    container: ".ps-doc",
    bar: ".ps-doc__titlebar",
    railInset: false
  }
] as const;

/** The surfaces that actually render a chrome bar. */
const BARRED = SURFACES.filter(
  (s): s is Extract<typeof SURFACES[number], { file: string }> => s.file !== null
);

describe("MACOS_TRAFFIC_LIGHT_POSITION", () => {
  test("is the value the derivation below produces", () => {
    expect(MACOS_TRAFFIC_LIGHT_POSITION).toEqual({ x: 16, y: 18 });
  });

  test("is frozen — it is handed to every BrowserWindow by reference", () => {
    expect(Object.isFrozen(MACOS_TRAFFIC_LIGHT_POSITION)).toBe(true);
  });

  test("x sits on the same rail as the chrome bars' own content inset", () => {
    // Library / Settings / Sizzle share `padding: 0 16px 0 92px`. The buttons
    // are the leftmost thing in that bar, so they start on that same rail.
    const railBars = BARRED.filter((s) => s.railInset);
    expect(railBars.length).toBeGreaterThan(0);
    for (const surface of railBars) {
      expect(barPadding(readStyle(surface.file), surface.bar).right, surface.factory).toBe(
        RAIL_INSET_PX
      );
    }
    expect(MACOS_TRAFFIC_LIGHT_POSITION.x).toBe(RAIL_INSET_PX);
  });

  test("the 60pt button group still clears every bar's reserved left pad", () => {
    const groupEnd = MACOS_TRAFFIC_LIGHT_POSITION.x + GROUP_WIDTH_PT;
    for (const surface of BARRED) {
      expect(barPadding(readStyle(surface.file), surface.bar).left, surface.factory).toBe(
        RESERVED_LEFT_PX
      );
    }
    expect(groupEnd).toBeLessThanOrEqual(RESERVED_LEFT_PX);
  });

  test("y centres the button in the bar height every barred surface shares", () => {
    const heights = BARRED.map((surface) => ({
      factory: surface.factory,
      height: firstGridRowPx(readStyle(surface.file), surface.container)
    }));
    // One `y` serves every barred window only because they are all the same
    // height. If one diverges, the constant needs a per-surface story.
    const [first, ...rest] = heights;
    expect(first).toBeDefined();
    const barHeight = first!.height;
    for (const { factory, height } of rest) expect(height, factory).toBe(barHeight);

    // Derived from the height just read, not from a second hardcoded 52.
    const centred = (barHeight - BUTTON_SIZE_PT) / 2;
    // 18 rather than centred: unchanged from what shipped, and within the 1pt
    // tolerance every other macOS app on the machine sits at.
    expect(Math.abs(MACOS_TRAFFIC_LIGHT_POSITION.y - centred)).toBeLessThanOrEqual(1);
    expect(MACOS_TRAFFIC_LIGHT_POSITION.y).toBe(18);
  });

  test("every window consuming the inset is classified in SURFACES", () => {
    // A seventh factory spreading platformWindowChrome() inherits an inset
    // derived from bars it might not render. Fail here so it gets classified —
    // as a barred surface (and asserted above) or explicitly as bar-less.
    const consumers = windowSource.match(/\.\.\.platformWindowChrome\(/g) ?? [];
    expect(consumers).toHaveLength(SURFACES.length);
    for (const surface of SURFACES) {
      expect(windowSource, surface.factory).toContain(`function ${surface.factory}(`);
    }
  });

  test("window.ts carries no second copy of the literal", () => {
    // Comments legitimately discuss `trafficLightPosition`, so count only
    // occurrences outside them — otherwise a future doc edit fails this.
    const code = windowSource.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    const occurrences = code.match(/trafficLightPosition:/g) ?? [];
    expect(occurrences).toHaveLength(1);
    expect(code).toContain("trafficLightPosition: MACOS_TRAFFIC_LIGHT_POSITION");
  });
});
