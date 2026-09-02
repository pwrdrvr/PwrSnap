import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../../");

function source(relativePath: string): string {
  return readFileSync(resolve(repoRoot, relativePath), "utf8");
}

describe("interactive capture trigger production wiring", () => {
  test("the gated hotkey helper samples before logging and dispatches the same trigger", () => {
    const main = source("apps/desktop/src/main/index.ts");
    const createIndex = main.indexOf("const trigger = createInteractiveCaptureTrigger(origin)");
    const logIndex = main.indexOf('log.info("global hotkey fired"', createIndex);
    const dispatchIndex = main.indexOf("runInteractiveCapture(mode, trigger)", createIndex);
    expect(createIndex).toBeGreaterThan(-1);
    expect(logIndex).toBeGreaterThan(createIndex);
    expect(dispatchIndex).toBeGreaterThan(logIndex);

    for (const [mode, origin] of [
      ["auto", "global_hotkey.quick_capture"],
      ["region", "global_hotkey.region"],
      ["window", "global_hotkey.window"],
      ["timed", "global_hotkey.timed"]
    ]) {
      expect(main).toMatch(
        new RegExp(
          `triggerInteractiveCaptureFromHotkey\\(\\s*"${mode}",\\s*kind,\\s*"${origin}"\\s*\\)`
        )
      );
    }
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
    expect(mainHelper).toContain("createCaptureInvocationTrigger({");
    expect(mainHelper).toContain("finalizeCaptureInvocation(trigger, monotonicNow)");
    expect(mainHelper).toContain('dispatch("capture:interactive", { mode, invocation }');
    expect(rendererHelper).toContain("createCaptureInvocation({");
    expect(rendererHelper).toContain('dispatch("capture:interactive", { mode, invocation }');

    const handler = source("apps/desktop/src/main/handlers/capture-handlers.ts");
    expect(handler).toContain("if (!isCaptureInvocation(req.invocation))");
    expect(handler).toContain('code: "capture_invocation_required"');
    expect(handler).toContain("latencyTrace: trace");
  });
});
