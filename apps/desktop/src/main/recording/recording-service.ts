import { beginCameraRecording, markCameraScreenStart, markCameraScreenStartUtc, prepareCameraPreview, confirmCameraPreviewExclusion, finishCameraRecording, cancelCameraRecording } from "./camera-recording";
import { setVideoCamera } from "../persistence/video-repo";
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
import { mkdtemp, rm } from "node:fs/promises";
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
import { globalRectToDisplayLocal } from "../capture/rect-overlap";
import { setFloatOverState } from "../float-over";
import { broadcastCapturesChanged } from "../events";
import { maybeEnqueueCaptureEnrichment } from "../handlers/codex-handlers";
import { runWithCapturesDirFallback } from "../capture/capture-storage-gate";
import { listWindows } from "../capture/window-list";
import {
  getCaptureById,
  insertCapture,
  normalizeSourceWindowTitle
} from "../persistence/captures-repo";
import {
  adoptExistingFileAsSource,
  prepareExistingFileAsSource,
  statSource
} from "../persistence/source-store";
import { insertVideoMetadata } from "../persistence/video-repo";
import { renameVideoSourceToEffectiveFilename } from "../persistence/video-filename-maintenance";
import { getRecordingControllerPid } from "./recording-controller";
import {
  getRecordingState,
  isRecordingActive,
  setRecordingState
} from "./recording-state";
import { resolveFfmpegPath } from "./ffmpeg-resolver";
import { planWindowsFfmpegCapture, windowsCaptureStartUtcMs } from "./windows-ffmpeg-capture";

const log = getMainLogger("pwrsnap:recording-service");

