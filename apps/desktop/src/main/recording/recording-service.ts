// Main-process recording service. Wraps the `PwrSnapRecorder` Swift
// binary (apps/desktop/native/recorder/main.swift) over stdin/stdout
// JSON-RPC and exposes a typed start/stop/cancel API to the rest of
// main. Single active session per process; concurrent starts throw
// `already_recording` for the command-bus handler to surface as a
// typed validation error.
//
// On platforms without the native helper (Linux CI, dev tests) the
// service can be substituted with `setRecordingService(stubRecordingService())`
// from a test harness so the rest of the command-bus + UI plumbing
// can be exercised end-to-end without macOS.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app, Notification, screen } from "electron";
import { nanoid } from "nanoid";
import type {
  RecordingCapabilities,
  RecordingFailureCode,
  RecordingSubject
} from "@pwrsnap/shared";
import { getMainLogger } from "../log";
import { setFloatOverState } from "../float-over";
import { broadcastCapturesChanged } from "../events";
import { maybeEnqueueCaptureEnrichment } from "../handlers/codex-handlers";
import { runWithCapturesDirFallback } from "../capture/capture-storage-gate";
import { getCaptureById, insertCapture } from "../persistence/captures-repo";
import {
  adoptExistingFileAsSource,
  statSource
} from "../persistence/source-store";
import { insertVideoMetadata } from "../persistence/video-repo";
import { renameVideoSourceToEffectiveFilename } from "../persistence/video-filename-maintenance";
import { getRecordingControllerPid } from "./recording-controller";
import {
  getRecordingState,
  isRecordingActive,
  setRecordingFailureState,
  setRecordingState
} from "./recording-state";
import { resolveFfmpegPath } from "./ffmpeg-resolver";

const log = getMainLogger("pwrsnap:recording-service");

export type StartOptions = {
  subject: RecordingSubject;
  capabilities: RecordingCapabilities;
  countdownSeconds: number;
  /** Whether the recording bakes in the mouse cursor. Omitted = the
   *  native recorder's default (`showsCursor ?? true`). `| undefined`
   *  is explicit so restart() can forward a possibly-unset snapshot
   *  under exactOptionalPropertyTypes. */
  captureCursor?: boolean | undefined;
};

export type RecordingService = {
  start(opts: StartOptions): Promise<{ sessionId: string }>;
  stop(): Promise<{ captureId: string }>;
  cancel(): Promise<void>;
  /** App-owned teardown that also retries cleanup of a terminal failure whose
   * recorder ignored the first bounded termination barrier. */
  shutdown(): Promise<void>;
  /** Discard the in-flight session and immediately start a fresh
   *  one with the same subject + capabilities. Throws
   *  `not_recording` if no session is active. */
  restart(): Promise<{ sessionId: string }>;
  /** Retry a matching terminal failure with the original request snapshot. */
  retry(sessionId: string): Promise<{ sessionId: string }>;
  /** Dismiss a matching terminal failure without touching a newer session. */
  dismissFailure(sessionId: string): Promise<void>;
  /** True when this service has an active session. Used by the
   *  app-quit hook to cancel before exit. */
  isActive(): boolean;
};

let activeService: RecordingService | null = null;

function snapshotStartOptions(opts: StartOptions): StartOptions {
  return {
    subject: {
      ...opts.subject,
      ...(opts.subject.kind !== "display" ? { rect: { ...opts.subject.rect } } : {})
    } as RecordingSubject,
    capabilities: { ...opts.capabilities },
    countdownSeconds: opts.countdownSeconds,
    captureCursor: opts.captureCursor
  };
}

function failureDetail(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function publishRecordingFailure(input: {
  sessionId: string;
  code: RecordingFailureCode;
  displayId: number;
  cause: unknown;
  canRetry?: boolean;
}): void {
  // Raw process detail belongs only in the local durable log. The state event
  // carries an allowlisted code, so stderr, argv, and paths never cross IPC.
  log.error("recording lifecycle failed", {
    sessionId: input.sessionId,
    code: input.code,
    message: failureDetail(input.cause)
  });
  setRecordingFailureState({
    sessionId: input.sessionId,
    code: input.code,
    displayId: input.displayId,
    canRetry: input.canRetry ?? true
  });
}

function matchingFailedSession(sessionId: string): boolean {
  const state = getRecordingState();
  return state.phase === "failed" && state.sessionId === sessionId;
}

function matchingRetryableFailedSession(sessionId: string): boolean {
  const state = getRecordingState();
  return state.phase === "failed" && state.sessionId === sessionId && state.canRetry;
}

function recordingStateBelongsTo(sessionId: string): boolean {
  const state = getRecordingState();
  return "sessionId" in state && state.sessionId === sessionId;
}

async function waitWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutValue: () => T | never
): Promise<T> {
  let handle: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve, reject) => {
        handle = setTimeout(() => {
          try {
            resolve(timeoutValue());
          } catch (cause) {
            reject(cause);
          }
        }, timeoutMs);
      })
    ]);
  } finally {
    if (handle !== null) clearTimeout(handle);
  }
}

const RECORDER_TERM_GRACE_MS = 500;
const RECORDER_KILL_GRACE_MS = 500;
const recorderTerminationTasks = new WeakMap<
  ChildProcessWithoutNullStreams,
  Promise<boolean>
>();

function childHasExited(child: ChildProcessWithoutNullStreams): boolean {
  return (
    child.exitCode !== null && child.exitCode !== undefined
  ) || (
    child.signalCode !== null && child.signalCode !== undefined
  );
}

async function terminateRecorderProcessOnce(
  child: ChildProcessWithoutNullStreams
): Promise<boolean> {
  if (childHasExited(child)) return true;

  let onExit: (() => void) | null = null;
  const exitPromise = new Promise<boolean>((resolve) => {
    onExit = () => resolve(true);
    child.once("exit", onExit);
    child.once("close", onExit);
  });
  const waitForExit = async (timeoutMs: number): Promise<boolean> => {
    if (childHasExited(child)) return true;
    return await waitWithTimeout(exitPromise, timeoutMs, () => false);
  };

  try {
    try {
      child.kill("SIGTERM");
    } catch {
      /* process may already be gone; the bounded exit wait decides */
    }
    if (await waitForExit(RECORDER_TERM_GRACE_MS)) return true;

    try {
      child.kill("SIGKILL");
    } catch {
      /* process may already be gone; the bounded exit wait decides */
    }
    const exited = await waitForExit(RECORDER_KILL_GRACE_MS);
    if (!exited) {
      log.warn("recorder process did not exit after forced termination");
    }
    return exited;
  } finally {
    if (onExit !== null) {
      child.removeListener("exit", onExit);
      child.removeListener("close", onExit);
    }
  }
}

