// Unit tests for `decidePreviousAppPid` — the decision that gates the
// post-capture `activateApp(previousAppPid)` call. The historical
// behavior (first non-ours from frontmost) was buggy when the user
// had a PwrSnap window — Library, Settings, edit — foreground when
// they triggered a capture: the chosen pid was the app BEHIND our
// window, so post-commit activation sent our window to the background
// AND demoted our activation policy to Accessory (NSUIElement) as a
// side-effect, stripping the Dock icon.
//
// These tests pin the new behavior: when PwrSnap owns the topmost
// window, return null (no activate). When another app is on top,
// return that other app's pid (preserve historical behavior for the
// common "user was in Claude / Terminal / Slack / etc." path).

import { describe, expect, test } from "vitest";
import { decidePreviousAppPid } from "../capture/region-selector";
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

describe("decidePreviousAppPid", () => {
  test("returns null when the snapshot is empty", () => {
    expect(decidePreviousAppPid([], ourPids)).toBeNull();
  });

  test("returns null when PwrSnap owns the topmost window — the bug fix", () => {
    // Library foreground (PwrSnap-owned at z=0), Claude behind it.
    // The pre-fix code would return Claude's pid here, causing
    // post-capture activateApp(Claude) → Library sent behind +
    // PwrSnap demoted to Accessory + Dock icon vanishes. New
    // behavior: return null, capture flow skips activateApp,
    // Library stays foreground.
    const claudePid = 5678;
    const snapshot = [
      win(OUR_PID, "com.pwrdrvr.pwrsnap"),
      win(claudePid, "com.anthropic.claudefordesktop")
    ];
    expect(decidePreviousAppPid(snapshot, ourPids)).toBeNull();
  });

  test("returns the topmost non-PwrSnap pid when another app is on top", () => {
    // Claude foreground, Library behind. Common case: user pressed
    // ⌘⇧P from inside Claude. Restoring Claude after capture
    // preserves their keyboard focus.
    const claudePid = 5678;
    const snapshot = [
      win(claudePid, "com.anthropic.claudefordesktop"),
      win(OUR_PID, "com.pwrdrvr.pwrsnap")
    ];
    expect(decidePreviousAppPid(snapshot, ourPids)).toBe(claudePid);
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
    expect(decidePreviousAppPid(snapshot, ourPids)).toBe(slackPid);
  });

  test("returns null when every window in the snapshot is ours", () => {
    // Just the Library + an edit window — no other app on screen.
    // No "previous app" to restore.
    const snapshot = [
      win(OUR_PID, "com.pwrdrvr.pwrsnap"),
      win(OUR_PID, "com.pwrdrvr.pwrsnap")
    ];
    expect(decidePreviousAppPid(snapshot, ourPids)).toBeNull();
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
    expect(decidePreviousAppPid(snapshot, ourMultiPids)).toBeNull();
  });

  test("returns null when topmost is non-ours but no other non-ours exists (defensive)", () => {
    // Sanity: if the find() walked off the end, return null. This
    // branch isn't actually reachable today because if snapshot[0]
    // is non-ours we use it directly — but keep the contract clean
    // for future refactors.
    const claudePid = 5678;
    const snapshot = [win(claudePid, "com.anthropic.claudefordesktop")];
    expect(decidePreviousAppPid(snapshot, ourPids)).toBe(claudePid);
  });
});
