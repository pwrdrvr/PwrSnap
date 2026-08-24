import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

function between(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

function expectOrdered(source: string, snippets: readonly string[]): void {
  let cursor = -1;
  for (const snippet of snippets) {
    const index = source.indexOf(snippet, cursor + 1);
    expect(index, `missing or out-of-order production call: ${snippet}`).toBeGreaterThan(cursor);
    cursor = index;
  }
}

describe("pre-capture HUD production wiring", () => {
  test("image flow acquires once and hands HUD ownership to selector presentation", () => {
    const source = readFileSync(
      new URL("../handlers/capture-handlers.ts", import.meta.url),
      "utf8"
    );
    const flow = between(
      source,
      'bus.register("capture:interactive"',
      'bus.register("capture:pasteFromClipboard"'
    );

    expectOrdered(flow, [
      'acquireInteractiveCaptureSession("image")',
      'beginPreCaptureHud("snap")',
      "hud.showPermission()",
      "await guardScreenCapture()",
      "hud.showPreparing()",
      "hud.showSelectorHandoff()",
      "await pickRegion(",
      "onSelectorPresented: hud.selectorPresented"
    ]);
    expect(flow).toContain("hud.showStorage()");
    expect(flow).toContain("await ensureCapturesDirReady()");
    expect(flow).toContain("hud.showCountdown");
    expect(flow).toContain("hud.block(\"storage\")");
    expect(flow).toContain("hud.block(\"unexpected\")");
    expect(flow).toContain("finally {\n      hud.finish();");
  });

  test("video interactive flow uses the same boundary without entering recording state ownership", () => {
    const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
    const flow = between(source, "async function runInteractiveRecord(", "/**\n * Protocol resolver");

    expectOrdered(flow, [
      'acquireInteractiveCaptureSession("video")',
      'beginPreCaptureHud("video")',
      "hud.showPermission()",
      "await guardScreenCapture()",
      "hud.showPreparing()",
      "hud.showSelectorHandoff()",
      "await pickRegion(",
      "onSelectorPresented: hud.selectorPresented",
      'bus.dispatch(\n    "recording:start"'
    ]);
    expect(flow).toContain("hud.showStorage()");
    expect(flow).toContain("await ensureCapturesDirReady()");
    expect(flow).toContain("finally {\n    hud.finish();");
    expect(flow).not.toContain("setRecordingState");
    expect(flow).not.toContain("applyRecordingStateToController");
  });

  test("headless capture remains free of human HUD side effects", () => {
    const source = readFileSync(
      new URL("../handlers/capture-handlers.ts", import.meta.url),
      "utf8"
    );
    const headless = between(
      source,
      'bus.register("capture:region"',
      'bus.register("capture:interactive"'
    );
    expect(headless).not.toContain("beginPreCaptureHud");
    expect(headless).not.toContain("showSelectorHandoff");
  });
});
