import { EventEmitter } from "node:events";
import fs, { access, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import fc from "fast-check";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ChromiumTrace } from "../chromium-trace";
import type { ChromiumTraceFilterRequest } from "../chromium-trace-worker";

const fork = vi.hoisted(() => vi.fn());
vi.mock("electron", () => ({ utilityProcess: { fork } }));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

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

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function mockFork(child: FakeUtility) {
  const forked = deferred();
  fork.mockReset().mockImplementation(() => {
    forked.resolve();
    return child;
  });
  return async (capture: ReturnType<ChromiumTrace["capture"]>) => {
    await Promise.race([forked.promise, capture.then(({ status }) => {
      throw new Error(`Capture settled as ${status} before the utility was forked`);
    })]);
    expect(fork).toHaveBeenCalledOnce();
  };
}

test("a utility owns both staging paths until exit, and only a completed uncanceled filter publishes", async () => {
  await fc.assert(fc.asyncProperty(
    fc.constantFrom("success", "failed", "crashed", "before-spawn", "during-filter", "after-result"),
    fc.nat({ max: 50_000 }),
    async (outcome, cpuMs) => {
      const dir = await mkdtemp(join(tmpdir(), "pwrsnap-filter-model-"));
      const artifact = join(dir, "final.trace.json");
      const child = new FakeUtility();
      const waitForFork = mockFork(child);
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
        await waitForFork(capture);
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
          expect(child.killed).toBe(true);
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
  const waitForFork = mockFork(child);
  const rawPaths: string[] = [];
  const rawCleaned = deferred();
  const remove = fs.rm;
  vi.spyOn(fs, "rm").mockImplementation(async (path, options) => {
    await remove(path, options);
    const [first] = rawPaths;
    if (first && path === dirname(first)) rawCleaned.resolve();
  });
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
    await waitForFork(first);
    child.spawn();
    await writeFile(child.request!.filteredPath, "synthetic partial output");
    await vi.advanceTimersByTimeAsync(99);
    expect(child.killed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(child.killed).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await first).toEqual({ status: "failed" });
    expect(await capture("second.trace.json")).toEqual({ status: "failed" });
    expect(fork).toHaveBeenCalledOnce();
    await expect(access(rawPaths[0]!)).resolves.toBeUndefined();
    await expect(access(child.request!.filteredPath)).resolves.toBeUndefined();
    await expect(access(rawPaths[1]!)).rejects.toHaveProperty("code", "ENOENT");
    child.exit();
    await rawCleaned.promise;
    expect(await readdir(dir)).toEqual([]);
    await expect(access(rawPaths[0]!)).rejects.toHaveProperty("code", "ENOENT");
  } finally {
    child.exit();
    await trace.shutdown(100);
    await rm(dir, { recursive: true, force: true });
  }
});
