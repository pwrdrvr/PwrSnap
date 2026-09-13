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
/** The chrome bar's `border-bottom` — the last pixel of the row is the
 *  divider, not part of the band the buttons sit on. */
const DIVIDER_PX = 1;

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

/**
 * The bar's own content inset, from its base (platform-agnostic) rule:
 * `padding: 0 <inset>px`. The two-value form is load-bearing — the left pad is
 * the inset too, because the base rule reserves nothing for OS chrome. A bar
 * that grows a four-value padding here has put a reservation back on every
 * platform, which is the Linux defect this shape exists to prevent.
 */
function barRailInset(css: string, selector: string): number {
  const body = ruleBody(css, selector);
  const match = /padding:\s*0\s+(\d+)px\s*;/.exec(body);
  if (match === null) {
    throw new Error(
      `\`${selector}\` has no two-value px padding — a base rule that reserves ` +
        "left pad charges Linux for buttons it never draws"
    );
  }
  return Number(match[1]);
}

/**
 * The left pad the macOS-only override reserves for the traffic lights,
 * resolved through the shared token. Scoped to `[data-platform="darwin"]` on
 * purpose: Linux keeps an ordinary OS frame (see platformWindowChrome) and has
 * no in-window buttons to clear, and Windows reserves on the right instead.
 */
function macReservedLeftPx(css: string, selector: string): number {
  const body = ruleBody(css, `:root[data-platform="darwin"] ${selector}`);
  const match = /padding-left:\s*var\(\s*(--[a-z-]+)\s*\)/.exec(body);
  if (match === null) {
    throw new Error(`\`${selector}\` darwin override sets no \`padding-left: var(...)\``);
  }
  const name = match[1];
  if (name !== MAC_RESERVE_TOKEN) {
    throw new Error(`\`${selector}\` reserves via \`${name}\`, not \`${MAC_RESERVE_TOKEN}\``);
  }
  return macReserveTokenPx();
}

const MAC_RESERVE_TOKEN = "--mac-traffic-light-reserve";

/** `--mac-traffic-light-reserve` from tokens.css, in px. */
function macReserveTokenPx(): number {
  const match = new RegExp(`${MAC_RESERVE_TOKEN}:\\s*(\\d+)px`).exec(readStyle("styles/tokens.css"));
  if (match === null) throw new Error(`tokens.css declares no \`${MAC_RESERVE_TOKEN}\``);
  return Number(match[1]);
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
    // Library / Settings / Sizzle share `padding: 0 16px`. The buttons are the
    // leftmost thing in that bar, so they start on that same rail.
    const railBars = BARRED.filter((s) => s.railInset);
    expect(railBars.length).toBeGreaterThan(0);
    for (const surface of railBars) {
      expect(barRailInset(readStyle(surface.file), surface.bar), surface.factory).toBe(
        RAIL_INSET_PX
      );
    }
    expect(MACOS_TRAFFIC_LIGHT_POSITION.x).toBe(RAIL_INSET_PX);
  });

  test("the 60pt button group still clears every bar's reserved left pad", () => {
    const groupEnd = MACOS_TRAFFIC_LIGHT_POSITION.x + GROUP_WIDTH_PT;
    const reserve = macReserveTokenPx();
    for (const surface of BARRED) {
      expect(macReservedLeftPx(readStyle(surface.file), surface.bar), surface.factory).toBe(
        reserve
      );
    }
    expect(groupEnd).toBeLessThanOrEqual(reserve);
  });

  test("only macOS pays the reservation — the base rule reserves nothing", () => {
    // The reservation is for buttons `titleBarStyle: "hiddenInset"` draws
    // INSIDE our bar. Linux takes an ordinary OS frame and Windows puts its
    // caption buttons on the right, so neither has anything to clear on the
    // left. This lived on the base rule until 2026-09 with only a win32
    // opt-out, which spent 92px of every Linux top bar on nothing.
    //
    // `barRailInset` throws on a four-value padding, so the assertion that the
    // base rule is two-value is the assertion that it reserves nothing; this
    // adds the other half — that each bar's left pad comes back on darwin, and
    // through the one shared token rather than a fifth copy of the number.
    for (const surface of BARRED) {
      const css = readStyle(surface.file);
      const base = barRailInset(css, surface.bar);
      expect(macReservedLeftPx(css, surface.bar), surface.factory).toBeGreaterThan(base);
      // A win32 override that still re-states `padding-left` is dead weight
      // now that the base rule carries the rail inset for every platform.
      expect(
        ruleBody(css, `:root[data-platform="win32"] ${surface.bar}`),
        surface.factory
      ).not.toMatch(/padding-left:/);
    }
  });

  test("y centres the button in the band every barred surface shares", () => {
    const heights = BARRED.map((surface) => ({
      factory: surface.factory,
      height: firstGridRowPx(readStyle(surface.file), surface.container)
    }));
    // One `y` serves every barred window only because they are all the same
    // height. If one diverges, the constant needs a per-surface story.
    const [first, ...rest] = heights;
    expect(first).toBeDefined();
    const rowHeight = first!.height;
    for (const { factory, height } of rest) expect(height, factory).toBe(rowHeight);

    // The buttons sit on the FILL, not the row: `box-sizing: border-box` plus a
    // 1px `border-bottom` means the last pixel of the row is the divider.
    for (const surface of BARRED) {
      expect(ruleBody(readStyle(surface.file), surface.bar), surface.factory).toMatch(
        /border-bottom:\s*1px\s+solid/
      );
    }
    const band = rowHeight - DIVIDER_PX;

    // (51 - 14) / 2 = 18.5 — no integer centres exactly, so the constant takes
    // the high side. Smaller y is higher, hence floor. Every macOS app measured
    // for this change sits centred or high; none sits low.
    const centre = (band - BUTTON_SIZE_PT) / 2;
    expect(MACOS_TRAFFIC_LIGHT_POSITION.y).toBe(Math.floor(centre));
    expect(Math.abs(MACOS_TRAFFIC_LIGHT_POSITION.y - centre)).toBeLessThanOrEqual(0.5);
  });

  test("the Windows caption strip pins the same band the stoplights use", () => {
    // titleBarOverlayForTheme() sets `height: 51` for exactly the reason the
    // macOS band is 51 — leave the 1px divider uncovered. They are derived from
    // the same bar, so a bar-height change has to move both in one commit.
    const rowHeight = firstGridRowPx(readStyle(BARRED[0]!.file), BARRED[0]!.container);
    const overlay = /height:\s*(\d+)\s*$/m.exec(
      windowSource.slice(windowSource.indexOf("function titleBarOverlayForTheme"))
    );
    if (overlay === null) throw new Error("titleBarOverlayForTheme declares no height");
    expect(Number(overlay[1])).toBe(rowHeight - DIVIDER_PX);
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
    const occurrences = code.match(/trafficLightPosition:\s*[^,\n]+/g) ?? [];
    expect(occurrences).toHaveLength(1);
    // Must reach the value through the constant, in any form (`: CONST` or a
    // spread copy) — and must carry no inline coordinates of its own.
    expect(occurrences[0]).toContain("MACOS_TRAFFIC_LIGHT_POSITION");
    expect(occurrences[0], "inline x/y literal").not.toMatch(/\d/);
  });
});
