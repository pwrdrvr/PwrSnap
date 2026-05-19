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
  RecordingSubject
} from "@pwrsnap/shared";
import { getMainLogger } from "../log";
import { setFloatOverState } from "../float-over";
import { broadcastCapturesChanged } from "../events";
import { maybeEnqueueCaptureEnrichment } from "../handlers/codex-handlers";
import { getCaptureById, insertOrFindCapture } from "../persistence/captures-repo";
import {
  adoptExistingFileAsSource,
  statSource
} from "../persistence/source-store";
import { insertVideoMetadata } from "../persistence/video-repo";
import { getRecordingControllerPid } from "./recording-controller";
import {
  isRecordingActive,
  setRecordingState
} from "./recording-state";

const log = getMainLogger("pwrsnap:recording-service");

export type StartOptions = {
  subject: RecordingSubject;
  capabilities: RecordingCapabilities;
  countdownSeconds: number;
};

export type RecordingService = {
  start(opts: StartOptions): Promise<{ sessionId: string }>;
  stop(): Promise<{ captureId: string }>;
  cancel(): Promise<void>;
  /** Discard the in-flight session and immediately start a fresh
   *  one with the same subject + capabilities. Throws
   *  `not_recording` if no session is active. */
  restart(): Promise<{ sessionId: string }>;
  /** True when this service has an active session. Used by the
   *  app-quit hook to cancel before exit. */
  isActive(): boolean;
};

