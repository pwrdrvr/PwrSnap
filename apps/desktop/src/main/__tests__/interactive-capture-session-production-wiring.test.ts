import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

function sourceBetween(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  expect(startIndex, `missing source marker: ${start}`).toBeGreaterThanOrEqual(0);
  expect(endIndex, `missing source marker: ${end}`).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

function occurrences(source: string, needle: string): number {
  return source.split(needle).length - 1;
}

describe("interactive capture session production wiring", () => {
  test("image ownership lives only in the command handler and video ownership only in record", () => {
    const indexSource = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
    const captureHandlerSource = readFileSync(
      new URL("../handlers/capture-handlers.ts", import.meta.url),
      "utf8"
    );
    const recordSelectionSource = readFileSync(
      new URL("../capture/record-selection.ts", import.meta.url),
      "utf8"
    );

    const imageHotkey = sourceBetween(
      indexSource,
      "async function runInteractiveCapture(",
      "/** Full Screen hotkey"
    );
    const video = sourceBetween(
      indexSource,
      "async function runInteractiveRecordAttempt(",
      "const runInteractiveRecord = createInteractiveRecordingSingleFlight({"
    );
    const hotkeyHandlers = sourceBetween(
      indexSource,
      "function handlerFor(kind: HotkeyKind)",
      "/** Apply `settings.hotkeys.*`"
    );
    const videoHotkey = sourceBetween(
      indexSource,
      "function triggerInteractiveRecordFromHotkey(",
      "function handlerFor(kind: HotkeyKind)"
    );
    const imageHandler = sourceBetween(
      captureHandlerSource,
      'bus.register("capture:interactive"',
      'bus.register("capture:pasteFromClipboard"'
    );

    // The hotkey dispatcher delegates image ownership to the command
    // handler. Acquiring here as video would immediately self-suppress when
    // the handler tries to acquire its image lease.
    expect(occurrences(imageHotkey, "acquireInteractiveCaptureSession(")).toBe(0);
    expect(occurrences(imageHotkey, "releaseInteractiveCaptureSession(")).toBe(0);

    expect(occurrences(video, 'acquireInteractiveCaptureSession("video")')).toBe(1);
    expect(occurrences(video, "releaseInteractiveCaptureSession(session.token)")).toBe(1);
    expect(video.indexOf('acquireInteractiveCaptureSession("video")')).toBeLessThan(
      video.indexOf('"recording:preflight"')
    );
    expect(video).not.toContain("new DesktopSettingsService");
    expect(video.indexOf("const settings = cachedRecordingSettings")).toBeLessThan(
      video.indexOf("await pickRegion(")
    );
    const selectionCall = video.indexOf("await pickRegion(");
    expect(selectionCall).toBeGreaterThanOrEqual(0);
    expect(occurrences(video, "startRecordingFromSelection(selection, settings)")).toBe(1);
    expect(selectionCall).toBeLessThan(
      video.indexOf("startRecordingFromSelection(selection, settings)")
    );
    expect(occurrences(video, "withInteractiveSelectionCleanup({")).toBe(0);
    expect(occurrences(recordSelectionSource, "withInteractiveSelectionCleanup({")).toBe(1);
    expect(occurrences(recordSelectionSource, "selectionCleanup.hideSelector()")).toBe(1);
    expect(occurrences(recordSelectionSource, "selectionCleanup.releaseSnapshot()")).toBe(1);
    expect(recordSelectionSource.indexOf('setFloatOverState({ kind: "cancel" })')).toBeLessThan(
      recordSelectionSource.indexOf("selectionCleanup.hideSelector()")
    );
    expect(recordSelectionSource.indexOf("selectionCleanup.hideSelector()")).toBeLessThan(
      recordSelectionSource.indexOf('bus.dispatch(\n      "recording:start"')
    );
    const darwinStorageGate = video.indexOf('if (process.platform === "darwin")');
    expect(darwinStorageGate).toBeGreaterThanOrEqual(0);
    expect(
      video.indexOf("await ensureCapturesDirReady()", darwinStorageGate)
    ).toBeLessThan(selectionCall);
    const videoBusyBranch = sourceBetween(
      video,
      'if (session.status === "busy")',
      "try {"
    );
    expect(videoBusyBranch).toContain("return;");
    expect(videoBusyBranch).not.toContain("hideSelector");

    expect(occurrences(imageHandler, 'acquireInteractiveCaptureSession("image")')).toBe(1);
    expect(occurrences(imageHandler, "releaseInteractiveCaptureSession(session.token)")).toBe(1);
    expect(imageHandler.indexOf('acquireInteractiveCaptureSession("image")')).toBeLessThan(
      imageHandler.indexOf("guardScreenCapture()")
    );
    const imageBusyBranch = sourceBetween(
      imageHandler,
      'if (session.status === "busy")',
      "// Claim synchronously"
    );
    expect(imageBusyBranch).toContain("capture_in_progress");
    expect(imageBusyBranch).not.toContain("hideSelector");

    // Every image-picker hotkey goes through the synchronous leading-edge
    // debounce. A future direct call from one switch arm would reintroduce
    // the observed Windows key-repeat triple dispatch.
    for (const mode of ["auto", "region", "window", "timed"] as const) {
      expect(
        occurrences(hotkeyHandlers, `triggerInteractiveCaptureFromHotkey("${mode}", kind)`)
      ).toBe(1);
    }
    expect(occurrences(hotkeyHandlers, "triggerInteractiveRecordFromHotkey(kind)")).toBe(1);
    expect(occurrences(hotkeyHandlers, "runInteractiveCapture(")).toBe(0);
    expect(occurrences(hotkeyHandlers, "runInteractiveRecord(")).toBe(0);
    expect(occurrences(videoHotkey, "interactiveCaptureTriggerGate.acquire()")).toBe(1);
    expect(occurrences(videoHotkey, "interactiveCaptureTriggerGate.release(decision.token)")).toBe(
      1
    );
  });
});