class NativeRecorderError extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`);
  }
}

function snapshotStartOptions(opts: StartOptions): StartOptions {
  return {
    subject:
      opts.subject.kind === "display"
        ? { ...opts.subject }
        : { ...opts.subject, rect: { ...opts.subject.rect } },
    capabilities: {
      ...opts.capabilities,
      ...(opts.capabilities.camera ? { camera: { ...opts.capabilities.camera } } : {}),
      ...(opts.capabilities.microphoneDevice ? { microphoneDevice: { ...opts.capabilities.microphoneDevice } } : {})
    },
    countdownSeconds: opts.countdownSeconds,
    captureCursor: opts.captureCursor
  };
}

function publishRecordingFailure(input: {
  sessionId: string;
  code: RecordingFailureCode;
  displayId: number;
  cause: unknown;
  canRetry?: boolean;
}): void {
  const message = input.cause instanceof Error ? input.cause.message : String(input.cause);
  log.error("recording lifecycle failed", {
    sessionId: input.sessionId,
    code: input.code,
    message
  });
  setRecordingState({
    phase: "failed",
    sessionId: input.sessionId,
    code: input.code,
    canRetry: input.canRetry ?? true,
    displayId: input.displayId
  });
}

async function removeRecorderOwnedTempDir(tempDir: string | null): Promise<void> {
  if (tempDir === null) return;
  try {
    // `tempDir` is the exact directory returned by this service's mkdtemp call;
    // never derive this recursive-delete target from a recorder event path.
    await rm(tempDir, { recursive: true, force: true });
  } catch (cause) {
    log.warn("recording temp directory cleanup failed", {
      tempDir,
      message: cause instanceof Error ? cause.message : String(cause)
    });
  }
}

export type StartOptions = {
  subject: RecordingSubject;
  capabilities: RecordingCapabilities;
  countdownSeconds: number;
  /** Whether the recording bakes in the mouse cursor. Omitted = true on every
   *  backend. `| undefined` is explicit so restart() can forward a possibly-unset
   *  snapshot under exactOptionalPropertyTypes. */
  captureCursor?: boolean | undefined;
};

export type TrustedRecordingWindowIdentity = Readonly<{
  windowId: number;
  pid: number;
}>;

export type RecordingService = {
  start(opts: StartOptions): Promise<{ sessionId: string }>;
  stop(): Promise<{ captureId: string }>;
  cancel(): Promise<void>;
  /** Discard the in-flight session and immediately start a fresh
   *  one with the same subject + capabilities. Throws
   *  `not_recording` if no session is active. */
  restart(): Promise<{ sessionId: string }>;
  /** Read the safe capability subset needed to preflight a retry. Validates
   * that the supplied failure session is still current and retryable. */
  retryCapabilities(sessionId: string): RecordingCapabilities;
  retry(sessionId: string): Promise<{ sessionId: string }>;
  dismissFailure(sessionId: string): Promise<void>;
  /** Main-process-only provenance attached to an active or retryable failed session.
   *  Public recording:start callers cannot provide this evidence. */
  attachTrustedWindowIdentity?(
    sessionId: string,
    identity: TrustedRecordingWindowIdentity
  ): boolean;
  /** True when this service has an active session. Used by the
   *  app-quit hook to cancel before exit. */
  isActive(): boolean;
};

let activeService: RecordingService | null = null;

async function resolveTrustedRecordingWindowTitle(
  identity: TrustedRecordingWindowIdentity
): Promise<string | null> {
  try {
    const live = (await listWindows()).find(
      (window) => window.windowId === identity.windowId
    );
    if (live === undefined || live.pid !== identity.pid) return null;
    return normalizeSourceWindowTitle(
      typeof live.title === "string" ? live.title : null
    );
  } catch {
    return null;
  }
}

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
type RecorderEvent = RecorderStartedEvent | RecorderStoppedEvent | RecorderErrorEvent | { event: "timeline"; utcTimeMs?: number } | { event: "cameraPreview"; excluded: boolean };

// Resources and waiters belong to one admitted attempt, including the period
// before a child exists. Never look up a child/temp directory through mutable
// service fields after an await or in a process callback.
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}

type RecorderExit = { code: number | null; signal: NodeJS.Signals | null };
type AttemptPhase = "starting" | "recording" | "stopping" | "processing" | "cancelling" | "retired";

class RecordingAttempt {
  readonly sessionId = nanoid(12);
  readonly displayId: number;
  readonly rect: ReturnType<typeof subjectToPhysicalRect>;
  readonly aborted = deferred<never>();
  readonly started = deferred<void>();
  readonly stopped = deferred<RecorderStoppedEvent>();
  readonly exited = deferred<RecorderExit>();
  phase: AttemptPhase = "starting";
  cancelled = false;
  child: ChildProcessWithoutNullStreams | null = null;
  tempDir: string | null = null;
  allocation: Promise<string> | null = null;
  outputPath = "";
  startedAtMs = 0;
  startAcknowledged = false;
  stopAcknowledged = false;
  exit: RecorderExit | null = null;
  inboundBuffer = "";
  stderrTail: string[] = [];
  startFailureCode: RecordingFailureCode = "recorder_start_failed";
  trustedWindowIdentity: TrustedRecordingWindowIdentity | null = null;
  sourceWindowTitlePromise: Promise<string | null> | null = null;
  stopOperation: Promise<{ captureId: string }> | null = null;
  cancelOperation: Promise<void> | null = null;
  cleanupOperation: Promise<void> | null = null;
  restarting = false;

  constructor(readonly options: StartOptions) {
    this.displayId = subjectDisplayId(options.subject);
    this.rect = subjectToPhysicalRect(options.subject);
  }

  abort(): void {
    this.cancelled = true;
    this.aborted.reject(new Error("cancelled"));
  }

  wait<T>(operation: Promise<T>): Promise<T> {
    return Promise.race([operation, this.aborted.promise]);
  }
}

async function withDeadline<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Shared admission/control boundary. Backends only operate on the captured
 * attempt. Admission is reserved synchronously and released after retirement,
 * so cleanup (including the process-global camera) cannot overlap a successor. */
abstract class AttemptRecorderService implements RecordingService {
  protected attempt: RecordingAttempt | null = null;
  private retryOptions: StartOptions | null = null;
  private retryWindowIdentity: TrustedRecordingWindowIdentity | null = null;
  private retryInFlight = false;

  protected abstract resolveBinary(): string | null;
  protected abstract unavailableMessage(): string;
  protected abstract startRecorder(attempt: RecordingAttempt, binary: string): Promise<void>;
  protected abstract stopRecorder(attempt: RecordingAttempt): Promise<RecorderStoppedEvent>;
  protected abstract requestStop(attempt: RecordingAttempt): void;
  protected abstract cancelAcknowledgement(attempt: RecordingAttempt): Promise<unknown>;

  isActive(): boolean {
    return this.attempt !== null;
  }

  protected owns(attempt: RecordingAttempt): boolean {
    return this.attempt === attempt && attempt.phase !== "retired";
  }

  protected assertStarting(attempt: RecordingAttempt): void {
    if (!this.owns(attempt) || attempt.cancelled) throw new Error("cancelled");
  }

  attachTrustedWindowIdentity(sessionId: string, identity: TrustedRecordingWindowIdentity): boolean {
    const state = getRecordingState();
    const failedSubject = state.phase === "failed" && state.sessionId === sessionId
      && state.canRetry ? this.retryOptions?.subject : null;
    if (failedSubject?.kind === "window" && failedSubject.windowId === identity.windowId) {
      this.retryWindowIdentity = { ...identity };
      return true;
    }
    const attempt = this.attempt;
    if (!attempt || attempt.sessionId !== sessionId || attempt.options.subject.kind !== "window"
      || attempt.options.subject.windowId !== identity.windowId) return false;
    this.retryWindowIdentity = { ...identity };
    attempt.trustedWindowIdentity = { ...identity };
    attempt.sourceWindowTitlePromise = resolveTrustedRecordingWindowTitle(identity);
    return true;
  }

  async start(opts: StartOptions): Promise<{ sessionId: string }> {
    return this.startAttempt(opts, false);
  }

  private async startAttempt(opts: StartOptions, retryingFailure: boolean): Promise<{ sessionId: string }> {
    if (this.attempt !== null || isRecordingActive()) throw new Error("already_recording");
    if (getRecordingState().phase === "failed" && !retryingFailure) throw new Error("failure_action_required");
    const attempt = new RecordingAttempt(snapshotStartOptions(opts));
    this.attempt = attempt;
    this.retryOptions = attempt.options;
    if (!retryingFailure) this.retryWindowIdentity = null;
    // Reserve both the service and the public lifecycle before the first await.
    setRecordingState({ phase: "preflight", sessionId: attempt.sessionId, rect: attempt.rect, displayId: attempt.displayId });
    let canRetry = true;
    try {
      this.assertStarting(attempt);
      const binary = this.resolveBinary();
      if (binary === null) {
        attempt.startFailureCode = "recorder_unavailable";
        canRetry = !app.isPackaged;
        throw new Error(this.unavailableMessage());
      }
      // Assign late allocations to their owner even if cancellation wins the
      // wait. Retirement drains allocation before releasing admission.
      attempt.allocation = mkdtemp(join(tmpdir(), "pwrsnap-recording-")).then(dir => {
        attempt.tempDir = dir;
        attempt.outputPath = join(dir, `${attempt.sessionId}.mp4`);
        return dir;
      });
      await attempt.wait(attempt.allocation);
      this.assertStarting(attempt);
      if (attempt.options.capabilities.camera) {
        await attempt.wait(beginCameraRecording(attempt.options.capabilities.camera));
      }
      this.assertStarting(attempt);
      await this.startRecorder(attempt, binary);
      this.assertStarting(attempt);
      attempt.phase = "recording";
      setRecordingState({
        phase: "recording", sessionId: attempt.sessionId,
        startedAt: new Date(attempt.startedAtMs).toISOString(),
        rect: attempt.rect, displayId: attempt.displayId,
        capabilities: this.recordedCapabilities(attempt)
      });
      return { sessionId: attempt.sessionId };
    } catch (cause) {
      if (attempt.cancelled || !this.owns(attempt)) throw new Error("cancelled");
      await this.fail(attempt,
        cause instanceof NativeRecorderError && cause.code === "microphone_unavailable"
          ? "microphone_unavailable" : attempt.startFailureCode,
        cause, { canRetry });
      throw cause;
    }
  }

  protected recordedCapabilities(attempt: RecordingAttempt): RecordingCapabilities {
    return { ...attempt.options.capabilities };
  }

  protected async countdown(attempt: RecordingAttempt): Promise<void> {
    for (let n = attempt.options.countdownSeconds; n > 0; n--) {
      this.assertStarting(attempt);
      setRecordingState({ phase: "countdown", sessionId: attempt.sessionId,
        secondsRemaining: n, rect: attempt.rect, displayId: attempt.displayId });
      // Clear the pending tick as well as settling the start caller on abort.
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await attempt.wait(new Promise<void>(resolve => { timer = setTimeout(resolve, 1_000); }));
      } finally { clearTimeout(timer); }
    }
    this.assertStarting(attempt);
    setRecordingState({ phase: "starting", sessionId: attempt.sessionId, rect: attempt.rect, displayId: attempt.displayId });
  }

  stop(): Promise<{ captureId: string }> {
    const attempt = this.attempt;
    if (!attempt) return Promise.reject(new Error("no_active_recording"));
    if (attempt.stopOperation) return attempt.stopOperation;
    if (attempt.phase !== "recording") return Promise.reject(new Error("control_unavailable"));
    attempt.phase = "stopping";
    // Set ownership before any await so duplicate stops share one persistence.
    attempt.stopOperation = this.finish(attempt);
    return attempt.stopOperation;
  }

  private async finish(attempt: RecordingAttempt): Promise<{ captureId: string }> {
    setRecordingState({ phase: "stopping", sessionId: attempt.sessionId });
    let stopped: RecorderStoppedEvent;
    try {
      stopped = await this.stopRecorder(attempt);
    } catch (cause) {
      const timeout = cause instanceof Error && cause.message === "recorder_stop_timeout";
      log.warn("recording stop failed; recorder output preserved for recovery", {
        outputPath: attempt.outputPath, tempDir: attempt.tempDir,
        message: cause instanceof Error ? cause.message : String(cause)
      });
      await this.fail(attempt, timeout ? "stop_timeout" : "stop_failed", cause,
        { preserveTempDir: true, canRetry: false });
      throw cause;
    }
    attempt.phase = "processing";
    setRecordingState({ phase: "processing", sessionId: attempt.sessionId });
    let sourceAdopted = false;
    try {
      const sourceWindowTitle = await (attempt.sourceWindowTitlePromise ?? Promise.resolve(null));
      const requested = this.recordedCapabilities(attempt);
      const stored = await persistStoppedRecording({
        ...stopped,
        requestedSystemAudio: requested.systemAudio,
        requestedMicrophone: requested.microphone,
        subject: attempt.options.subject, sourceWindowTitle,
        onSourceAdopted: async () => {
          sourceAdopted = true;
          const tempDir = attempt.tempDir;
          attempt.tempDir = null;
          await removeRecorderOwnedTempDir(tempDir);
        }
      });
      await this.cleanup(attempt);
      this.retryOptions = null;
      this.retryWindowIdentity = null;
      this.attempt = null;
      setRecordingState({ phase: "ready", sessionId: attempt.sessionId, captureId: stored.captureId });
      return stored;
    } catch (cause) {
      if (!sourceAdopted) log.warn("recording adoption failed; recorder output preserved for recovery", {
        outputPath: stopped.outputPath, tempDir: attempt.tempDir,
        message: cause instanceof Error ? cause.message : String(cause)
      });
      await this.fail(attempt, "processing_failed", cause,
        { preserveTempDir: !sourceAdopted, canRetry: false });
      throw cause;
    }
  }

  async restart(): Promise<{ sessionId: string }> {
    const attempt = this.attempt;
    if (!attempt) throw new Error("not_recording");
    if ((attempt.phase !== "recording" && attempt.phase !== "starting") || attempt.restarting) throw new Error("control_unavailable");
    attempt.restarting = true;
    const identity = attempt.trustedWindowIdentity;
    await this.cancel();
    const started = await this.start({ ...attempt.options, countdownSeconds: 3 });
    if (identity) this.attachTrustedWindowIdentity(started.sessionId, identity);
    return started;
  }

  async retry(sessionId: string): Promise<{ sessionId: string }> {
    this.retryCapabilities(sessionId);
    this.retryInFlight = true;
    try {
      const identity = this.retryWindowIdentity;
      if (this.attempt?.phase === "retired") await this.attempt.cleanupOperation;
      const started = await this.startAttempt(snapshotStartOptions(this.retryOptions!), true);
      if (identity) this.attachTrustedWindowIdentity(started.sessionId, identity);
      return started;
    } finally { this.retryInFlight = false; }
  }

  retryCapabilities(sessionId: string): RecordingCapabilities {
    const state = getRecordingState();
    if (this.retryInFlight || state.phase !== "failed" || state.sessionId !== sessionId
      || !state.canRetry || this.retryOptions === null) throw new Error("stale_failure");
    return snapshotStartOptions(this.retryOptions).capabilities;
  }

  async dismissFailure(sessionId: string): Promise<void> {
    const state = getRecordingState();
    const attempt = this.attempt;
    if (this.retryInFlight || state.phase !== "failed" || state.sessionId !== sessionId
      || (attempt !== null && (attempt.sessionId !== sessionId || attempt.phase !== "retired"))) {
      throw new Error("stale_failure");
    }
    if (attempt !== null) await attempt.cleanupOperation;
    // Retry or another Dismiss may have claimed the failure while cleanup ran.
    const current = getRecordingState();
    if (this.retryInFlight || this.attempt !== null || current.phase !== "failed" || current.sessionId !== sessionId) {
      throw new Error("stale_failure");
    }
    this.retryOptions = null;
    this.retryWindowIdentity = null;
    setRecordingState({ phase: "idle" });
  }

  cancel(): Promise<void> {
    const attempt = this.attempt;
    if (!attempt) {
      this.retryOptions = null;
      this.retryWindowIdentity = null;
      setRecordingState({ phase: "idle" });
      return Promise.resolve();
    }
    if (attempt.cancelOperation) return attempt.cancelOperation;
    if (attempt.phase === "stopping" || attempt.phase === "processing" || attempt.phase === "retired") {
      return Promise.reject(new Error("control_unavailable"));
    }
    attempt.phase = "cancelling";
    attempt.abort();
    attempt.cancelOperation = this.discard(attempt);
    return attempt.cancelOperation;
  }

  private async discard(attempt: RecordingAttempt): Promise<void> {
    if (attempt.child) {
      try {
        this.requestStop(attempt);
        await withDeadline(this.cancelAcknowledgement(attempt), 500, "cancel_timeout");
      } catch { /* cancellation is best effort */ }
    }
    await this.cleanup(attempt);
    this.retryOptions = null;
    this.retryWindowIdentity = null;
    this.attempt = null;
    setRecordingState({ phase: "idle" });
    log.info("recording cancelled", { sessionId: attempt.sessionId });
  }

  protected fail(attempt: RecordingAttempt, code: RecordingFailureCode, cause: unknown,
    options: { preserveTempDir?: boolean; canRetry?: boolean } = {}): Promise<void> {
    if (!this.owns(attempt) || attempt.cancelled) return Promise.resolve();
    // Publish while admission is still held; callbacks after retirement cannot
    // publish or clean up, and no successor can start until cleanup completes.
    const cleanup = this.cleanup(attempt, options).then(() => {
      if (this.attempt === attempt) this.attempt = null;
    });
    publishRecordingFailure({ sessionId: attempt.sessionId, displayId: attempt.displayId,
      code, cause, canRetry: options.canRetry ?? true });
    return cleanup;
  }

  private cleanup(attempt: RecordingAttempt, options: { preserveTempDir?: boolean } = {}): Promise<void> {
    if (attempt.cleanupOperation) return attempt.cleanupOperation;
    attempt.phase = "retired";
    // Capture the process-global camera synchronously before awaiting anything.
    // The camera is already detached and its worker closed before its file
    // cleanup awaits. A close/remove error must not keep admission reserved or
    // replace a saved capture or the original recorder failure with that error.
    const cameraCleanup = cancelCameraRecording().catch((cause: unknown) => {
      log.warn("recording camera cleanup failed", {
        sessionId: attempt.sessionId,
        message: cause instanceof Error ? cause.message : String(cause)
      });
    });
    try { attempt.child?.kill("SIGTERM"); } catch { /* already exited */ }
    attempt.cleanupOperation = (async () => {
      await attempt.allocation?.catch(() => undefined);
      const tempDir = attempt.tempDir;
      attempt.tempDir = null;
      if (!options.preserveTempDir) await removeRecorderOwnedTempDir(tempDir);
      await cameraCleanup;
    })();
    return attempt.cleanupOperation;
  }
}

class NativeRecorderService extends AttemptRecorderService {
  protected resolveBinary(): string | null { return resolveRecorderBinary(); }
  protected unavailableMessage(): string {
    return "native recorder binary not available — Fast Video Capture requires macOS 13+ and the bundled PwrSnapRecorder helper";
  }

  protected async startRecorder(attempt: RecordingAttempt, binary: string): Promise<void> {
    try {
      const info = statSync(binary);
      log.info("recorder binary", { path: binary, mtime: info.mtime.toISOString(), sizeBytes: info.size });
    } catch { /* diagnostic only */ }
    // Native preparation overlaps the countdown; captureAtMs controls when
    // Swift actually starts ScreenCaptureKit. Exclude only the HUD renderer.
    attempt.startFailureCode = "recorder_spawn_failed";
    const child = spawn(binary, [], { stdio: ["pipe", "pipe", "pipe"] });
    attempt.child = child;
    attempt.startFailureCode = "recorder_start_failed";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (this.owns(attempt)) this.consumeStdout(attempt, chunk);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      log.warn("recorder stderr", { sessionId: attempt.sessionId, chunk: chunk.trim() });
    });
    child.on("error", (cause) => {
      if (!this.owns(attempt) || attempt.cancelled) return;
      if (attempt.phase === "starting") {
        attempt.startFailureCode = "recorder_spawn_failed";
        attempt.started.reject(cause);
      } else if (attempt.phase === "stopping") {
        attempt.stopped.reject(cause);
      } else if (attempt.phase === "recording") {
        void this.fail(attempt, "recorder_exited", cause, { preserveTempDir: true });
      }
    });
    child.on("exit", (code, signal) => {
      log.info("recorder exited", { sessionId: attempt.sessionId, code, signal });
      attempt.exit = { code, signal };
      attempt.exited.resolve(attempt.exit);
      if (!this.owns(attempt) || attempt.cancelled) return;
      if (attempt.phase === "starting" && !attempt.startAcknowledged) {
        attempt.started.reject(new Error(`recorder exited before start ack (code=${code})`));
      } else if (attempt.phase === "recording" || attempt.phase === "starting") {
        void this.fail(attempt, "recorder_exited",
          new Error(`recorder exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "null"})`),
          { preserveTempDir: true });
      }
      // exit can precede the last stdout data. While stopping, wait for the
      // stopped line or stream close, bounded by stopRecorder's deadline.
    });
    child.on("close", (code, signal) => {
      if (this.owns(attempt) && attempt.phase === "stopping" && !attempt.stopAcknowledged) {
        attempt.stopped.reject(new Error(`recorder closed without stop ack (code=${code}, signal=${signal})`));
      }
    });

    let cameraPreview: ReturnType<typeof prepareCameraPreview>;
    try { cameraPreview = prepareCameraPreview(attempt.displayId, attempt.rect); }
    catch (cause) {
      confirmCameraPreviewExclusion(false);
      log.warn("camera preview unavailable; recording remains hidden", {
        message: cause instanceof Error ? cause.message : String(cause)
      });
    }
    const options = attempt.options;
    child.stdin.write(JSON.stringify({
      type: "start", displayId: attempt.displayId, rect: attempt.rect,
      outputPath: attempt.outputPath,
      systemAudio: options.capabilities.systemAudio,
      microphone: options.capabilities.microphone,
      ...(options.capabilities.microphone && options.capabilities.microphoneDevice !== undefined
        ? { microphoneDevice: options.capabilities.microphoneDevice.label } : {}),
      showsCursor: options.captureCursor,
      captureAtMs: Date.now() + options.countdownSeconds * 1000,
      excludePids: collectOurPids(), cameraPreview
    }) + "\n");
    await this.countdown(attempt);
    await withDeadline(attempt.wait(attempt.started.promise), 15_000, "recorder_start_timeout");
    attempt.startedAtMs = Date.now();
  }

  protected requestStop(attempt: RecordingAttempt): void {
    attempt.child!.stdin.write(JSON.stringify({ type: "stop" }) + "\n");
  }

  protected cancelAcknowledgement(attempt: RecordingAttempt): Promise<unknown> {
    return Promise.race([attempt.stopped.promise, attempt.exited.promise]);
  }

  protected async stopRecorder(attempt: RecordingAttempt): Promise<RecorderStoppedEvent> {
    this.requestStop(attempt);
    try {
      return await withDeadline(attempt.stopped.promise, 10_000, "recorder_stop_timeout");
    } catch (cause) {
      if (attempt.exit !== null && !attempt.stopAcknowledged) {
        throw new Error(`recorder exited without stop ack (code=${attempt.exit.code}, signal=${attempt.exit.signal})`);
      }
      throw cause;
    }
  }

  private consumeStdout(attempt: RecordingAttempt, chunk: string): void {
    attempt.inboundBuffer += chunk;
    let nl: number;
    while (this.owns(attempt) && (nl = attempt.inboundBuffer.indexOf("\n")) !== -1) {
      const line = attempt.inboundBuffer.slice(0, nl).trim();
      attempt.inboundBuffer = attempt.inboundBuffer.slice(nl + 1);
      if (!line) continue;
      let parsed: RecorderEvent;
      try { parsed = JSON.parse(line) as RecorderEvent; }
      catch {
        log.warn("recorder produced unparseable line", { line });
        continue;
      }
      // A cancelled attempt may acknowledge discard, but cannot touch the
      // process-global camera or settle startup successfully.
      if (attempt.cancelled && parsed.event !== "stopped") continue;
      switch (parsed.event) {
        case "timeline":
          if (parsed.utcTimeMs !== undefined) markCameraScreenStartUtc(parsed.utcTimeMs);
          break;
        case "cameraPreview":
          confirmCameraPreviewExclusion(parsed.excluded === true);
          break;
        case "started":
          if (!attempt.startAcknowledged) {
            attempt.startAcknowledged = true;
            markCameraScreenStart();
            attempt.started.resolve();
          }
          break;
        case "stopped":
          attempt.stopAcknowledged = true;
          attempt.stopped.resolve(parsed);
          break;
        case "error": {
          const cause = new NativeRecorderError(parsed.code, parsed.message);
          if (attempt.phase === "starting") attempt.started.reject(cause);
          else if (attempt.phase === "stopping") attempt.stopped.reject(cause);
          else if (attempt.phase === "recording") {
            void this.fail(attempt, "recorder_exited", cause, { preserveTempDir: true });
          }
          break;
        }
      }
    }
  }
}

type PersistStoppedRecordingInput = {
  outputPath: string;
  durationSec: number;
  containerFormat: "mp4" | "mov";
  hasSystemAudio: boolean;
  hasMicrophoneAudio: boolean;
  requestedSystemAudio: boolean;
  requestedMicrophone: boolean;
  subject: RecordingSubject;
  sourceWindowTitle: string | null;
  /** Runs immediately after the source move is durable, before stat/DB work. */
  onSourceAdopted?: () => Promise<void>;
};

async function persistStoppedRecording(stopped: PersistStoppedRecordingInput): Promise<{ captureId: string }> {
  // These own separate finalized inputs. Drain both even on failure before
  // lifecycle cleanup can close the camera or release the recorder's temp dir.
  // File-sized screen reads must not hold up screenshots or root switches.
  const [cameraResult, sourceResult] = await Promise.allSettled([
    finishCameraRecording(),
    prepareExistingFileAsSource(stopped.outputPath)
  ]);
  if (cameraResult.status === "rejected") throw cameraResult.reason;
  if (sourceResult.status === "rejected") throw sourceResult.reason;
  const camera = cameraResult.value;
  const stored = await runWithCapturesDirFallback((outputDir) =>
    adoptExistingFileAsSource(sourceResult.value, outputDir)
  );
  const cameraMetadata = camera ? await camera.adopt(stored.srcPath, stored.id) : null;
  await stopped.onSourceAdopted?.();
  const sizeInfo = await statSource(stored.srcPath);
  const subject = stopped.subject;
  const rect = subjectToPhysicalRect(subject);

  const sourceAppBundleId =
    subject.kind === "window" ? subject.appBundleId ?? null : null;
  const sourceAppName =
    subject.kind === "window" ? subject.appName ?? null : null;
  const { record } = insertCapture({
    id: stored.id,
    kind: "video",
    captured_at: new Date().toISOString(),
    source_app_bundle_id: sourceAppBundleId,
    source_app_name: sourceAppName,
    source_window_title: stopped.sourceWindowTitle,
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
    requestedSystemAudio: stopped.requestedSystemAudio,
    requestedMicrophone: stopped.requestedMicrophone,
    subject
  });
  if (cameraMetadata) setVideoCamera(record.id, cameraMetadata);
  try {
    await renameVideoSourceToEffectiveFilename(record.id);
  } catch (cause) {
    log.warn("recording source rename skipped", {
      captureId: record.id,
      message: cause instanceof Error ? cause.message : String(cause)
    });
  }

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

class WindowsFfmpegRecorderService extends AttemptRecorderService {
  protected resolveBinary(): string | null { return resolveFfmpegPath(); }
  protected unavailableMessage(): string {
    return "ffmpeg_not_available: Windows video recording requires PwrSnapFFmpeg.exe in the packaged app, or PWRSNAP_FFMPEG_PATH / ffmpeg.exe on PATH in development.";
  }
  protected override recordedCapabilities(attempt: RecordingAttempt): RecordingCapabilities {
    return { ...attempt.options.capabilities, systemAudio: false, microphone: false };
  }

  protected async startRecorder(attempt: RecordingAttempt, ffmpeg: string): Promise<void> {
    const options = attempt.options;
    if (options.capabilities.microphone || options.capabilities.systemAudio) {
      log.warn("Windows recording currently captures screen video only; audio toggles ignored", {
        microphone: options.capabilities.microphone, systemAudio: options.capabilities.systemAudio
      });
    }
    const captureRect = subjectToWindowsDesktopRect(options.subject);
    const capturePlan = planWindowsFfmpegCapture({
      rect: captureRect, outputPath: attempt.outputPath,
      captureCursor: options.captureCursor, cameraSync: options.capabilities.camera !== undefined
    });
    await this.countdown(attempt);
    // A starting-state observer can cancel before this continuation resumes.
    this.assertStarting(attempt);
    log.info("starting Windows ffmpeg recorder", {
      ffmpeg, captureRect, outputPath: attempt.outputPath,
      captureCursor: capturePlan.effectiveCaptureCursor
    });
    attempt.startFailureCode = "recorder_spawn_failed";
    const child = spawn(ffmpeg, capturePlan.args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    attempt.child = child;
    attempt.startedAtMs = Date.now();
    markCameraScreenStart();
    const utcToHostMs = Number(process.hrtime.bigint()) / 1e6 - Date.now();
    let cameraSyncBanner = options.capabilities.camera ? "" : null;
    child.on("exit", (code, signal) => {
      log.info("Windows ffmpeg recorder exited", { code, signal });
      attempt.exit = { code, signal };
      attempt.exited.resolve(attempt.exit);
      if (!this.owns(attempt) || attempt.cancelled) return;
      if (attempt.phase === "recording" || attempt.phase === "starting") {
        void this.fail(attempt, "recorder_exited",
          windowsFfmpegFailureMessage(attempt.stderrTail, code, signal), { preserveTempDir: true });
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (!this.owns(attempt) || attempt.cancelled) return;
      if (cameraSyncBanner !== null) {
        cameraSyncBanner = (cameraSyncBanner + chunk).slice(-8192);
        const utcMs = windowsCaptureStartUtcMs(cameraSyncBanner);
        if (utcMs !== null) {
          markCameraScreenStart(utcMs + utcToHostMs);
          attempt.startedAtMs = utcMs;
          cameraSyncBanner = null;
        }
      }
      const trimmed = chunk.trim();
      if (trimmed) {
        attempt.stderrTail.push(trimmed);
        if (attempt.stderrTail.length > 8) attempt.stderrTail.shift();
      }
      log.warn("Windows ffmpeg recorder stderr", { chunk: trimmed });
    });
    child.stdout.setEncoding("utf8");
    child.on("error", (cause) => {
      if (!this.owns(attempt) || attempt.cancelled) return;
      if (attempt.phase === "stopping") attempt.exited.reject(cause);
      else if (attempt.phase === "recording" || attempt.phase === "starting") {
        void this.fail(attempt, "recorder_spawn_failed", cause, { preserveTempDir: true });
      }
    });
  }

  protected requestStop(attempt: RecordingAttempt): void { attempt.child!.stdin.write("q"); }
  protected cancelAcknowledgement(attempt: RecordingAttempt): Promise<unknown> { return attempt.exited.promise; }

  protected async stopRecorder(attempt: RecordingAttempt): Promise<RecorderStoppedEvent> {
    try { this.requestStop(attempt); } catch { /* exit/deadline decides the outcome */ }
    let exit = await waitForWindowsFfmpegExit(attempt.exited.promise, 5_000);
    if (exit === null) {
      try { attempt.child!.kill("SIGTERM"); } catch { /* best effort */ }
      exit = await waitForWindowsFfmpegExit(attempt.exited.promise, 5_000);
    }
    if (exit === null) throw new Error("recorder_stop_timeout");
    if (exit.code !== 0 || exit.signal !== null) {
      throw new Error(windowsFfmpegFailureMessage(attempt.stderrTail, exit.code, exit.signal));
    }
    return {
      event: "stopped", outputPath: attempt.outputPath,
      durationSec: Math.max(0.1, (Date.now() - attempt.startedAtMs) / 1000),
      containerFormat: "mp4", hasSystemAudio: false, hasMicrophoneAudio: false
    };
  }
}

async function waitForWindowsFfmpegExit(exitPromise: Promise<RecorderExit>, timeoutMs: number): Promise<RecorderExit | null> {
  try {
    return await withDeadline(exitPromise, timeoutMs, "ffmpeg_exit_timeout");
  } catch (cause) {
    if (cause instanceof Error && cause.message === "ffmpeg_exit_timeout") return null;
    throw cause;
  }
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
 * (the convention the region selector RESOLVES to — its renderer
 * reports display-local, then `region-selector.ts` adds
 * `display.bounds.{x,y}` when it builds `SelectorResult`) into
 * DISPLAY-LOCAL logical coords (what both the recording-controller
 * HUD and the Swift recorder's `sourceRect` actually want).
 *
 * Without this translation, multi-monitor setups where the
 * recorded display has a non-zero origin (e.g. a 2560×1440
 * secondary at `bounds.x=1496, bounds.y=-473`) double-position the
 * HUD by `display.bounds` (controller adds it again in `fillRect`)
 * AND mis-aim the recorder (ScreenCaptureKit's `sourceRect` is
 * relative to the captured display, not the virtual desktop). The
 * bug is invisible on single-display setups where `bounds.{x,y}`
 * are zero.
 *
 * The arithmetic itself lives in `globalRectToDisplayLocal`; the
 * canonical write-up of the hazard is the coordinate-space note at
 * the head of capture/rect-overlap.ts. Note that converter keeps this
 * function's original unknown-display behavior (rect unchanged) — see
 * its doc for why that differs from the overlap helper's.
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
      return globalRectToDisplayLocal(subject.rect, subject.displayId);
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

/** Attach selector provenance without exposing it on recording:start IPC. */
export function attachTrustedRecordingWindowIdentity(
  sessionId: string,
  identity: TrustedRecordingWindowIdentity
): boolean {
  return getRecordingService().attachTrustedWindowIdentity?.(sessionId, identity) ?? false;
}

/** Test seam: swap the recorder for a stub between specs. */
export function __setRecordingServiceForTests(service: RecordingService | null): void {
  activeService = service;
}
