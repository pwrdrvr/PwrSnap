import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../../");

function source(relativePath: string): string {
  return readFileSync(resolve(repoRoot, relativePath), "utf8");
}

describe("interactive capture trigger production wiring", () => {
  test("every selector-based global hotkey creates the required origin identity", () => {
    const main = source("apps/desktop/src/main/index.ts");
    expect(main).toContain(
      'runInteractiveCapture("auto", "global_hotkey.quick_capture")'
    );
    expect(main).toContain('runInteractiveCapture("region", "global_hotkey.region")');
    expect(main).toContain('runInteractiveCapture("window", "global_hotkey.window")');
    expect(main).toContain('runInteractiveCapture("timed", "global_hotkey.timed")');
  });

  test("Library, tray tiles/buttons, and native tray menu carry distinct origins", () => {
    const library = source(
      "apps/desktop/src/renderer/src/features/library/Library.tsx"
    );
    const trayRenderer = source(
      "apps/desktop/src/renderer/src/features/tray/TrayMenu.tsx"
    );
    const nativeTray = source("apps/desktop/src/main/tray.ts");

    expect(library).toContain(
      'dispatchInteractiveCapture("library.quick_capture", "auto")'
    );
    for (const origin of [
      "tray.quick_capture",
      "tray.region",
      "tray.window",
      "tray.timed"
    ]) {
      expect(trayRenderer).toContain(`"${origin}"`);
    }
    expect(trayRenderer).toContain("dispatchInteractiveCapture(origin, mode)");
    expect(nativeTray).toContain(
      'dispatchInteractiveCapture("native_tray_menu.quick_capture", "auto")'
    );
  });

  test("both process helpers construct the invocation before command dispatch", () => {
    const mainHelper = source("apps/desktop/src/main/capture/capture-trigger.ts");
    const rendererHelper = source("apps/desktop/src/renderer/src/lib/pwrsnap.ts");
    for (const helper of [mainHelper, rendererHelper]) {
      expect(helper).toContain("createCaptureInvocation({");
      expect(helper).toContain('dispatch("capture:interactive", { mode, invocation }');
    }

    const handler = source("apps/desktop/src/main/handlers/capture-handlers.ts");
    expect(handler).toContain("if (!isCaptureInvocation(req.invocation))");
    expect(handler).toContain('code: "capture_invocation_required"');
    expect(handler).toContain("latencyTrace: trace");
  });
});