function terminateRecorderProcess(
  child: ChildProcessWithoutNullStreams | null
): Promise<boolean> {
  if (child === null) return Promise.resolve(true);
  const existing = recorderTerminationTasks.get(child);
  if (existing !== undefined) return existing;
  // Defer the body one microtask so the WeakMap entry exists before a mocked
  // or unusual ChildProcess implementation can synchronously re-enter through
  // an exit listener while handling kill().
  const task = Promise.resolve()
    .then(() => terminateRecorderProcessOnce(child))
    .finally(() => {
      // Only deduplicate an in-flight termination attempt. A process that did
      // not exit must be eligible for another bounded attempt from Dismiss or
      // app shutdown instead of permanently reusing a settled `false` result.
      recorderTerminationTasks.delete(child);
    });
  recorderTerminationTasks.set(child, task);
  return task;
}

type PendingSessionFailure = {
  cause: unknown;
  completion: Promise<void>;
};

type CountdownDelay = {
  sessionId: string;
  handle: ReturnType<typeof setTimeout>;
  resolve: () => void;
};

/** Resolve the `PwrSnapRecorder` binary. Mirrors the lookup pattern
 *  used by `apps/desktop/src/main/capture/window-list.ts` — production
 *  finds it under `Contents/Resources/`; dev under the `build/native/`
 *  output dir. Returns null on Linux / non-darwin or if the binary
 *  hasn't been built yet (build-native.mjs no-ops outside macOS). */
