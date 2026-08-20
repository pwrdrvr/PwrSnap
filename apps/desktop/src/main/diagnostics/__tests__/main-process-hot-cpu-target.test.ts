// Real node:inspector integration: the adapter drives the same CDP
// Profiler domain in-process that the renderer path drives over
// webContents.debugger, so we can exercise an actual
// enable → start → stop round-trip and get a .cpuprofile-shaped result
// without Electron.

import { describe, expect, test } from "vitest";
import { createMainProcessHotCpuTarget } from "../main-process-hot-cpu-target";

describe("createMainProcessHotCpuTarget", () => {
  test("reports the current process pid", () => {
    const target = createMainProcessHotCpuTarget();
    expect(target.getOSProcessId()).toBe(process.pid);
  });

  test("rejects sendCommand when not attached", async () => {
    const target = createMainProcessHotCpuTarget();
    await expect(target.debugger.sendCommand("Profiler.enable")).rejects.toThrow(
      "not attached"
    );
  });

  test("captures a CPU profile of the current process via the Profiler domain", async () => {
    const target = createMainProcessHotCpuTarget();
    expect(target.debugger.isAttached()).toBe(false);

    target.debugger.attach("1.3");
    expect(target.debugger.isAttached()).toBe(true);
    try {
      await target.debugger.sendCommand("Profiler.enable");
      await target.debugger.sendCommand("Profiler.start");

      // Burn a little CPU so the sampling profiler has something to see.
      const until = Date.now() + 30;
      let spin = 0;
      while (Date.now() < until) spin += 1;
      expect(spin).toBeGreaterThan(0);

      const result = (await target.debugger.sendCommand("Profiler.stop")) as {
        profile?: { nodes?: unknown[]; startTime?: number; endTime?: number };
      };
      expect(Array.isArray(result.profile?.nodes)).toBe(true);
      expect(result.profile?.nodes?.length).toBeGreaterThan(0);
      expect(typeof result.profile?.endTime).toBe("number");
    } finally {
      target.debugger.detach();
    }
    expect(target.debugger.isAttached()).toBe(false);
  });

  // Pins the CPU-only posture: v8.writeHeapSnapshot is synchronous, so a
  // main-process heap snapshot would freeze every window, IPC, the tray,
  // and the global hotkeys for the length of the write — up to three
  // times per triggered profile. It would also double the user's
  // configured heapSnapshotLimit, which is counted per profiler.
  test("exposes no heap-snapshot hook, so the profiler never freezes the app", () => {
    const target = createMainProcessHotCpuTarget();
    expect(target.takeHeapSnapshot).toBeUndefined();
  });

  test("attach twice throws until detached", () => {
    const target = createMainProcessHotCpuTarget();
    target.debugger.attach("1.3");
    try {
      expect(() => target.debugger.attach("1.3")).toThrow("already attached");
    } finally {
      target.debugger.detach();
    }
    expect(() => target.debugger.attach("1.3")).not.toThrow();
    target.debugger.detach();
  });
});
