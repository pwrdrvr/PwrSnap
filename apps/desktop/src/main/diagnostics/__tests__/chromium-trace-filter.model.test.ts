import { EventEmitter } from "node:events";
import { access, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { expect, test, vi } from "vitest";
import { ChromiumTrace } from "../chromium-trace";
import type { ChromiumTraceFilterRequest } from "../chromium-trace-worker";

const fork = vi.hoisted(() => vi.fn());
vi.mock("electron", () => ({ utilityProcess: { fork } }));

class FakeUtility extends EventEmitter {
  pid: number | undefined;
  request: ChromiumTraceFilterRequest | undefined;
  killed = false;

  spawn(): void {
    this.pid = 4242;
    this.emit("spawn");
  }

  postMessage(request: ChromiumTraceFilterRequest): void {
    expect(this.pid).toBeDefined();
    expect(this.killed).toBe(false);
    this.request = request;
  }

  kill(): boolean {
    expect(this.pid).toBeDefined();
    expect(this.killed).toBe(false);
    this.killed = true;
    return true;
  }

  exit(): void {
    this.pid = undefined;
    this.emit("exit", this.killed ? 0 : 1);
  }
}

test("a utility owns both staging paths until exit, and only a completed uncanceled filter publishes", async () => {
  await fc.assert(fc.asyncProperty(
    fc.constantFrom("success", "failed", "crashed", "before-spawn", "during-filter", "after-result"),
    fc.nat({ max: 50_000 }),
    async (outcome, cpuMs) => {
      const dir = await mkdtemp(join(tmpdir(), "pwrsnap-filter-model-"));
      const artifact = join(dir, "final.trace.json");
      const child = new FakeUtility();
      fork.mockReset().mockReturnValue(child);
      let rawPath!: string;
      const trace = new ChromiumTrace(() => ({
        startRecording: async () => {},
        stopRecording: async (raw) => {
          rawPath = raw;
          await writeFile(raw, "private synthetic trace");
          return raw;
        }
      }), vi.fn(), { workerModule: "fake-filter-module", monotonicNow: () => 0 });
      try {
        await trace.setArmed(true);
        const capture = trace.capture(artifact, 1, Promise.resolve(true), 100);
        void trace.setArmed(false);
        await vi.waitFor(() => expect(fork).toHaveBeenCalledOnce(), { interval: 1, timeout: 300 });
        if (outcome === "before-spawn") trace.cancelCapture();
        child.spawn();
        if (outcome === "before-spawn") {
          expect(child.request).toBeUndefined();
        } else {
          const request = child.request!;
          expect(request.rawPath).toBe(rawPath);
          await writeFile(request.filteredPath, "synthetic redacted output");
          if (outcome === "failed") child.emit("message", null);
          if (outcome === "success" || outcome === "after-result") child.emit("message", cpuMs);
          if (outcome === "during-filter" || outcome === "after-result") trace.cancelCapture();
        }
        if (outcome !== "crashed") {
          await vi.waitFor(() => expect(child.killed).toBe(true), { interval: 1, timeout: 300 });
        }
        await expect(access(rawPath)).resolves.toBeUndefined();
        await expect(access(artifact)).rejects.toHaveProperty("code", "ENOENT");
        expect(await readdir(dir)).toEqual([expect.stringMatching(/^\.pwrsnap-trace-/u)]);
        child.exit();
        const result = await capture;
        if (outcome === "success") {
          expect(result).toMatchObject({ status: "written", filterCpuMs: cpuMs, filterWallMs: expect.any(Number) });
          expect(await readdir(dir)).toEqual(["final.trace.json"]);
        } else {
          expect(result.status).toBe(outcome === "failed" || outcome === "crashed" ? "failed" : "skipped");
          expect(await readdir(dir)).toEqual([]);
        }
        await expect(access(rawPath)).rejects.toHaveProperty("code", "ENOENT");
      } finally {
        child.exit();
        await trace.shutdown(100);
        await rm(dir, { recursive: true, force: true });
      }
    }
  ), { numRuns: 36 });
});

test("an unacknowledged filter kill bounds failure and holds staging until exit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pwrsnap-filter-timeout-"));
  const child = new FakeUtility();
  fork.mockReset().mockReturnValue(child);
  const rawPaths: string[] = [];
  const trace = new ChromiumTrace(() => ({
    startRecording: async () => {},
    stopRecording: async (raw) => {
      rawPaths.push(raw);
      await writeFile(raw, "private synthetic trace");
      return raw;
    }
  }), vi.fn(), { workerModule: "fake-filter-module", monotonicNow: () => 0, filterTimeoutMs: 100 });
  async function capture(name: string) {
    await trace.setArmed(true);
    const result = trace.capture(join(dir, name), 1, Promise.resolve(true), 0);
    void trace.setArmed(false);
    return result;
  }
  try {
    const first = capture("first.trace.json");
    await vi.waitFor(() => expect(fork).toHaveBeenCalledOnce(), { interval: 1, timeout: 300 });
    child.spawn();
    await writeFile(child.request!.filteredPath, "synthetic partial output");
    expect(await first).toEqual({ status: "failed" });
    expect(child.killed).toBe(true);
    expect(await capture("second.trace.json")).toEqual({ status: "failed" });
    expect(fork).toHaveBeenCalledOnce();
    await expect(access(rawPaths[0]!)).resolves.toBeUndefined();
    await expect(access(child.request!.filteredPath)).resolves.toBeUndefined();
    await expect(access(rawPaths[1]!)).rejects.toHaveProperty("code", "ENOENT");
    child.exit();
    await vi.waitFor(async () => {
      expect(await readdir(dir)).toEqual([]);
      await expect(access(rawPaths[0]!)).rejects.toHaveProperty("code", "ENOENT");
    }, { interval: 1, timeout: 300 });
  } finally {
    child.exit();
    await trace.shutdown(100);
    await rm(dir, { recursive: true, force: true });
  }
});