function resolveRecorderBinary(): string | null {
  if (process.platform !== "darwin") return null;
  const candidates: string[] = [];
  candidates.push(join(process.resourcesPath, "PwrSnapRecorder"));
  candidates.push(join(__dirname, "..", "..", "build", "native", "recorder"));
  try {
    candidates.push(join(app.getAppPath(), "build", "native", "recorder"));
  } catch {
    /* `app.getAppPath` requires app.whenReady on some platforms — best-effort */
  }
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

type RecorderStartedEvent = {
  event: "started";
  physicalRect: { x: number; y: number; w: number; h: number };
};
type RecorderStoppedEvent = {
  event: "stopped";
  durationSec: number;
  containerFormat: "mp4" | "mov";
  hasSystemAudio: boolean;
  hasMicrophoneAudio: boolean;
  outputPath: string;
};
type RecorderErrorEvent = { event: "error"; code: string; message: string };
type RecorderEvent = RecorderStartedEvent | RecorderStoppedEvent | RecorderErrorEvent;

/**
 * Real recorder backed by the Swift binary. Single session lifetime
 * is enforced via `isActive()` checks; the binary itself exits after
 * `stopped` so re-using a single recorder process across sessions is
 * not supported (and not necessary — the spawn cost is dominated by
 * the first-time TCC handshake, not by the binary launch).
 */
class NativeRecorderService implements RecordingService {
  private child: ChildProcessWithoutNullStreams | null = null;
  private sessionId: string | null = null;
  private subject: RecordingSubject | null = null;
  private capabilities: RecordingCapabilities | null = null;
  /** Snapshotted alongside subject/capabilities so restart() can
   *  preserve the cursor choice across the cancel→start round-trip.
   *  `undefined` lets the recorder apply its own default. */
  private captureCursor: boolean | undefined = undefined;
  private outputPath: string | null = null;
  private startedPromise: Promise<void> | null = null;
  private stoppedPromise: Promise<RecorderStoppedEvent> | null = null;
  private startResolve: (() => void) | null = null;
  private startReject: ((err: Error) => void) | null = null;
  private stopResolve: ((evt: RecorderStoppedEvent) => void) | null = null;
  private stopReject: ((err: Error) => void) | null = null;
  private inboundBuffer = "";
  private stopRequested = false;
  private retryOptions: StartOptions | null = null;
  private readonly startingSessions = new Set<string>();
  private readonly pendingFailures = new Map<string, PendingSessionFailure>();
  private readonly cancellingSessions = new Set<string>();
  private countdownDelay: CountdownDelay | null = null;
  /** Resolves after stopping/processing reaches ready or failed. App shutdown
   * and stale close/cancel actions join this instead of invalidating durable
   * source adoption or metadata persistence. */
  private finalizationSettled: Promise<void> | null = null;

  isActive(): boolean {
    return this.sessionId !== null;
  }

  async start(opts: StartOptions): Promise<{ sessionId: string }> {
    if (isRecordingActive() || this.sessionId !== null || this.child !== null) {
      throw new Error("already_recording");
    }
    const sessionId = nanoid(12);
    const options = snapshotStartOptions(opts);
    const displayId = subjectDisplayId(options.subject);
    const physicalRect = subjectToPhysicalRect(options.subject);

    // Claim the session and publish an active phase before the first await.
    // This is the serialization point for direct starts, Retry, Dismiss, and
    // app quit: no second request can slip through while mkdtemp is pending.
    this.retryOptions = options;
    this.sessionId = sessionId;
    this.subject = options.subject;
    this.capabilities = options.capabilities;
    this.captureCursor = options.captureCursor;
    this.outputPath = null;
    this.child = null;
    this.startedPromise = null;
    this.stoppedPromise = null;
    this.startResolve = null;
    this.startReject = null;
    this.stopResolve = null;
    this.stopReject = null;
    this.inboundBuffer = "";
    this.stopRequested = false;
    this.startingSessions.add(sessionId);
    setRecordingState({ phase: "preflight", sessionId, rect: physicalRect, displayId });

    try {
      const binary = resolveRecorderBinary();
      if (binary === null) {
        const cause = new Error("native recorder binary is unavailable");
        await this.publishSessionFailure(
          sessionId,
          "recorder_unavailable",
          cause,
          displayId
        );
        throw cause;
      }
      // Log the binary path + mtime + size on every spawn so we can
      // tell from a user's session log whether they're running a
      // fresh or stale Swift recorder. `pnpm dev` only rebuilds Swift
      // on startup; HMR doesn't watch .swift files, so a TS-side fix
      // can ship without the matching Swift fix taking effect until
      // the dev server restarts. Surfacing the mtime here makes that
      // mismatch trivially diagnosable.
      try {
        const s = statSync(binary);
        log.info("recorder binary", {
          path: binary,
          mtime: s.mtime.toISOString(),
          sizeBytes: s.size
        });
      } catch {
        /* stat is informational; ignore failures */
      }
      let tmpDir: string;
      try {
        tmpDir = await mkdtemp(join(tmpdir(), "pwrsnap-recording-"));
      } catch (cause) {
        await this.assertSessionRunnable(sessionId);
        await this.publishSessionFailure(
          sessionId,
          "recorder_prepare_failed",
          cause,
          displayId
        );
        throw cause;
      }
      await this.assertSessionRunnable(sessionId);
      const outputPath = join(tmpDir, `${sessionId}.mp4`);
      this.outputPath = outputPath;

      // Spawn the recorder IMMEDIATELY (parallel with the countdown).
      // The Swift recorder's first call to SCShareableContent can take
      // 3–5s on a cold launch (the OS enumerates all on-screen windows
      // + applications). If we waited for the countdown to finish
      // before spawning, the user would see "1" frozen for that whole
      // cold-load period. Overlapping the spawn + setup with the
      // visible countdown hides the cost.
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(binary, [], { stdio: ["pipe", "pipe", "pipe"] });
      } catch (cause) {
        await this.publishSessionFailure(
          sessionId,
          "recorder_spawn_failed",
          cause,
          displayId
        );
        throw cause;
      }
      this.child = child;
      let startFailureCode: RecordingFailureCode = "recorder_start_failed";

      this.startedPromise = new Promise<void>((resolve, reject) => {
        this.startResolve = resolve;
        this.startReject = reject;
      });
      this.stoppedPromise = new Promise<RecorderStoppedEvent>((resolve, reject) => {
        this.stopResolve = resolve;
        this.stopReject = reject;
      });
      // Suppress UnhandledPromiseRejection if cancel happens mid-
      // countdown: the no-op catch observes the promise while the
      // owning start/stop call still receives its original rejection.
      this.startedPromise.catch(() => undefined);
      this.stoppedPromise.catch(() => undefined);

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => this.consumeStdout(chunk, sessionId));
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        log.warn("recorder stderr", { chunk: chunk.trim() });
      });
      child.on("error", (cause) => {
        if (!this.isSessionCurrent(sessionId) || this.cancellingSessions.has(sessionId)) return;
        if (this.pendingFailures.has(sessionId)) return;
        if (this.startReject !== null) {
          startFailureCode = "recorder_spawn_failed";
          const reject = this.startReject;
          this.startReject = null;
          this.startResolve = null;
          void this.failActiveSession(sessionId, startFailureCode, cause, displayId);
          reject(cause);
          return;
        }
        if (this.stopRequested) {
          const reject = this.stopReject;
          this.stopReject = null;
          this.stopResolve = null;
          reject?.(cause);
          return;
        }
        void this.failActiveSession(sessionId, "recorder_exited", cause, displayId);
      });
      child.on("exit", (code, signal) => {
        log.info("recorder exited", { code, signal });
        if (!this.isSessionCurrent(sessionId) || this.cancellingSessions.has(sessionId)) return;
        if (this.pendingFailures.has(sessionId)) return;
        const cause = new Error(
          `recorder exited (code=${code ?? "null"}, signal=${signal ?? "null"})`
        );
        if (this.startReject !== null) {
          const reject = this.startReject;
          this.startReject = null;
          this.startResolve = null;
          void this.failActiveSession(sessionId, startFailureCode, cause, displayId);
          reject(cause);
          return;
        }
        if (this.stopRequested) {
          const reject = this.stopReject;
          this.stopReject = null;
          this.stopResolve = null;
          reject?.(cause);
          return;
        }
        void this.failActiveSession(sessionId, "recorder_exited", cause, displayId);
      });

      // Send the start command with a wall-clock target so the
      // recorder begins capturing AT countdownSeconds from now,
      // regardless of how long Swift's own setup took.
      const captureAtMs = Date.now() + options.countdownSeconds * 1000;
      const excludePids = collectOurPids();
      try {
        child.stdin.write(
          JSON.stringify({
            type: "start",
            displayId,
            rect: physicalRect,
            outputPath,
            systemAudio: options.capabilities.systemAudio,
            microphone: options.capabilities.microphone,
            showsCursor: options.captureCursor,
            captureAtMs,
            excludePids
          }) + "\n"
        );
      } catch (cause) {
        await this.publishSessionFailure(
          sessionId,
          "recorder_spawn_failed",
          cause,
          displayId
        );
        throw cause;
      }

      // Render the visible countdown in parallel with Swift's setup.
      if (options.countdownSeconds > 0) {
        for (let n = options.countdownSeconds; n > 0; n--) {
          await this.assertSessionRunnable(sessionId);
          setRecordingState({
            phase: "countdown",
            sessionId,
            secondsRemaining: n,
            rect: physicalRect,
            displayId
          });
          await this.waitForCountdownTick(sessionId);
          await this.assertSessionRunnable(sessionId);
        }
      }

      // Countdown done. If the recorder isn't ready yet, show a bounded
      // starting phase while waiting for the native acknowledgement.
      await this.assertSessionRunnable(sessionId);
      setRecordingState({ phase: "starting", sessionId, rect: physicalRect, displayId });
      try {
        await waitWithTimeout(this.startedPromise!, 15_000, () => {
          throw new Error("recorder_start_timeout");
        });
      } catch (cause) {
        if (
          this.pendingFailures.has(sessionId) ||
          this.cancellingSessions.has(sessionId) ||
          !this.isSessionCurrent(sessionId)
        ) {
          await this.assertSessionRunnable(sessionId);
        }
        const code =
          cause instanceof Error && cause.message === "recorder_start_timeout"
            ? "recorder_start_timeout"
            : startFailureCode;
        await this.publishSessionFailure(sessionId, code, cause, displayId);
        throw cause;
      }

      // `started` and `error` can be coalesced in one stdout chunk. The
      // error handler invalidates this session before this continuation runs;
      // never reassert `recording` for that dead generation.
      await this.assertSessionRunnable(sessionId);
      setRecordingState({
        phase: "recording",
        sessionId,
        startedAt: new Date().toISOString(),
        rect: physicalRect,
        displayId
      });
      return { sessionId };
    } finally {
      this.startingSessions.delete(sessionId);
      this.pendingFailures.delete(sessionId);
    }
  }

  async stop(): Promise<{ captureId: string }> {
    const state = getRecordingState();
    if (state.phase === "failed") {
      throw new Error("no_active_recording");
    }
    if (state.phase === "stopping" || state.phase === "processing") {
      throw new Error("stop_in_progress");
    }
    let resolveFinalization!: () => void;
    const finalizationSettled = new Promise<void>((resolve) => {
      resolveFinalization = resolve;
    });
    this.finalizationSettled = finalizationSettled;
    const task = this.stopClaimedSession();
    const finishFinalization = (): void => {
      if (this.finalizationSettled === finalizationSettled) {
        this.finalizationSettled = null;
      }
      resolveFinalization();
    };
    void task.then(finishFinalization, finishFinalization);
    return await task;
  }

  private async stopClaimedSession(): Promise<{ captureId: string }> {
    if (this.child === null || this.sessionId === null) {
      throw new Error("no_active_recording");
    }
    const sessionId = this.sessionId;
    const child = this.child;
    const subject = this.subject!;
    const displayId = subjectDisplayId(subject);
    this.stopRequested = true;
    setRecordingState({ phase: "stopping", sessionId });
    let stopped: RecorderStoppedEvent;
    try {
      child.stdin.write(JSON.stringify({ type: "stop" }) + "\n");
      stopped = await waitWithTimeout(this.stoppedPromise!, 10_000, () => {
        throw new Error("recorder_stop_timeout");
      });
    } catch (cause) {
      if (!this.isSessionRunnable(sessionId)) {
        await this.assertSessionRunnable(sessionId);
      }
      const code =
        cause instanceof Error && cause.message === "recorder_stop_timeout"
          ? "stop_timeout"
          : "stop_failed";
      await this.publishSessionFailure(sessionId, code, cause, displayId);
      throw cause;
    }
    await this.assertSessionRunnable(sessionId);
    const exited = await terminateRecorderProcess(child);
    await this.assertSessionRunnable(sessionId);
    if (!exited) {
      const cause = new Error("recorder_stop_timeout");
      await this.publishSessionFailure(sessionId, "stop_timeout", cause, displayId);
      throw cause;
    }
    setRecordingState({ phase: "processing", sessionId });
    let stored: { captureId: string };
    try {
      stored = await persistStoppedRecording(
        { ...stopped, subject },
        () => this.assertSessionRunnable(sessionId)
      );
    } catch (cause) {
      if (!this.isSessionRunnable(sessionId)) {
        await this.assertSessionRunnable(sessionId);
      }
      await this.publishSessionFailure(
        sessionId,
        "processing_failed",
        cause,
        displayId,
        false
      );
      throw cause;
    }
    await this.assertSessionRunnable(sessionId);
    setRecordingState({ phase: "ready", sessionId, captureId: stored.captureId });
    this.clearSession(sessionId);
    return stored;
  }

  /**
   * Discard the active session and immediately spawn a fresh one
   * with the same subject + capabilities. Defaults the countdown
   * back to the original 3 seconds so the user gets the same
   * pre-roll on the retry. Snapshots subject/capabilities BEFORE
   * calling cancel() because cancel() clears those fields as part
   * of cleanup.
   */
  async restart(): Promise<{ sessionId: string }> {
    if (this.subject === null || this.capabilities === null) {
      throw new Error("not_recording");
    }
    const subject = this.subject;
    const capabilities = this.capabilities;
    const captureCursor = this.captureCursor;
    await this.cancel();
    return this.start({ subject, capabilities, captureCursor, countdownSeconds: 3 });
  }

  async retry(sessionId: string): Promise<{ sessionId: string }> {
    if (!matchingRetryableFailedSession(sessionId) || this.retryOptions === null) {
      throw new Error("failure_not_retryable");
    }
    const options = snapshotStartOptions(this.retryOptions);
    return this.start(options);
  }

  async dismissFailure(sessionId: string): Promise<void> {
    if (!matchingFailedSession(sessionId)) {
      throw new Error("stale_failure");
    }
    // A normal failure has already crossed its process-exit barrier. If the
    // recorder ignored both signals, the failure remains non-retryable while
    // retaining ownership so Dismiss can make another bounded cleanup attempt
    // without ever overlapping a new take.
    if (this.sessionId === sessionId) {
      const exited = await terminateRecorderProcess(this.child);
      if (!exited) throw new Error("recorder_cleanup_failed");
      this.clearSession(sessionId);
    }
    this.retryOptions = null;
    if (recordingStateBelongsTo(sessionId)) setRecordingState({ phase: "idle" });
  }

  async cancel(): Promise<void> {
    return this.cancelSession(false);
  }

  async shutdown(): Promise<void> {
    return this.cancelSession(true);
  }

  private async cancelSession(cleanupFailedSession: boolean): Promise<void> {
    const finalizationSettled = this.finalizationSettled;
    if (finalizationSettled !== null) {
      // Once Stop has begun, the recorder output is being finalized. Cancel,
      // controller close, and app shutdown must wait for that durable outcome;
      // clearing the session would make persistence fail its generation guard.
      await finalizationSettled;
      return;
    }
    // Reset an active pre-capture/recording session even if its child has not
    // spawned yet. A terminal failure is intentionally excluded: a stale
    // normal Cancel must not erase the durable card or its retry snapshot.
    // App shutdown opts into failed-session cleanup through shutdown().
    const sessionId = this.sessionId;
    const child = this.child;
    if (getRecordingState().phase === "failed" && !cleanupFailedSession) {
      return;
    }
    if (sessionId === null) {
      // A terminal failure whose process already exited deliberately clears
      // the active-session fields while retaining its retry snapshot. A stale
      // normal Cancel action must not dismiss that durable failure; only the
      // session-scoped recording:dismissFailure command may do so.
      if (getRecordingState().phase === "failed") return;
      this.retryOptions = null;
      setRecordingState({ phase: "idle" });
      return;
    }
    this.cancellingSessions.add(sessionId);
    this.stopRequested = true;
    try {
      try {
        child?.stdin.write(JSON.stringify({ type: "stop" }) + "\n");
      } catch {
        /* ignore */
      }
      this.startReject?.(new Error("cancelled"));
      this.stopReject?.(new Error("cancelled"));
      this.cancelCountdownDelay(sessionId);
      const exited = await terminateRecorderProcess(child);
      if (!exited) {
        if (recordingStateBelongsTo(sessionId)) {
          publishRecordingFailure({
            sessionId,
            code: "stop_failed",
            displayId: subjectDisplayId(this.subject!),
            cause: new Error("recorder process did not exit during cancellation"),
            canRetry: false
          });
        }
        throw new Error("recorder_cleanup_failed");
      }
      if (this.sessionId === sessionId) this.clearSession(sessionId);
      if (recordingStateBelongsTo(sessionId)) setRecordingState({ phase: "idle" });
      log.info("recording cancelled", { sessionId });
    } finally {
      this.cancellingSessions.delete(sessionId);
      this.pendingFailures.delete(sessionId);
    }
  }

  private consumeStdout(chunk: string, sessionId: string): void {
    if (this.sessionId !== sessionId) return;
    this.inboundBuffer += chunk;
    let nl: number;
    while ((nl = this.inboundBuffer.indexOf("\n")) !== -1) {
      const line = this.inboundBuffer.slice(0, nl).trim();
      this.inboundBuffer = this.inboundBuffer.slice(nl + 1);
      if (line.length === 0) continue;
      let parsed: RecorderEvent;
      try {
        parsed = JSON.parse(line) as RecorderEvent;
      } catch (err) {
        log.warn("recorder produced unparseable line", { line });
        continue;
      }
      switch (parsed.event) {
        case "started":
          this.startResolve?.();
          this.startResolve = null;
          this.startReject = null;
          break;
        case "stopped":
          this.stopResolve?.(parsed);
          this.stopResolve = null;
          this.stopReject = null;
          break;
        case "error": {
          const err = new Error(`${parsed.code}: ${parsed.message}`);
          if (this.startReject !== null) {
            const reject = this.startReject;
            this.startReject = null;
            this.startResolve = null;
            void this.failActiveSession(
              sessionId,
              "recorder_start_failed",
              err,
              subjectDisplayId(this.subject!)
            );
            reject(err);
          } else if (this.stopRequested && this.stopReject !== null) {
            this.stopReject(err);
            this.stopReject = null;
            this.stopResolve = null;
          } else if (this.sessionId === sessionId) {
            void this.failActiveSession(
              sessionId,
              "recorder_exited",
              err,
              subjectDisplayId(this.subject!)
            );
          } else {
            log.warn("recorder error after lifecycle", { code: parsed.code, message: parsed.message });
          }
          break;
        }
      }
    }
  }

  private isSessionCurrent(sessionId: string): boolean {
    return this.sessionId === sessionId;
  }

  private isSessionRunnable(sessionId: string): boolean {
    return (
      this.sessionId === sessionId &&
      !this.cancellingSessions.has(sessionId) &&
      !this.pendingFailures.has(sessionId)
    );
  }

  private async assertSessionRunnable(sessionId: string): Promise<void> {
    if (this.cancellingSessions.has(sessionId)) throw new Error("cancelled");
    const failure = this.pendingFailures.get(sessionId);
    if (failure !== undefined) {
      await failure.completion;
      if (
        this.cancellingSessions.has(sessionId) ||
        !matchingFailedSession(sessionId)
      ) {
        throw new Error("cancelled");
      }
      throw failure.cause;
    }
    if (this.sessionId !== sessionId) throw new Error("cancelled");
  }

  private async publishSessionFailure(
    sessionId: string,
    code: RecordingFailureCode,
    cause: unknown,
    displayId: number,
    canRetry = true
  ): Promise<void> {
    await this.failActiveSession(sessionId, code, cause, displayId, canRetry);
    if (!matchingFailedSession(sessionId)) throw new Error("cancelled");
  }

  private failActiveSession(
    sessionId: string,
    code: RecordingFailureCode,
    cause: unknown,
    displayId: number,
    canRetry = true
  ): Promise<void> {
    const existing = this.pendingFailures.get(sessionId);
    if (existing !== undefined) return existing.completion;
    if (!this.isSessionCurrent(sessionId) || this.cancellingSessions.has(sessionId)) {
      return Promise.resolve();
    }

    const child = this.child;
    const failure: PendingSessionFailure = {
      cause,
      completion: Promise.resolve()
    };
    this.pendingFailures.set(sessionId, failure);
    failure.completion = (async () => {
      this.cancelCountdownDelay(sessionId);
      const exited = await terminateRecorderProcess(child);
      if (
        this.cancellingSessions.has(sessionId) ||
        !this.isSessionCurrent(sessionId)
      ) {
        return;
      }
      if (!exited) {
        // Keep ownership of the stubborn child so Dismiss/app shutdown can
        // retry cleanup. The public state is terminal and non-retryable, so it
        // never masquerades as a live take and no replacement can overlap it.
        if (recordingStateBelongsTo(sessionId)) {
          publishRecordingFailure({
            sessionId,
            code,
            displayId,
            cause,
            canRetry: false
          });
        }
        return;
      }
      this.clearSession(sessionId, { preserveRetry: true });
      if (!recordingStateBelongsTo(sessionId)) return;
      publishRecordingFailure({ sessionId, code, displayId, cause, canRetry });
    })().finally(() => {
      if (!this.startingSessions.has(sessionId)) {
        this.pendingFailures.delete(sessionId);
      }
    });
    return failure.completion;
  }

  private clearSession(
    sessionId: string,
    options: { preserveRetry?: boolean } = {}
  ): boolean {
    if (this.sessionId !== sessionId) return false;
    this.cancelCountdownDelay(sessionId);
    this.child = null;
    this.sessionId = null;
    this.subject = null;
    this.capabilities = null;
    this.captureCursor = undefined;
    this.outputPath = null;
    this.startedPromise = null;
    this.stoppedPromise = null;
    this.startResolve = null;
    this.startReject = null;
    this.stopResolve = null;
    this.stopReject = null;
    this.inboundBuffer = "";
    this.stopRequested = false;
    if (options.preserveRetry !== true) this.retryOptions = null;
    return true;
  }

  private waitForCountdownTick(sessionId: string): Promise<void> {
    this.cancelCountdownDelay(sessionId);
    return new Promise<void>((resolve) => {
      const finish = (): void => {
        if (this.countdownDelay?.sessionId === sessionId) {
          this.countdownDelay = null;
        }
        resolve();
      };
      const handle = setTimeout(finish, 1_000);
      this.countdownDelay = { sessionId, handle, resolve: finish };
    });
  }

  private cancelCountdownDelay(sessionId: string): void {
    const delay = this.countdownDelay;
    if (delay === null || delay.sessionId !== sessionId) return;
    clearTimeout(delay.handle);
    this.countdownDelay = null;
    delay.resolve();
  }
}


