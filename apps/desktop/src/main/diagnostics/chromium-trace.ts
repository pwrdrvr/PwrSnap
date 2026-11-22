// One app-wide rolling Chromium trace, shared by the eligible CPU targets.
import { addAbortListener } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import type { TraceConfig } from "electron";
import { onChromiumTraceReleased, tryAcquireChromiumTrace } from "./chromium-trace-lease";

const TRACE_CATEGORIES = ["devtools.timeline", "blink.user_timing", "cc", "viz"];
const TRACE_BUFFER_KB = 32 * 1024;
// A full native 32 MiB ring has exported 135 MiB of JSON in PwrGit.
const MAX_RAW_TRACE_BYTES = 288 * 1024 * 1024;
const START_TIMEOUT_MS = 1_000;
const STOP_TIMEOUT_MS = 4_000;
const FILTER_TIMEOUT_MS = 15_000;
const PROFILE_SETTLEMENT_GRACE_MS = 15_000;
const RETRY_MS = 5_000;
const CANCELED = new Error("Chromium trace canceled");

// Electron passes the dictionary to Chromium, which reads record_mode.
// Electron's recording_mode type does not select the actual rolling mode.
type RollingConfig = Omit<TraceConfig, "recording_mode"> & { record_mode: "record-continuously" };
type TraceBackend = {
  stopRecording: (privatePath: string) => Promise<string>;
  startRecording: (config: RollingConfig) => Promise<void>;
};

type NativeTrace = {
  backend: TraceBackend;
  release: () => void;
};

type Recording = NativeTrace & { wallMs: number; monotonicMs: number };
type CaptureResult =
  | { status: "written"; recordingStartedAtMs: number; recordingStoppedAtMs: number; rawBytes: number }
  | { status: "skipped"; reason: "not-recording" | "trigger-predates-recording" | "canceled" }
  | { status: "failed" };

type Options = {
  workerModule: string | URL;
  wallNow?: () => number;
  monotonicNow?: () => number;
  startTimeoutMs?: number;
  stopTimeoutMs?: number;
  filterTimeoutMs?: number;
  filterTrace?: (rawPath: string, filteredPath: string, signal: AbortSignal) => Promise<void>;
};

async function withDeadline<T>(operation: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: ReturnType<typeof addAbortListener> | undefined;
  try {
    signal?.throwIfAborted();
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        if (signal) onAbort = addAbortListener(signal, () => reject(signal.reason));
        timer = setTimeout(() => reject(new Error("Chromium trace operation timed out")), timeoutMs);
      })
    ]);
  } finally {
    onAbort?.[Symbol.dispose]();
    clearTimeout(timer);
  }
}

export class ChromiumTrace {
  private desired = false;
  private recording: Recording | null = null;
  private transition: Promise<void> | null = null;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private readonly quit = new AbortController();
  private shuttingDown = false;
  private captureJob: { controller: AbortController; done: Promise<CaptureResult> } | null = null;
  private readonly unlisten = onChromiumTraceReleased(() => this.reconcile());

  constructor(
    private readonly backend: () => TraceBackend,
    private readonly warn: (message: string) => void,
    private readonly options: Options
  ) {}

  get hasPendingWork(): boolean {
    return this.recording !== null || this.transition !== null || this.captureJob !== null;
  }

  setArmed(desired: boolean): Promise<void> {
    this.desired = desired && !this.shuttingDown;
    if (!this.desired) {
      clearTimeout(this.retry);
      this.retry = undefined;
    }
    this.reconcile();
    return this.transition ?? Promise.resolve();
  }

  cancelCapture(): void {
    this.captureJob?.controller.abort(CANCELED);
  }

  async shutdown(budgetMs: number): Promise<void> {
    this.shuttingDown = true;
    this.unlisten();
    const timer = setTimeout(() => this.quit.abort(CANCELED), Math.max(0, budgetMs));
    try {
      await this.setArmed(false);
      await this.captureJob?.done;
      await this.transition;
    } finally {
      clearTimeout(timer);
    }
  }

