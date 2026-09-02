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

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, test, vi } from "vitest";

// window.ts pulls the whole main-process graph in on import; these four mocks
// are the minimum that lets us read the exported constant (same set as
// window-content-protection.test.ts).
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

/** A macOS close/minimize/zoom button is a 14pt frame on a 23pt pitch. */
const BUTTON_SIZE_PT = 14;
const BUTTON_PITCH_PT = 23;
const GROUP_WIDTH_PT = BUTTON_SIZE_PT + 2 * BUTTON_PITCH_PT; // 60

const windowSourcePath = fileURLToPath(new URL("../window.ts", import.meta.url));
const stylesRoot = new URL("../../renderer/src/", import.meta.url);

function readStyle(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, stylesRoot)), "utf8");
}

/** Body of the first `selector { ... }` rule in `css`. Good enough for our own
 *  hand-written stylesheets — they carry no nested at-rules inside these
 *  blocks. */
function ruleBody(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start, `${selector} not found`).toBeGreaterThanOrEqual(0);
  const end = css.indexOf("}", start);
  expect(end, `${selector} block never closes`).toBeGreaterThan(start);
  return css.slice(start, end);
}

function firstGridRowPx(css: string, selector: string): number {
  const match = /grid-template-rows:\s*(\d+)px/.exec(ruleBody(css, selector));
  expect(match, `${selector} has no px grid-template-rows`).not.toBeNull();
  return Number(match![1]);
}

/** `padding: 0 <right>px 0 <left>px` → `{ right, left }`. */
function barPadding(css: string, selector: string): { right: number; left: number } {
  const match = /padding:\s*0\s+(\d+)px\s+0\s+(\d+)px/.exec(ruleBody(css, selector));
  expect(match, `${selector} has no four-value px padding`).not.toBeNull();
  return { right: Number(match![1]), left: Number(match![2]) };
}

/** The four `hiddenInset` surfaces, each as (grid container, its chrome bar). */
const SURFACES = [
  { name: "Library", file: "styles/library.css", container: ".psl", bar: ".psl__topbar" },
  { name: "Settings", file: "styles/settings.css", container: ".pss", bar: ".pss__titlebar" },
  { name: "Sizzle", file: "features/sizzle/sizzle.css", container: ".szl", bar: ".szl__titlebar" },
  { name: "Document", file: "styles/documents.css", container: ".ps-doc", bar: ".ps-doc__titlebar" }
] as const;

/** Content inset of the bars the `x` value is derived from. The document bar
 *  is deliberately excluded — it uses 20px on the right (see below). */
const RAIL_INSET_PX = 16;
/** Left pad every bar reserves for the OS buttons. */
const RESERVED_LEFT_PX = 92;

describe("MACOS_TRAFFIC_LIGHT_POSITION", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  test("is the value the derivation below produces", async () => {
    const { MACOS_TRAFFIC_LIGHT_POSITION } = await import("../window");
    expect(MACOS_TRAFFIC_LIGHT_POSITION).toEqual({ x: 16, y: 18 });
  });

  test("x sits on the same rail as the chrome bars' own content inset", async () => {
    const { MACOS_TRAFFIC_LIGHT_POSITION } = await import("../window");
    // Library / Settings / Sizzle share `padding: 0 16px 0 92px`. The buttons
    // are the leftmost thing in that bar, so they start on that same rail.
    for (const surface of SURFACES.filter((s) => s.name !== "Document")) {
      expect(barPadding(readStyle(surface.file), surface.bar).right, surface.name).toBe(
        RAIL_INSET_PX
      );
    }
    expect(MACOS_TRAFFIC_LIGHT_POSITION.x).toBe(RAIL_INSET_PX);
  });

  test("the 60pt button group still clears every bar's reserved left pad", async () => {
    const { MACOS_TRAFFIC_LIGHT_POSITION } = await import("../window");
    const groupEnd = MACOS_TRAFFIC_LIGHT_POSITION.x + GROUP_WIDTH_PT;
    expect(groupEnd).toBe(76);
    for (const surface of SURFACES) {
      expect(barPadding(readStyle(surface.file), surface.bar).left, surface.name).toBe(
        RESERVED_LEFT_PX
      );
    }
    expect(groupEnd).toBeLessThanOrEqual(RESERVED_LEFT_PX);
  });

  test("y centres the button in the 52pt bar all four surfaces share", async () => {
    const { MACOS_TRAFFIC_LIGHT_POSITION } = await import("../window");
    const heights = SURFACES.map((surface) => ({
      name: surface.name,
      height: firstGridRowPx(readStyle(surface.file), surface.container)
    }));
    // One `y` serves all four windows only because all four bars are the same
    // height. If one diverges, the constant needs a per-surface story.
    for (const { name, height } of heights) expect(height, name).toBe(52);

    const centred = (52 - BUTTON_SIZE_PT) / 2; // 19
    // 18 rather than 19: unchanged from what shipped, and within the 1pt
    // tolerance every other macOS app on the machine sits at.
    expect(Math.abs(MACOS_TRAFFIC_LIGHT_POSITION.y - centred)).toBeLessThanOrEqual(1);
    expect(MACOS_TRAFFIC_LIGHT_POSITION.y).toBe(18);
  });

  test("window.ts carries no second copy of the literal", () => {
    const source = readFileSync(windowSourcePath, "utf8");
    // Exactly one `trafficLightPosition:`, and it names the constant. A future
    // window factory that inlines its own pair is how the two would drift.
    const occurrences = source.match(/trafficLightPosition:/g) ?? [];
    expect(occurrences).toHaveLength(1);
    expect(source).toContain("trafficLightPosition: MACOS_TRAFFIC_LIGHT_POSITION");
  });
});