type PersistStoppedRecordingInput = {
  outputPath: string;
  durationSec: number;
  containerFormat: "mp4" | "mov";
  hasSystemAudio: boolean;
  hasMicrophoneAudio: boolean;
  subject: RecordingSubject;
};

async function persistStoppedRecording(
  stopped: PersistStoppedRecordingInput,
  assertSessionRunnable: () => Promise<void>
): Promise<{ captureId: string }> {
  const stored = await runWithCapturesDirFallback((outputDir) =>
    adoptExistingFileAsSource(stopped.outputPath, outputDir)
  );
  await assertSessionRunnable();
  const sizeInfo = await statSource(stored.srcPath);
  await assertSessionRunnable();
  const rect = subjectToPhysicalRect(stopped.subject);

  const sourceAppBundleId =
    stopped.subject.kind === "window" ? stopped.subject.appBundleId ?? null : null;
  const sourceAppName =
    stopped.subject.kind === "window" ? stopped.subject.appName ?? null : null;

  const { record } = insertCapture({
    id: stored.id,
    kind: "video",
    captured_at: new Date().toISOString(),
    source_app_bundle_id: sourceAppBundleId,
    source_app_name: sourceAppName,
    legacy_src_path: stored.srcPath,
    width_px: rect.w,
    height_px: rect.h,
    device_pixel_ratio: 1,
    byte_size: sizeInfo.byteSize,
    sha256: stored.sha256
  });
  insertVideoMetadata({
    captureId: record.id,
    durationSec: stopped.durationSec,
    containerFormat: stopped.containerFormat,
    hasSystemAudio: stopped.hasSystemAudio,
    hasMicrophoneAudio: stopped.hasMicrophoneAudio,
    subject: stopped.subject
  });
  try {
    await renameVideoSourceToEffectiveFilename(record.id);
  } catch (cause) {
    log.warn("recording source rename skipped", {
      captureId: record.id,
      message: cause instanceof Error ? cause.message : String(cause)
    });
  }
  await assertSessionRunnable();

  const hydrated = getCaptureById(record.id) ?? record;

  broadcastCapturesChanged([record.id]);
  setFloatOverState({ kind: "show-loaded", captureId: record.id, record: hydrated });
  maybeEnqueueCaptureEnrichment(record.id);
  try {
    if (Notification.isSupported()) {
      new Notification({
        title: "Recording saved",
        body: `${stopped.durationSec.toFixed(1)}s clip added to your Library.`
      }).show();
    }
  } catch {
    /* notifications are decorative; never block on them */
  }

  return { captureId: record.id };
}