  capture(filePath: string, triggerMonotonicMs: number, profileWritten: Promise<boolean>, durationMs: number): Promise<CaptureResult> {
    const recording = this.recording;
    if (!this.desired || !recording || this.captureJob) {
      return Promise.resolve({ status: "skipped", reason: "not-recording" });
    }
    if (triggerMonotonicMs <= recording.monotonicMs) {
      return Promise.resolve({ status: "skipped", reason: "trigger-predates-recording" });
    }
    // Reserve at detection, before any sample/heap writes or overlapping triggers.
    this.recording = null;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, this.quit.signal]);
    const recordingStoppedAtMs = this.options.wallNow?.() ?? Date.now();
    const done = this.export(recording, filePath, profileWritten, durationMs, recordingStoppedAtMs, signal)
      .finally(() => {
        this.captureJob = null;
        this.reconcile();
      });
    this.captureJob = { controller, done };
    return done;
  }

  private reconcile(): void {
    if (this.transition || this.captureJob || (this.desired === (this.recording !== null))) return;
    let operation: Promise<void>;
    if (this.desired) {
      if (this.retry) return;
      const release = tryAcquireChromiumTrace();
      if (!release) return;
      operation = this.start({ backend: this.backend(), release });
    } else {
      const recording = this.recording!;
      this.recording = null;
      operation = this.discard(recording);
    }
    this.transition = operation.finally(() => {
      this.transition = null;
      this.reconcile();
    });
  }

  private async start(native: NativeTrace): Promise<void> {
    let startSettled = false;
    const start = Promise.resolve().then(() => native.backend.startRecording({
      record_mode: "record-continuously",
      trace_buffer_size_in_kb: TRACE_BUFFER_KB,
      included_categories: [...TRACE_CATEGORIES],
      excluded_categories: ["*"]
    })).finally(() => { startSettled = true; });
    try {
      await withDeadline(start, this.options.startTimeoutMs ?? START_TIMEOUT_MS, this.quit.signal);
      this.recording = {
        ...native,
        wallMs: this.options.wallNow?.() ?? Date.now(),
        monotonicMs: this.options.monotonicNow?.() ?? performance.now()
      };
    } catch {
      this.warn("Could not arm Chromium trace");
      if (this.desired) {
        this.retry = setTimeout(() => {
          this.retry = undefined;
          this.reconcile();
        }, RETRY_MS).unref();
      }
      if (startSettled) {
        void start.then(() => this.discard(native), native.release);
      } else {
        // Ask Chromium to stop even if start never acknowledges. Keep the
        // lease until both operations settle. A late start can require a
        // second stop if the first ran before Chromium started recording.
        const discard = this.discard({ ...native, release: () => {} }, false);
        void Promise.allSettled([start, discard]).then(([started]) => {
          if (started.status === "fulfilled") return this.discard(native);
          native.release();
        });
      }
    }
  }

  private async discard(native: NativeTrace, bounded = true): Promise<void> {
    try {
      const frozen = await this.freeze(native, bounded);
      await frozen.cleanup();
    } catch {
      this.warn("Could not discard Chromium trace");
    }
  }

  private async export(
    recording: Recording, filePath: string, profileWritten: Promise<boolean>,
    durationMs: number, recordingStoppedAtMs: number, signal: AbortSignal
  ): Promise<CaptureResult> {
    try {
      const frozen = await this.freeze(recording);
      try {
        signal.throwIfAborted();
        const { size: rawBytes } = await fs.stat(frozen.rawPath);
        if (rawBytes > MAX_RAW_TRACE_BYTES) {
          this.warn(`Chromium trace exceeded its export size limit (${rawBytes}/${MAX_RAW_TRACE_BYTES} bytes)`);
          return { status: "failed" };
        }
        const waitMs = Math.min(durationMs + PROFILE_SETTLEMENT_GRACE_MS, 2_147_483_647);
        if (!await withDeadline(profileWritten, waitMs, signal)) {
          return { status: "skipped", reason: "canceled" };
        }
        await this.publish(frozen.rawPath, filePath, signal);
        return { status: "written", recordingStartedAtMs: recording.wallMs, recordingStoppedAtMs, rawBytes };
      } finally {
        await frozen.cleanup();
      }
    } catch {
      if (signal.aborted) return { status: "skipped", reason: "canceled" };
      // Native and parser errors can contain private input.
      this.warn("Could not save Chromium trace");
      return { status: "failed" };
    }
  }

  private async freeze(native: NativeTrace, bounded = true): Promise<{ rawPath: string; cleanup: () => Promise<void> }> {
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "pwrsnap-chromium-trace-"));
    const rawPath = path.join(scratch, "trace.json");
    const cleanup = async () => {
      await fs.rm(scratch, { recursive: true, force: true }).catch(() => {
        this.warn("Could not remove private Chromium trace staging");
      });
    };
    const stop = Promise.resolve().then(() => native.backend.stopRecording(rawPath));
    // After a timeout no later recorder can start until native stop settles.
    void stop.then(native.release, (error: unknown) => {
      // A rejected stop may leave native tracing live. Only a confirmed
      // idle backend can safely release ownership in that case.
      if (error instanceof Error && error.message === "Failed to stop tracing - no trace in progress") {
        native.release();
      }
    });
    try {
      if (bounded) {
        await withDeadline(stop, this.options.stopTimeoutMs ?? STOP_TIMEOUT_MS, this.quit.signal);
      } else {
        await stop;
      }
      return { rawPath, cleanup };
    } catch (error) {
      await cleanup();
      void stop.then(cleanup, cleanup);
      throw error;
    }
  }

  private async publish(rawPath: string, filePath: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    // Keep the partial export on the destination filesystem for atomic rename.
    const staging = await fs.mkdtemp(path.join(path.dirname(filePath), ".pwrsnap-trace-"));
    const filteredPath = path.join(staging, "filtered.json");
    try {
      if (this.options.filterTrace) {
        await withDeadline(
          this.options.filterTrace(rawPath, filteredPath, signal),
          this.options.filterTimeoutMs ?? FILTER_TIMEOUT_MS, signal
        );
      } else {
        await this.filterInWorker(rawPath, filteredPath, signal);
      }
      signal.throwIfAborted();
      await fs.rename(filteredPath, filePath);
      if (signal.aborted) {
        await fs.rm(filePath, { force: true });
        signal.throwIfAborted();
      }
    } finally {
      await fs.rm(staging, { recursive: true, force: true }).catch(() => {
        this.warn("Could not remove filtered Chromium trace staging");
      });
    }
  }

  private async filterInWorker(rawPath: string, filteredPath: string, signal: AbortSignal): Promise<void> {
    const module = this.options.workerModule;
    // The standalone worker lives in app.asar. Electron's fs can read that
    // asset even where Node's worker module loader cannot resolve its path.
    const entry = typeof module === "string"
      ? new URL(`data:text/javascript;base64,${await fs.readFile(module, "base64")}`)
      : module;
    signal.throwIfAborted();
    const worker = new Worker(entry, {
      workerData: { rawPath, filteredPath, allowedCategories: TRACE_CATEGORIES },
      resourceLimits: { maxOldGenerationSizeMb: 96 }
    });
    try {
      await withDeadline(new Promise<void>((resolve, reject) => {
        worker.once("error", reject);
        worker.once("exit", (code) => {
          if (code === 0) resolve();
          else reject(new Error("Chromium trace filter failed"));
        });
      }), this.options.filterTimeoutMs ?? FILTER_TIMEOUT_MS, signal);
    } finally {
      await worker.terminate();
    }
  }
}
