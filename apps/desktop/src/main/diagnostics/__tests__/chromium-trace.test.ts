import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ChromiumTrace } from "../chromium-trace";
import { tryAcquireChromiumTrace } from "../chromium-trace-lease";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

let directory: string;
const workerModule = new URL("../chromium-trace-worker.ts", import.meta.url);

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "pwrsnap-test-trace-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

test("native tracing starts only after reservation, and opt-out needs no fresh staging", async () => {
  const allocate = vi.spyOn(fs, "mkdtemp");
  const start = vi.fn(async () => {});
  const stop = vi.fn(async (raw: string) => {
    await writeFile(raw, "private", { mode: 0o600 });
    return raw;
  });
  const trace = new ChromiumTrace(() => ({
    startRecording: start, stopRecording: stop
  }), vi.fn(), { workerModule });
  try {
    allocate.mockRejectedValue(new Error("ENOSPC"));
    await trace.setArmed(true);
    expect(start).not.toHaveBeenCalled();
    const nextOwner = tryAcquireChromiumTrace();
    expect(nextOwner).toBeTypeOf("function");
    nextOwner?.();
    await trace.setArmed(false);

    allocate.mockRestore();
    await trace.setArmed(true);
    expect(start).toHaveBeenCalledOnce();
    vi.spyOn(fs, "mkdtemp").mockRejectedValue(new Error("ENOSPC"));
    await trace.setArmed(false);
    expect(stop).toHaveBeenCalledOnce();
    await expect(fs.stat(stop.mock.calls[0]![0])).rejects.toHaveProperty("code", "ENOENT");
  } finally {
    vi.restoreAllMocks();
    await trace.shutdown(100);
  }
});

test("monotonic eligibility and one native lease govern overlapping triggers even across wall-clock jumps", async () => {
  await fc.assert(fc.asyncProperty(
    fc.integer({ min: 1, max: 50_000 }),
    fc.integer(),
    fc.array(fc.integer(), { minLength: 1, maxLength: 5 }),
    fc.boolean(),
    async (armedAt, wallTime, laterTriggers, profileWritten) => {
      const manualOwner = tryAcquireChromiumTrace()!;
      const frozen = deferred<void>();
      const calls: string[] = [];
      let clock = wallTime;
      const trace = new ChromiumTrace(() => ({
        startRecording: async (config) => {
          expect(config.record_mode).toBe("record-continuously");
          calls.push("start");
        },
        stopRecording: async (raw) => {
          expect(raw.startsWith(directory)).toBe(false);
          calls.push("freeze");
          await writeFile(raw, "synthetic");
          frozen.resolve();
          return raw;
        }
      }), vi.fn(), {
        workerModule,
        wallNow: () => clock,
        monotonicNow: () => armedAt,
        filterTrace: async (_raw, output) => {
          calls.push("filter");
          await writeFile(output, "filtered", { flag: "wx" });
        }
      });
      const artifact = join(directory, "capture.trace.json");
      const profile = deferred<boolean>();
      try {
        trace.setArmed(true);
        expect(trace.hasPendingWork).toBe(false);
        manualOwner();
        await trace.setArmed(true);
        clock -= 60_000;
        expect(await trace.capture(artifact, armedAt, profile.promise, 100)).toEqual({
          status: "skipped", reason: "trigger-predates-recording"
        });
        const first = trace.capture(artifact, armedAt + 1, profile.promise, 100);
        for (const at of laterTriggers) {
          expect(await trace.capture(artifact, at, profile.promise, 100)).toEqual({
            status: "skipped", reason: "not-recording"
          });
          trace.setArmed(true);
        }
        trace.setArmed(false);
        await frozen.promise;
        expect(calls).toEqual(["start", "freeze"]);
        expect(await readdir(directory)).toEqual([]);
        profile.resolve(profileWritten);
        if (profileWritten) {
          expect(await first).toEqual({
            status: "written", recordingStartedAtMs: wallTime, recordingStoppedAtMs: clock, rawBytes: 9
          });
          expect(await readFile(artifact, "utf8")).toBe("filtered");
          expect(calls).toEqual(["start", "freeze", "filter"]);
        } else {
          expect(await first).toEqual({ status: "skipped", reason: "canceled" });
          expect(await readdir(directory)).toEqual([]);
        }
        expect(trace.hasPendingWork).toBe(false);
      } finally {
        profile.resolve(false);
        manualOwner();
        await trace.shutdown(100);
        await rm(artifact, { force: true });
      }
    }
  ), { numRuns: 30 });
});