class WindowsFfmpegRecorderService implements RecordingService {
  private child: ChildProcessWithoutNullStreams | null = null;
  private sessionId: string | null = null;
  private subject: RecordingSubject | null = null;
  private outputPath: string | null = null;
  private startedAtMs = 0;
  private stopRequested = false;
  private exitPromise: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | null = null;
  private stderrTail: string[] = [];
  private retryOptions: StartOptions | null = null;
  private readonly startingSessions = new Set<string>();
  private readonly pendingFailures = new Map<string, PendingSessionFailure>();
  private readonly cancellingSessions = new Set<string>();
  private countdownDelay: CountdownDelay | null = null;
  private finalizationSettled: Promise<void> | null = null;

  isActive(): boolean {
    return this.sessionId !== null;
  }

  async start(opts: StartOptions): Promise<{ sessionId: string }> {
    if (isRecordingActive() || this.sessionId !== null || this.child !== null) {
      throw new Error("already_recording");
    }
    const sessionId = nanoid(12);
    const options = snapshotStartOptions(opts);
    const displayId = subjectDisplayId(options.subject);
    const hudRect = subjectToPhysicalRect(options.subject);
    const captureRect = subjectToWindowsDesktopRect(options.subject);

    // Claim and broadcast synchronously before mkdtemp. Retry, Dismiss, a
    // second start, and app quit now all observe this generation as active.
    this.retryOptions = options;
    this.sessionId = sessionId;
    this.subject = options.subject;
    this.outputPath = null;
    this.child = null;
    this.exitPromise = null;
    this.startedAtMs = 0;
    this.stderrTail = [];
    this.stopRequested = false;
    this.startingSessions.add(sessionId);
    setRecordingState({ phase: "preflight", sessionId, rect: hudRect, displayId });

    try {
      const ffmpeg = resolveFfmpegPath();
      if (ffmpeg === null) {
        const cause = new Error("Windows recorder binary is unavailable");
        await this.publishSessionFailure(
          sessionId,
          "recorder_unavailable",
          cause,
          displayId
        );
        throw cause;
      }

      if (options.capabilities.microphone || options.capabilities.systemAudio) {
        log.warn("Windows recording currently captures screen video only; audio toggles ignored", {
          microphone: options.capabilities.microphone,
          systemAudio: options.capabilities.systemAudio
        });
      }

      let tmpDir: string;
      try {
        tmpDir = await mkdtemp(join(tmpdir(), "pwrsnap-recording-"));
      } catch (cause) {
        await this.assertSessionRunnable(sessionId);
        await this.publishSessionFailure(
          sessionId,
          "recorder_prepare_failed",
          cause,
          displayId
        );
        throw cause;
      }
      await this.assertSessionRunnable(sessionId);
      const outputPath = join(tmpDir, `${sessionId}.mp4`);
      this.outputPath = outputPath;

      if (options.countdownSeconds > 0) {
        for (let n = options.countdownSeconds; n > 0; n--) {
          await this.assertSessionRunnable(sessionId);
          setRecordingState({
            phase: "countdown",
            sessionId,
            secondsRemaining: n,
            rect: hudRect,
            displayId
          });
          await this.waitForCountdownTick(sessionId);
          await this.assertSessionRunnable(sessionId);
        }
      }

      await this.assertSessionRunnable(sessionId);
      setRecordingState({ phase: "starting", sessionId, rect: hudRect, displayId });

      const args = windowsFfmpegCaptureArgs(captureRect, outputPath);
      log.info("starting Windows ffmpeg recorder", { ffmpeg, captureRect, outputPath });
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(ffmpeg, args, {
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true
        });
      } catch (cause) {
        await this.publishSessionFailure(
          sessionId,
          "recorder_spawn_failed",
          cause,
          displayId
        );
        throw cause;
      }
      this.child = child;
      this.startedAtMs = Date.now();
      this.exitPromise = new Promise((resolve) => {
        child.on("exit", (code, signal) => {
          log.info("Windows ffmpeg recorder exited", { code, signal });
          resolve({ code, signal });
          if (
            !this.stopRequested &&
            this.isSessionCurrent(sessionId) &&
            !this.cancellingSessions.has(sessionId) &&
            !this.pendingFailures.has(sessionId)
          ) {
            const cause = new Error(windowsFfmpegFailureMessage(this.stderrTail, code, signal));
            void this.failActiveSession(
              sessionId,
              "recorder_exited",
              cause,
              displayId
            );
          }
        });
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        if (this.isSessionCurrent(sessionId)) this.rememberStderr(chunk);
        log.warn("Windows ffmpeg recorder stderr", { chunk: chunk.trim() });
      });
      child.stdout.setEncoding("utf8");
      child.on("error", (cause) => {
        if (!this.isSessionCurrent(sessionId) || this.cancellingSessions.has(sessionId)) return;
        const code = this.stopRequested ? "stop_failed" : "recorder_spawn_failed";
        void this.failActiveSession(sessionId, code, cause, displayId);
      });

      setRecordingState({
        phase: "recording",
        sessionId,
        startedAt: new Date(this.startedAtMs).toISOString(),
        rect: hudRect,
        displayId
      });
      return { sessionId };
    } finally {
      this.startingSessions.delete(sessionId);
      this.pendingFailures.delete(sessionId);
    }
  }

  async stop(): Promise<{ captureId: string }> {
    const state = getRecordingState();
    if (state.phase === "failed") {
      throw new Error("no_active_recording");
    }
    if (state.phase === "stopping" || state.phase === "processing") {
      throw new Error("stop_in_progress");
    }
    let resolveFinalization!: () => void;
    const finalizationSettled = new Promise<void>((resolve) => {
      resolveFinalization = resolve;
    });
    this.finalizationSettled = finalizationSettled;
    const task = this.stopClaimedSession();
    const finishFinalization = (): void => {
      if (this.finalizationSettled === finalizationSettled) {
        this.finalizationSettled = null;
      }
      resolveFinalization();
    };
    void task.then(finishFinalization, finishFinalization);
    return await task;
  }

  private async stopClaimedSession(): Promise<{ captureId: string }> {
    if (this.child === null || this.sessionId === null || this.exitPromise === null) {
      throw new Error("no_active_recording");
    }
    const sessionId = this.sessionId;
    const outputPath = this.outputPath!;
    const subject = this.subject!;
    const displayId = subjectDisplayId(subject);
    const startedAtMs = this.startedAtMs;
    const child = this.child;
    const exitPromise = this.exitPromise;

    this.stopRequested = true;
    setRecordingState({ phase: "stopping", sessionId });
    try {
      child.stdin.write("q");
    } catch {
      /* ffmpeg may already have closed stdin; the exit wait below handles it */
    }
    const gracefulExit = await waitForWindowsFfmpegExit(exitPromise, 5_000);
    await this.assertSessionRunnable(sessionId);
    let exit = gracefulExit;
    if (exit === null) {
      const terminated = await terminateRecorderProcess(child);
      await this.assertSessionRunnable(sessionId);
      if (!terminated) {
        const cause = new Error("ffmpeg recorder did not exit after stop timeout");
        await this.publishSessionFailure(sessionId, "stop_timeout", cause, displayId);
        throw cause;
      }
      exit = await exitPromise;
      await this.assertSessionRunnable(sessionId);
    }
    if (exit.code !== 0 || exit.signal !== null) {
      const cause = new Error(windowsFfmpegFailureMessage(this.stderrTail, exit.code, exit.signal));
      await this.publishSessionFailure(sessionId, "stop_failed", cause, displayId);
      throw cause;
    }

    await this.assertSessionRunnable(sessionId);
    setRecordingState({ phase: "processing", sessionId });
    const durationSec = Math.max(0.1, (Date.now() - startedAtMs) / 1000);
    let stored: { captureId: string };
    try {
      stored = await persistStoppedRecording(
        {
          outputPath,
          durationSec,
          containerFormat: "mp4",
          hasSystemAudio: false,
          hasMicrophoneAudio: false,
          subject
        },
        () => this.assertSessionRunnable(sessionId)
      );
    } catch (cause) {
      if (!this.isSessionRunnable(sessionId)) {
        await this.assertSessionRunnable(sessionId);
      }
      await this.publishSessionFailure(
        sessionId,
        "processing_failed",
        cause,
        displayId,
        false
      );
      throw cause;
    }
    await this.assertSessionRunnable(sessionId);
    setRecordingState({ phase: "ready", sessionId, captureId: stored.captureId });
    this.clearSession(sessionId);
    return stored;
  }

  async restart(): Promise<{ sessionId: string }> {
    if (this.subject === null) {
      throw new Error("not_recording");
    }
    const subject = this.subject;
    await this.cancel();
    return this.start({
      subject,
      capabilities: { systemAudio: false, microphone: false },
      countdownSeconds: 3
    });
  }

  async retry(sessionId: string): Promise<{ sessionId: string }> {
    if (!matchingRetryableFailedSession(sessionId) || this.retryOptions === null) {
      throw new Error("failure_not_retryable");
    }
    const options = snapshotStartOptions(this.retryOptions);
    return this.start(options);
  }

  async dismissFailure(sessionId: string): Promise<void> {
    if (!matchingFailedSession(sessionId)) {
      throw new Error("stale_failure");
    }
    if (this.sessionId === sessionId) {
      const exited = await terminateRecorderProcess(this.child);
      if (!exited) throw new Error("recorder_cleanup_failed");
      this.clearSession(sessionId);
    }
    this.retryOptions = null;
    if (recordingStateBelongsTo(sessionId)) setRecordingState({ phase: "idle" });
  }

  async cancel(): Promise<void> {
    return this.cancelSession(false);
  }

  async shutdown(): Promise<void> {
    return this.cancelSession(true);
  }

  private async cancelSession(cleanupFailedSession: boolean): Promise<void> {
    const finalizationSettled = this.finalizationSettled;
    if (finalizationSettled !== null) {
      await finalizationSettled;
      return;
    }
    const sessionId = this.sessionId;
    const child = this.child;
    if (getRecordingState().phase === "failed" && !cleanupFailedSession) {
      return;
    }
    if (sessionId === null) {
      if (getRecordingState().phase === "failed") return;
      this.retryOptions = null;
      setRecordingState({ phase: "idle" });
      return;
    }
    this.cancellingSessions.add(sessionId);
    this.stopRequested = true;
    try {
      try {
        child?.stdin.write("q");
      } catch {
        /* ignore */
      }
      this.cancelCountdownDelay(sessionId);
      const exited = await terminateRecorderProcess(child);
      if (!exited) {
        if (recordingStateBelongsTo(sessionId)) {
          publishRecordingFailure({
            sessionId,
            code: "stop_failed",
            displayId: subjectDisplayId(this.subject!),
            cause: new Error("recorder process did not exit during cancellation"),
            canRetry: false
          });
        }
        throw new Error("recorder_cleanup_failed");
      }
      if (this.sessionId === sessionId) this.clearSession(sessionId);
      if (recordingStateBelongsTo(sessionId)) setRecordingState({ phase: "idle" });
      log.info("recording cancelled", { sessionId });
    } finally {
      this.cancellingSessions.delete(sessionId);
      this.pendingFailures.delete(sessionId);
    }
  }

  private rememberStderr(chunk: string): void {
    const trimmed = chunk.trim();
    if (trimmed.length === 0) return;
    this.stderrTail.push(trimmed);
    if (this.stderrTail.length > 8) this.stderrTail.shift();
  }

  private isSessionCurrent(sessionId: string): boolean {
    return this.sessionId === sessionId;
  }

  private isSessionRunnable(sessionId: string): boolean {
    return (
      this.sessionId === sessionId &&
      !this.cancellingSessions.has(sessionId) &&
      !this.pendingFailures.has(sessionId)
    );
  }

  private async assertSessionRunnable(sessionId: string): Promise<void> {
    if (this.cancellingSessions.has(sessionId)) throw new Error("cancelled");
    const failure = this.pendingFailures.get(sessionId);
    if (failure !== undefined) {
      await failure.completion;
      if (
        this.cancellingSessions.has(sessionId) ||
        !matchingFailedSession(sessionId)
      ) {
        throw new Error("cancelled");
      }
      throw failure.cause;
    }
    if (this.sessionId !== sessionId) throw new Error("cancelled");
  }

  private async publishSessionFailure(
    sessionId: string,
    code: RecordingFailureCode,
    cause: unknown,
    displayId: number,
    canRetry = true
  ): Promise<void> {
    await this.failActiveSession(sessionId, code, cause, displayId, canRetry);
    if (!matchingFailedSession(sessionId)) throw new Error("cancelled");
  }

  private failActiveSession(
    sessionId: string,
    code: RecordingFailureCode,
    cause: unknown,
    displayId: number,
    canRetry = true
  ): Promise<void> {
    const existing = this.pendingFailures.get(sessionId);
    if (existing !== undefined) return existing.completion;
    if (!this.isSessionCurrent(sessionId) || this.cancellingSessions.has(sessionId)) {
      return Promise.resolve();
    }

    const child = this.child;
    const failure: PendingSessionFailure = {
      cause,
      completion: Promise.resolve()
    };
    this.pendingFailures.set(sessionId, failure);
    failure.completion = (async () => {
      this.cancelCountdownDelay(sessionId);
      const exited = await terminateRecorderProcess(child);
      if (
        this.cancellingSessions.has(sessionId) ||
        !this.isSessionCurrent(sessionId)
      ) {
        return;
      }
      if (!exited) {
        if (recordingStateBelongsTo(sessionId)) {
          publishRecordingFailure({
            sessionId,
            code,
            displayId,
            cause,
            canRetry: false
          });
        }
        return;
      }
      this.clearSession(sessionId, { preserveRetry: true });
      if (!recordingStateBelongsTo(sessionId)) return;
      publishRecordingFailure({ sessionId, code, displayId, cause, canRetry });
    })().finally(() => {
      if (!this.startingSessions.has(sessionId)) {
        this.pendingFailures.delete(sessionId);
      }
    });
    return failure.completion;
  }

  private clearSession(
    sessionId: string,
    options: { preserveRetry?: boolean } = {}
  ): boolean {
    if (this.sessionId !== sessionId) return false;
    this.cancelCountdownDelay(sessionId);
    this.child = null;
    this.sessionId = null;
    this.subject = null;
    this.outputPath = null;
    this.startedAtMs = 0;
    this.stopRequested = false;
    this.exitPromise = null;
    this.stderrTail = [];
    if (options.preserveRetry !== true) this.retryOptions = null;
    return true;
  }

  private waitForCountdownTick(sessionId: string): Promise<void> {
    this.cancelCountdownDelay(sessionId);
    return new Promise<void>((resolve) => {
      const finish = (): void => {
        if (this.countdownDelay?.sessionId === sessionId) {
          this.countdownDelay = null;
        }
        resolve();
      };
      const handle = setTimeout(finish, 1_000);
      this.countdownDelay = { sessionId, handle, resolve: finish };
    });
  }

  private cancelCountdownDelay(sessionId: string): void {
    const delay = this.countdownDelay;
    if (delay === null || delay.sessionId !== sessionId) return;
    clearTimeout(delay.handle);
    this.countdownDelay = null;
    delay.resolve();
  }
}

