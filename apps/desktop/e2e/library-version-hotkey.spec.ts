// E2E coverage for the library window's two startup-dependent labels:
//
//   • Top-bar "Quick Capture · <chord>" button — must reflect whatever
//     accelerator is bound for `settings.hotkeys.quickCapture`, both on
//     the initial settings read AND on a subsequent `settings:write`
//     (the renderer subscribes to `events:settings:changed` and
//     re-renders).
//
//   • Footer `<b>v…</b>` version — must come from `app.getVersion()`
//     (surfaced over the `app:version` bus verb), not the hardcoded
//     "v0.0.1" placeholder we shipped pre-fix.
//
// Both labels regressed silently before because nothing on the way to
// production exercised them — the unit tests for AboutPage covered the
// `app:version` dispatch handler, and `settings.spec.ts` covered the
// settings substrate, but nothing tied the chord/version through the
// real library DOM. This file plugs that gap.

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { launchPwrSnap } from "./fixtures/electron-app";

// Cold start budget — matches settings.spec.ts (each test launches a
// fresh Electron process, and the first launch on a slow Linux CI
// runner can chew through most of the default 30s before the dispatch
// resolves).
test.setTimeout(60_000);

const TOPBAR_QUICK_CAPTURE = ".psl__topbar-r .psl__chip-btn--accent";
const FOOTER_VERSION = ".psl__status-r b";

test("library footer renders the version from app.getVersion()", async () => {
  const app = await launchPwrSnap();
  try {
    // Pull the canonical version straight from Electron's main process
    // so the assertion is self-validating: whatever electron-builder
    // baked into the packaged app's package.json is what the footer
    // must display. Pinning a literal here would couple the test to
    // every release bump.
    const expectedVersion = await app.electronApp.evaluate(
      ({ app: electronApp }) => electronApp.getVersion()
    );
    expect(expectedVersion.length).toBeGreaterThan(0);
    // Belt-and-braces: the bug we just fixed was the footer reading
    // a literal "0.0.1" no matter what. If the real version ever ends
    // up matching that placeholder, the spec stops protecting against
    // the regression — so refuse to run with that combination.
    expect(expectedVersion).not.toBe("0.0.1");

    await expect(app.window.locator(FOOTER_VERSION)).toHaveText(`v${expectedVersion}`);
  } finally {
    await app.close();
  }
});

test("library top bar reads a seeded non-default Quick Capture chord on first paint", async () => {
  // Seed `pwrsnap-settings.json` with a non-default chord BEFORE main
  // boots. `useHotkeys` starts at the EMPTY snapshot and only learns
  // the real value via its initial `settings:read`, so if the renderer
  // ever forgets to dispatch that read (or drops the response), the
  // button never reaches ⌘⌥R and the assertion times out. Seeding on
  // disk also proves the cold-start read path works, separate from the
  // broadcast path that the next test covers.
  const app = await launchPwrSnap({
    seedUserData: async (homeRoot) => {
      await writeFile(
        path.join(homeRoot, "pwrsnap-settings.json"),
        JSON.stringify({
          schemaVersion: 1,
          hotkeys: { quickCapture: "CommandOrControl+Alt+R" }
        }),
        "utf8"
      );
    }
  });
  try {
    await expect(app.window.locator(TOPBAR_QUICK_CAPTURE)).toContainText(
      "Quick Capture · ⌘⌥R"
    );
  } finally {
    await app.close();
  }
});

test("library top bar updates when settings:write changes the Quick Capture hotkey", async () => {
  const app = await launchPwrSnap();
  try {
    // Wait for the renderer to settle on the default before we mutate —
    // otherwise we can race the initial settings read and assert against
    // the patched value before useHotkeys has hydrated once.
    await expect(app.window.locator(TOPBAR_QUICK_CAPTURE)).toContainText(
      "Quick Capture · ⌘⇧C"
    );

    // Pick a chord with three distinct modifiers + a letter so the
    // ordering of the glyphs is meaningful. The `acceleratorToDisplayKeys`
    // helper preserves input order, so this asserts the renderer didn't
    // re-sort modifiers somewhere along the way.
    const writeResult = await app.dispatch("settings:write", {
      hotkeys: { quickCapture: "CommandOrControl+Alt+R" }
    });
    expect(writeResult.ok).toBe(true);

    await expect(app.window.locator(TOPBAR_QUICK_CAPTURE)).toContainText(
      "Quick Capture · ⌘⌥R"
    );
  } finally {
    await app.close();
  }
});

test("library top bar falls back to bare 'Quick Capture' when the hotkey is unbound", async () => {
  const app = await launchPwrSnap();
  try {
    // The Settings → Hotkeys page lets the user unbind a chord, which
    // writes the empty string back. The button should drop the "· ⌘⇧C"
    // tail rather than render a dangling separator.
    const writeResult = await app.dispatch("settings:write", {
      hotkeys: { quickCapture: "" }
    });
    expect(writeResult.ok).toBe(true);

    const button = app.window.locator(TOPBAR_QUICK_CAPTURE);
    // `toHaveText(string)` collapses internal whitespace and trims,
    // so this is an exact text-content match modulo the SVG-adjacent
    // whitespace JSX leaves behind. The negative assertions below
    // belt-and-brace against a regression that puts the chord back
    // with an empty trailing glyph (e.g. "Quick Capture · ").
    await expect(button).toHaveText("Quick Capture");
    await expect(button).not.toContainText("·");
    await expect(button).not.toContainText("⌘");
  } finally {
    await app.close();
  }
});