test("opt-out cancels an in-flight filter without publishing its staged data", async () => {
  const staged = deferred<void>();
  const trace = new ChromiumTrace(() => ({
    startRecording: async () => {},
    stopRecording: async (raw) => {
      await writeFile(raw, "private raw trace");
      return raw;
    }
  }), vi.fn(), {
    workerModule,
    monotonicNow: () => 10,
    filterTrace: async (_raw, output, signal) => {
      await writeFile(output, "filtered");
      staged.resolve();
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    }
  });
  const artifact = join(directory, "capture.trace.json");
  try {
    await trace.setArmed(true);
    const capture = trace.capture(artifact, 11, Promise.resolve(true), 100);
    await staged.promise;
    trace.setArmed(false);
    trace.cancelCapture();
    expect(await capture).toEqual({ status: "skipped", reason: "canceled" });
    expect(await readdir(directory)).toEqual([]);
  } finally {
    await trace.shutdown(100);
  }
});

test("a late native start and flush keep the lease after bounded shutdown until native actually stops", async () => {
  const nativeStart = deferred<void>();
  const entering = deferred<void>();
  const nativeStop = deferred<void>();
  const stopping = deferred<string>();
  const trace = new ChromiumTrace(() => ({
    startRecording: () => {
      entering.resolve();
      return nativeStart.promise;
    },
    stopRecording: async (raw) => {
      stopping.resolve(raw);
      await nativeStop.promise;
      return raw;
    }
  }), vi.fn(), { workerModule, startTimeoutMs: 10, stopTimeoutMs: 10 });

  trace.setArmed(true);
  await entering.promise;
  await trace.shutdown(20);
  expect(trace.hasPendingWork).toBe(false);
  expect(tryAcquireChromiumTrace()).toBeUndefined();
  await stopping.promise;
  nativeStart.resolve();
  expect(tryAcquireChromiumTrace()).toBeUndefined();
  nativeStop.resolve();
  let nextOwner: (() => void) | undefined;
  try {
    await vi.waitFor(() => { nextOwner = tryAcquireChromiumTrace(); expect(nextOwner).toBeTypeOf("function"); });
  } finally {
    nextOwner?.();
  }
});

test("a stalled native flush is bounded and gives neither its scratch export nor a second recorder to the caller", async () => {
  const stopped = deferred<void>();
  const trace = new ChromiumTrace(() => ({
    startRecording: async () => {},
    stopRecording: async (raw) => {
      await stopped.promise;
      return raw;
    }
  }), vi.fn(), { workerModule, monotonicNow: () => 0, stopTimeoutMs: 10 });
  try {
    await trace.setArmed(true);
    const artifact = join(directory, "capture.trace.json");
    expect(await trace.capture(artifact, 1, Promise.resolve(true), 0)).toEqual({ status: "failed" });
    expect(tryAcquireChromiumTrace()).toBeUndefined();
    expect(await readdir(directory)).toEqual([]);
  } finally {
    trace.setArmed(false);
    stopped.resolve();
    await trace.shutdown(100);
  }
});

test("the worker preserves timing and discards oversized private fields, unknown metadata and malformed inputs", async () => {
  const privateText = "synthetic private value " + "★".repeat(256 * 1024);
  const nativeEvent = {
    pid: 2, tid: 3, ts: 42, dur: 7, ph: "X", cat: "devtools.timeline", name: "ResourceSendRequest",
    args: { url: privateText }
  };
  let input = JSON.stringify({
    traceEvents: [
      nativeEvent,
      { ...nativeEvent, cat: "blink.user_timing", name: privateText },
      { ...nativeEvent, ph: "M", name: "thread_name", args: { name: "CrRendererMain", privateText } }
    ],
    metadata: { privateText }
  });
  const warnings = vi.fn();
  const trace = new ChromiumTrace(() => ({
    startRecording: async () => {},
    stopRecording: async (raw) => {
      await writeFile(raw, input);
      return raw;
    }
  }), warnings, { workerModule, monotonicNow: () => 0 });
  const artifact = join(directory, "capture.trace.json");
  async function capture(output: string) {
    await trace.setArmed(true);
    const saved = trace.capture(output, 1, Promise.resolve(true), 100);
    trace.setArmed(false);
    return saved;
  }
  try {
    expect(await capture(artifact)).toMatchObject({ status: "written" });
    const saved = await readFile(artifact, "utf8");
    expect(JSON.parse(saved)).toEqual({
      traceEvents: [
        { pid: 2, tid: 3, cat: "devtools.timeline", name: "ResourceSendRequest", ph: "X", ts: 42, dur: 7 },
        { pid: 2, tid: 3, cat: "blink.user_timing", name: "User timing", ph: "X", ts: 42, dur: 7 },
        { pid: 2, tid: 3, ph: "M", cat: "__metadata", name: "thread_name", args: { name: "CrRendererMain" } }
      ]
    });
    expect(saved).not.toContain("synthetic private value");
    input = input.slice(0, -2);
    expect(await capture(join(directory, "malformed.trace.json"))).toEqual({ status: "failed" });
    expect(await readdir(directory)).toEqual(["capture.trace.json"]);
    expect(warnings.mock.calls.flat().join(" ")).not.toContain("synthetic private value");
  } finally {
    await trace.shutdown(100);
  }
});