async function waitForWindowsFfmpegExit(
  exitPromise: Promise<{ code: number | null; signal: NodeJS.Signals | null }>,
  timeoutMs: number
): Promise<{ code: number | null; signal: NodeJS.Signals | null } | null> {
  return await waitWithTimeout<
    { code: number | null; signal: NodeJS.Signals | null } | null
  >(exitPromise, timeoutMs, () => null);
}

function windowsFfmpegCaptureArgs(
  rect: { x: number; y: number; w: number; h: number },
  outputPath: string
): string[] {
  return [
    "-hide_banner",
    "-loglevel",
    "warning",
    "-y",
    "-f",
    "gdigrab",
    "-framerate",
    "30",
    "-offset_x",
    String(rect.x),
    "-offset_y",
    String(rect.y),
    "-video_size",
    `${rect.w}x${rect.h}`,
    "-draw_mouse",
    "1",
    "-i",
    "desktop",
    "-an",
    "-c:v",
    "h264_mf",
    "-b:v",
    "8M",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    outputPath
  ];
}

function windowsFfmpegFailureMessage(
  stderrTail: string[],
  code: number | null,
  signal: NodeJS.Signals | null
): string {
  const suffix = stderrTail.length > 0 ? `: ${stderrTail.join("\n")}` : "";
  return `ffmpeg recorder exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "null"})${suffix}`;
}