let activeService: RecordingService | null = null;

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
  private outputPath: string | null = null;
  private startedPromise: Promise<void> | null = null;
  private stoppedPromise: Promise<RecorderStoppedEvent> | null = null;
  private startResolve: (() => void) | null = null;
  private startReject: ((err: Error) => void) | null = null;
  private stopResolve: ((evt: RecorderStoppedEvent) => void) | null = null;
  private stopReject: ((err: Error) => void) | null = null;
  private inboundBuffer = "";

  isActive(): boolean {
    return this.child !== null && this.sessionId !== null;
  }

  async start(opts: StartOptions): Promise<{ sessionId: string }> {
    if (isRecordingActive() || this.child !== null) {
      throw new Error("already_recording");
    }
    const binary = resolveRecorderBinary();
    if (binary === null) {
      throw new Error(
        "native recorder binary not available — Fast Video Capture requires macOS 13+ and the bundled PwrSnapRecorder helper"
      );
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
    const sessionId = nanoid(12);
    const tmpDir = await mkdtemp(join(tmpdir(), "pwrsnap-recording-"));
    const outputPath = join(tmpDir, `${sessionId}.mp4`);

    this.sessionId = sessionId;
    this.subject = opts.subject;
    this.capabilities = opts.capabilities;
    this.outputPath = outputPath;

    const physicalRect = subjectToPhysicalRect(opts.subject);
    const displayId = subjectDisplayId(opts.subject);

    setRecordingState({ phase: "preflight", sessionId, rect: physicalRect, displayId });

    // Spawn the recorder IMMEDIATELY (parallel with the countdown).
    // The Swift recorder's first call to SCShareableContent can take
    // 3–5s on a cold launch (the OS enumerates all on-screen windows
    // + applications). If we waited for the countdown to finish
    // before spawning, the user would see "1" frozen for that whole
    // cold-load period. Overlapping the spawn + setup with the
    // visible countdown hides the cost.
    const child = spawn(binary, [], { stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;

    this.startedPromise = new Promise<void>((resolve, reject) => {
      this.startResolve = resolve;
      this.startReject = reject;
    });
    this.stoppedPromise = new Promise<RecorderStoppedEvent>((resolve, reject) => {
      this.stopResolve = resolve;
      this.stopReject = reject;
    });
    // Suppress UnhandledPromiseRejection if cancel happens mid-
    // countdown: we throw "cancelled" before getting to
    // `await this.startedPromise`, and the subsequent child.kill
    // makes `child.on("exit")` fire `startReject` on a promise no
    // one is awaiting anymore. The no-op catch keeps the rejection
    // observed without affecting the awaiter (since Promise rejection
    // handlers don't cancel each other — the original awaiter still
    // sees the rejection).
    this.startedPromise.catch(() => undefined);
    this.stoppedPromise.catch(() => undefined);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.consumeStdout(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      log.warn("recorder stderr", { chunk: chunk.trim() });
    });
    child.on("exit", (code, signal) => {
      log.info("recorder exited", { code, signal });
      if (this.startReject !== null && this.startedPromise !== null) {
        this.startReject(new Error(`recorder exited before start ack (code=${code})`));
      }
    });

    // Send the start command with a wall-clock target so the
    // recorder begins capturing AT countdownSeconds from now,
    // regardless of how long Swift's own setup took. The Swift
    // binary does setup as fast as it can, then waits until
    // captureAtMs before calling startCapture().
    //
    // `excludePids` is the recording-controller HUD's renderer PID
    // (when known). Swift filters SCRunningApplication by this PID
    // so the captured pixels never contain our countdown overlay or
    // Stop/Restart/Cancel pill. See collectOurPids() for why we
    // narrowed this to JUST the HUD instead of every PwrSnap PID.
    const captureAtMs = Date.now() + opts.countdownSeconds * 1000;
    const excludePids = collectOurPids();
    child.stdin.write(
      JSON.stringify({
        type: "start",
        displayId,
        rect: physicalRect,
        outputPath,
        systemAudio: opts.capabilities.systemAudio,
        microphone: opts.capabilities.microphone,
        captureAtMs,
        excludePids
      }) + "\n"
    );

    // Render the visible countdown in parallel with Swift's setup.
    //
    // CRITICAL: `cancel()` runs concurrently if the user hits Cancel
    // mid-countdown. It sets `this.sessionId = null` (via cleanup)
    // and resets recording-state to idle. Without the early-exit
    // check below, this loop's next iteration would dispatch
    // `setRecordingState({ phase: "countdown", ... })` AGAIN after
    // the user cancelled — the HUD would flicker back up for a
    // second. The `this.sessionId !== sessionId` check catches that
    // race: each iteration verifies the captured `sessionId` is
    // still the active session and bails immediately if not.
    if (opts.countdownSeconds > 0) {
      for (let n = opts.countdownSeconds; n > 0; n--) {
        if (this.sessionId !== sessionId) {
          throw new Error("cancelled");
        }
        setRecordingState({
          phase: "countdown",
          sessionId,
          secondsRemaining: n,
          rect: physicalRect,
          displayId
        });
        await new Promise((r) => setTimeout(r, 1_000));
      }
      if (this.sessionId !== sessionId) {
        throw new Error("cancelled");
      }
    }

    // Countdown done. If the recorder isn't ready yet (cold-launch
    // SCShareableContent etc. taking longer than the countdown), the
    // HUD switches to a `starting` indicator so the user knows we're
    // still working rather than stuck. The timeout is generous —
    // 15s — but bounded, so a wedged Swift process can't trap the
    // app in a permanent non-idle state.
    setRecordingState({ phase: "starting", sessionId, rect: physicalRect, displayId });
    try {
      await Promise.race([
        this.startedPromise,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("recorder_start_timeout")), 15_000)
        )
      ]);
    } catch (cause) {
      // Recorder failed to ack `started`. Kill it, clean up state,
      // and rethrow so the caller can surface a typed error.
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      const message = cause instanceof Error ? cause.message : String(cause);
      this.cleanup();
      setRecordingState({
        phase: "failed",
        sessionId,
        code: "recorder_start_failed",
        message
      });
      // Settle back to idle a moment after the failure surfaces so
      // the HUD vanishes and the tray clears its REC indicator.
      setTimeout(() => {
        // Only revert if no new session has started in the meantime.
        if (!this.isActive()) setRecordingState({ phase: "idle" });
      }, 1_500);
      throw cause;
    }

    setRecordingState({
      phase: "recording",
      sessionId,
      startedAt: new Date().toISOString(),
      rect: physicalRect,
      displayId
    });
    return { sessionId };
  }

  async stop(): Promise<{ captureId: string }> {
    if (this.child === null || this.sessionId === null) {
      throw new Error("no_active_recording");
    }
    const sessionId = this.sessionId;
    setRecordingState({ phase: "stopping", sessionId });
    this.child.stdin.write(JSON.stringify({ type: "stop" }) + "\n");
    let stopped: RecorderStoppedEvent;
    try {
      stopped = await this.stoppedPromise!;
    } catch (cause) {
      this.cleanup();
      setRecordingState({
        phase: "failed",
        sessionId,
        code: "stop_failed",
        message: cause instanceof Error ? cause.message : String(cause)
      });
      throw cause;
    }
    setRecordingState({ phase: "processing", sessionId });

    // Adopt the file into the source store + record the metadata row.
    const stored = await adoptExistingFileAsSource(stopped.outputPath);
    const sizeInfo = await statSource(stored.srcPath);
    const subject = this.subject!;
    const rect = subjectToPhysicalRect(subject);

    // Pull source-app metadata off the window subject when present.
    // Image captures populate the same two columns from a
    // CaptureSource resolved at handler time; matching that lets the
    // Library's "Microsoft Edge" badge work uniformly across image
    // and video rows. Region/display subjects don't have a single
    // source app — leave the fields null and the Library renders
    // "Unknown App" the same way it does for image region captures.
    const sourceAppBundleId =
      subject.kind === "window" ? subject.appBundleId ?? null : null;
    const sourceAppName =
      subject.kind === "window" ? subject.appName ?? null : null;

    const { record, isNew } = insertOrFindCapture({
      id: stored.id,
      kind: "video",
      captured_at: new Date().toISOString(),
      source_app_bundle_id: sourceAppBundleId,
      source_app_name: sourceAppName,
      src_path: stored.srcPath,
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
      subject
    });

    // Re-read through getCaptureById so the record we ship to the
    // float-over has `record.video` populated. `insertOrFindCapture`
    // returns a bare row (rowToRecord defaults video to null), and
    // FloatOverHost's `record.video !== null` branch falls through
    // to the image FloatOver when null — silently producing the
    // "video doesn't show in the popover" bug we hit earlier.
    const hydrated = getCaptureById(record.id) ?? record;

    broadcastCapturesChanged([record.id]);
    setFloatOverState({ kind: "show-loaded", captureId: record.id, record: hydrated });
    setRecordingState({ phase: "ready", sessionId, captureId: record.id });
    if (isNew) {
      maybeEnqueueCaptureEnrichment(record.id);
    }
    // Best-effort system notification — not every platform / build
    // supports Notification.isSupported(), so fail open if it
    // doesn't. Mirrors the existing post-capture toast pattern.
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

    this.cleanup();
    return { captureId: record.id };
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
    await this.cancel();
    return this.start({ subject, capabilities, countdownSeconds: 3 });
  }

  async cancel(): Promise<void> {
    // ALWAYS reset state on cancel — even if the internal session
    // bookkeeping is wedged (e.g. spawn raced with another action
    // and left the controller showing the countdown HUD with no
    // active child). The user invoking Cancel from the tray expects
    // the HUD to vanish regardless. Without this unconditional
    // reset the only escape from a stuck countdown was to quit the
    // app, which is exactly the bug the prior version hit.
    const sessionId = this.sessionId;
    const child = this.child;
    if (child !== null) {
      try {
        // Best-effort: send stop and discard the output. If the
        // binary hung, kill it directly.
        child.stdin.write(JSON.stringify({ type: "stop" }) + "\n");
        await Promise.race([
          this.stoppedPromise,
          new Promise((resolve) => setTimeout(resolve, 500))
        ]);
      } catch {
        /* ignore */
      }
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    }
    this.cleanup();
    setRecordingState({ phase: "idle" });
    log.info("recording cancelled", { sessionId });
  }

  private consumeStdout(chunk: string): void {
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
            this.startReject(err);
            this.startReject = null;
            this.startResolve = null;
          } else if (this.stopReject !== null) {
            this.stopReject(err);
            this.stopReject = null;
            this.stopResolve = null;
          } else {
            log.warn("recorder error after lifecycle", { code: parsed.code, message: parsed.message });
          }
          break;
        }
      }
    }
  }

  private cleanup(): void {
    // Defense in depth: the Swift recorder is supposed to exit on
    // its own after `stop` (or after we kill it on cancel/timeout),
    // but bugs in the Swift side could leave the process alive with
    // its SCStream still attached to the ScreenCaptureKit daemon.
    // The NEXT recording in the same Electron PID would then trip
    // -3805 ("application connection interrupted") because the
    // daemon revokes the stale stream's connection the instant a
    // new one registers. Sending SIGTERM here is a no-op if Swift
    // already exited (the child reference is from before exit) and
    // a guaranteed kill if it hasn't.
    const child = this.child;
    if (child !== null) {
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore — child may already be gone */
      }
    }
    this.child = null;
    this.sessionId = null;
    this.subject = null;
    this.capabilities = null;
    this.outputPath = null;
    this.startedPromise = null;
    this.stoppedPromise = null;
    this.startResolve = null;
    this.startReject = null;
    this.stopResolve = null;
    this.stopReject = null;
    this.inboundBuffer = "";
  }
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
    activeService = new NativeRecorderService();
  }
  return activeService;
}

/** Test seam: swap the recorder for a stub between specs. */
export function __setRecordingServiceForTests(service: RecordingService | null): void {
  activeService = service;
}
