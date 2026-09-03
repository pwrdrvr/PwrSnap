// Unit tests for `decidePreviousApp` — the decision that gates the
// post-capture app-restoration call. The historical
// behavior (first non-ours from frontmost) was buggy when the user
// had a PwrSnap window — Library, Settings, edit — foreground when
// they triggered a capture: the chosen pid was the app BEHIND our
// window, so post-commit activation sent our window to the background
// AND demoted our activation policy to Accessory (NSUIElement) as a
// side-effect, stripping the Dock icon.
//
// These tests pin an explicit tri-state. `unknown` means enumeration
// supplied no evidence; `pwrsnap` means our window was known frontmost;
// `external` carries the pid that is safe to reactivate. Callers must
// never interpret an ambiguous null as proof that PwrSnap was frontmost.

import { describe, expect, test } from "vitest";
import { decidePreviousApp } from "../capture/region-selector";
import type { WindowInfo } from "../capture/window-list";

function win(pid: number, bundleId: string | null = null): WindowInfo {
  return {
    windowId: pid * 10,
    pid,
    bundleId,
    appName: bundleId !== null ? (bundleId.split(".").pop() ?? null) : null,
    title: null,
    bounds: { x: 0, y: 0, width: 800, height: 600 },
    layer: 0,
    alpha: 1,
    isFrontmostInApp: true
  };
}

const OUR_PID = 1234;
const ourPids = new Set<number>([OUR_PID]);

describe("decidePreviousApp", () => {
  test("reports unknown when the snapshot is empty", () => {
    expect(decidePreviousApp([], ourPids)).toEqual({
      previousAppOrigin: "unknown",
      previousAppPid: null
    });
  });

  test("reports pwrsnap when PwrSnap owns the topmost window — the bug fix", () => {
    // Library foreground (PwrSnap-owned at z=0), Claude behind it.
    // The pre-fix code would return Claude's pid here, causing
    // post-capture activateApp(Claude) → Library sent behind +
    // PwrSnap demoted to Accessory + Dock icon vanishes. New
    // behavior: explicit pwrsnap origin, capture flow skips activateApp,
    // Library stays foreground.
    const claudePid = 5678;
    const snapshot = [
      win(OUR_PID, "com.pwrdrvr.pwrsnap"),
      win(claudePid, "com.anthropic.claudefordesktop")
    ];
    expect(decidePreviousApp(snapshot, ourPids)).toEqual({
      previousAppOrigin: "pwrsnap",
      previousAppPid: null
    });
  });

  test("reports external with the topmost non-PwrSnap pid when another app is on top", () => {
    // Claude foreground, Library behind. Common case: user pressed
    // ⌘⇧P from inside Claude. Restoring Claude after capture
    // preserves their keyboard focus.
    const claudePid = 5678;
    const snapshot = [
      win(claudePid, "com.anthropic.claudefordesktop"),
      win(OUR_PID, "com.pwrdrvr.pwrsnap")
    ];
    expect(decidePreviousApp(snapshot, ourPids)).toEqual({
      previousAppOrigin: "external",
      previousAppPid: claudePid
    });
  });

  test("walks past lower-z PwrSnap windows to find another app", () => {
    // Pathological but possible: top is another app, then a PwrSnap
    // window, then yet another app. We still want to restore the
    // topmost non-PwrSnap (Slack), not the one beneath our window.
    const slackPid = 7777;
    const finderPid = 8888;
    const snapshot = [
      win(slackPid, "com.tinyspeck.slackmacgap"),
      win(OUR_PID, "com.pwrdrvr.pwrsnap"),
      win(finderPid, "com.apple.finder")
    ];
    expect(decidePreviousApp(snapshot, ourPids)).toEqual({
      previousAppOrigin: "external",
      previousAppPid: slackPid
    });
  });

  test("reports pwrsnap when every window in the snapshot is ours", () => {
    // Just the Library + an edit window — no other app on screen.
    // No "previous app" to restore.
    const snapshot = [
      win(OUR_PID, "com.pwrdrvr.pwrsnap"),
      win(OUR_PID, "com.pwrdrvr.pwrsnap")
    ];
    expect(decidePreviousApp(snapshot, ourPids)).toEqual({
      previousAppOrigin: "pwrsnap",
      previousAppPid: null
    });
  });

  test("handles ourPids as a set with multiple PwrSnap-owned pids", () => {
    // Defensive — selfPidSet() currently returns just the main pid,
    // but renderer-process pids could be added later. The decision
    // should respect every pid in the set.
    const ourMultiPids = new Set<number>([1234, 1235, 1236]);
    const claudePid = 5678;
    const snapshot = [
      win(1235, "com.pwrdrvr.pwrsnap"),
      win(claudePid, "com.anthropic.claudefordesktop")
    ];
    expect(decidePreviousApp(snapshot, ourMultiPids)).toEqual({
      previousAppOrigin: "pwrsnap",
      previousAppPid: null
    });
  });

  test("reports the sole non-PwrSnap window as external", () => {
    const claudePid = 5678;
    const snapshot = [win(claudePid, "com.anthropic.claudefordesktop")];
    expect(decidePreviousApp(snapshot, ourPids)).toEqual({
      previousAppOrigin: "external",
      previousAppPid: claudePid
    });
  });
});