function subjectToWindowsDesktopRect(subject: RecordingSubject): {
  x: number;
  y: number;
  w: number;
  h: number;
} {
  if (subject.kind === "display") {
    const display = screen.getAllDisplays().find((d) => d.id === subject.displayId) ?? screen.getPrimaryDisplay();
    return dipRectToWindowsScreenPixels({
      x: display.bounds.x,
      y: display.bounds.y,
      w: display.bounds.width,
      h: display.bounds.height
    });
  }
  return dipRectToWindowsScreenPixels({
    x: subject.rect.x,
    y: subject.rect.y,
    w: subject.rect.w,
    h: subject.rect.h
  });
}

function dipRectToWindowsScreenPixels(rect: { x: number; y: number; w: number; h: number }): {
  x: number;
  y: number;
  w: number;
  h: number;
} {
  const physical = screen.dipToScreenRect(null, {
    x: rect.x,
    y: rect.y,
    width: rect.w,
    height: rect.h
  });
  return normalizeWindowsCaptureRect({
    x: physical.x,
    y: physical.y,
    w: physical.width,
    h: physical.height
  });
}

function normalizeWindowsCaptureRect(rect: { x: number; y: number; w: number; h: number }): {
  x: number;
  y: number;
  w: number;
  h: number;
} {
  const w = Math.max(2, Math.floor(rect.w / 2) * 2);
  const h = Math.max(2, Math.floor(rect.h / 2) * 2);
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    w,
    h
  };
}
/**
 * Translate the subject's rect from the GLOBAL logical coord space
 * (the convention the region selector resolves to —
 * `region-selector.ts:225` adds `display.bounds.{x,y}` before
 * resolving) into DISPLAY-LOCAL logical coords (what both the
 * recording-controller HUD and the Swift recorder's `sourceRect`
 * actually want).
 *
 * Without this translation, multi-monitor setups where the
 * recorded display has a non-zero origin (e.g. a 2560×1440
 * secondary at `bounds.x=1496, bounds.y=-473`) double-position the
 * HUD by `display.bounds` (controller adds it again in `fillRect`)
 * AND mis-aim the recorder (ScreenCaptureKit's `sourceRect` is
 * relative to the captured display, not the virtual desktop). The
 * bug is invisible on single-display setups where `bounds.{x,y}`
 * are zero.
 */
