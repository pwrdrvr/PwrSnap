// Every window that goes frameless on Linux must paint its own caption
// buttons, because nothing else will.
//
// `platformWindowChrome()` returns `titleBarStyle: "hidden"` on Linux, which
// IS `frame: false` there. macOS still draws its traffic lights into the strip
// and Windows still fills its `titleBarOverlay`, so on both a window that
// paints nothing of its own can still be moved, minimized and closed. On Linux
// it cannot: a window that forgets `<WindowControls />` opens with no way to
// close it but the keyboard or the task manager.
//
// That is a silent, platform-specific, one-window-at-a-time failure — exactly
// the shape `macos-traffic-light-position.test.ts` guards for the macOS inset,
// and worth the same treatment. The consent window is the reason this is a
// real risk rather than a theoretical one: it has no title bar at all, so it
// needed a chrome strip of its own added in the same change.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const windowSource = readFileSync(fileURLToPath(new URL("../window.ts", import.meta.url)), "utf8");

function renderer(relativePath: string): string {
  return readFileSync(
    fileURLToPath(new URL(relativePath, new URL("../../renderer/src/", import.meta.url))),
    "utf8"
  );
}

/**
 * One entry per `platformWindowChrome()` consumer — the windows that go
 * frameless on Linux — naming the renderer file that paints its strip.
 *
 * Five render a chrome bar. The sixth, the local-agent consent window, renders
 * none: App.tsx gives it a Linux-only fixed strip instead, in the 52px of top
 * padding its layout already reserves.
 */
const FRAMELESS_SURFACES = [
  { factory: "createMainWindow", file: "features/library/Library.tsx" },
  { factory: "createSettingsWindow", file: "features/settings/SettingsTitleBar.tsx" },
  { factory: "createSizzleWindow", file: "features/sizzle/SizzleApp.tsx" },
  { factory: "showAppDocumentWindow", file: "features/documents/AppDocumentWindow.tsx" },
  { factory: "showLogsWindow", file: "features/logs/LogsWindow.tsx" },
  { factory: "createLocalAgentConsentWindow", file: "App.tsx" }
] as const;

describe("Linux caption-button coverage", () => {
  test.each(FRAMELESS_SURFACES.map((s) => [s.factory, s.file] as const))(
    "%s paints caption buttons on Linux (%s)",
    (_factory, file) => {
      const source = renderer(file);
      expect(source).toContain("WindowControls");
      // Gated on Linux, not rendered unconditionally: on macOS and Windows the
      // OS draws these, and a second set would be a duplicate.
      expect(source).toMatch(/platform === "linux"/);
    }
  );

  test("every frameless consumer is classified here", () => {
    // A seventh window spreading platformWindowChrome() inherits framelessness
    // on Linux. Fail here so it gets caption buttons rather than shipping
    // uncloseable.
    const consumers = windowSource.match(/\.\.\.platformWindowChrome\(/g) ?? [];
    expect(consumers).toHaveLength(FRAMELESS_SURFACES.length);
    for (const { factory } of FRAMELESS_SURFACES) {
      expect(windowSource, factory).toContain(`function ${factory}(`);
    }
  });

  test("Linux takes the frameless branch, and takes it alone", () => {
    // `titleBarStyle: "hidden"` is `frame: false` on Linux. If this branch
    // ever returns a framed window again, every WindowControls above becomes a
    // second set of buttons next to the OS's own.
    const linuxBranch = windowSource.slice(windowSource.indexOf("function platformWindowChrome"));
    expect(linuxBranch).toMatch(/process\.platform === "win32"/);
    expect(linuxBranch).toMatch(/process\.platform === "darwin"/);
    // The fall-through — no third platform check, so Linux is what reaches it.
    expect(linuxBranch).toMatch(/return \{ titleBarStyle: "hidden" \};/);
  });
});