function subjectToPhysicalRect(subject: RecordingSubject): {
  x: number;
  y: number;
  w: number;
  h: number;
} {
  switch (subject.kind) {
    case "region":
    case "window": {
      const display = screen.getAllDisplays().find((d) => d.id === subject.displayId);
      const offsetX = display?.bounds.x ?? 0;
      const offsetY = display?.bounds.y ?? 0;
      return {
        x: subject.rect.x - offsetX,
        y: subject.rect.y - offsetY,
        w: subject.rect.w,
        h: subject.rect.h
      };
    }
    case "display": {
      // Recorder reads its own display dims; supply zeros and it
      // captures full-display.
      return { x: 0, y: 0, w: 0, h: 0 };
    }
  }
}

function subjectDisplayId(subject: RecordingSubject): number {
  return subject.displayId;
}

/**
 * PIDs to exclude from the SCContentFilter. We intentionally exclude
 * ONLY the recording-controller HUD's renderer — not every PwrSnap
 * BrowserWindow.
 *
 * The earlier "exclude all our PIDs" approach broke the obvious use
 * case of recording one of our own windows (Library, Settings, etc.):
 * SCContentFilter.excludingApplications removes that PID's pixels
 * from the captured frame and shows whatever sits underneath, so
 * picking the Library window as the subject produced "what's behind
 * the Library" instead of the Library itself. We never want that —
 * if the user pointed at a window, they want THAT window in the
 * recording.
 *
 * The HUD overlay (Stop / Restart / Cancel pill, countdown leader)
 * is the ONE window we never want in the frame regardless of subject.
 * `getRecordingControllerPid()` returns null until the HUD renderer
 * has a real PID; if that races, we send an empty list and the HUD
 * may briefly appear in the first frame. In practice the HUD is
 * created during preflight and its renderer is loaded long before
 * Swift's captureAtMs fires ~3s later, so this is benign.
 *
 * Other transient overlays (float-over toast, tray popover) are not
 * excluded by default — they're dismissed before / outside the
 * recording window in normal flows. If we ever see them slipping
 * into a recording we can add them here, ideally still through a
 * single window-targeted exclusion rather than a process-tree one.
 */
function collectOurPids(): number[] {
  const hudPid = getRecordingControllerPid();
  return hudPid !== null ? [hudPid] : [];
}

/**
 * Default singleton accessor. Lazily instantiates a real recorder on
 * first call. Tests inject a stub via `__setRecordingServiceForTests`
 * in handlers/recording-handlers.ts before any handler dispatches.
 */
export function getRecordingService(): RecordingService {
  if (activeService === null) {
    activeService = process.platform === "win32"
      ? new WindowsFfmpegRecorderService()
      : new NativeRecorderService();
  }
  return activeService;
}

/** Test seam: swap the recorder for a stub between specs. */
export function __setRecordingServiceForTests(service: RecordingService | null): void {
  activeService = service;
}
