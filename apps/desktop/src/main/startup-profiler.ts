// Startup profiling harness. Every export is a no-op unless the app was
// launched with PWRSNAP_STARTUP_PROFILE=1, so the wiring is safe to keep
// in production builds.
//
// Artifacts land in PWRSNAP_STARTUP_PROFILE_DIR (default:
// <os tmpdir>/pwrsnap-startup-profile-<pid>):
//
//   main.cpuprofile               main-process CPU profile, sampling from
//                                 the first line of the main bundle (see
//                                 startup-profile-boot.ts) for
//                                 PWRSNAP_STARTUP_PROFILE_DURATION_MS
//                                 (default 15s).
//   main.heapsnapshot             main-process JS heap at profile stop.
//   renderer-<label>.cpuprofile   renderer CPU profile from BrowserWindow
//                                 construction, same duration.
//   renderer-<label>.heapsnapshot renderer JS heap after its profile stops.
//   startup-marks.json            ms-relative milestones: window shown,
//                                 page lifecycle paints, per-command bus
//                                 timings, protocol fetch timings.
//
// Open .cpuprofile in Chrome DevTools (Performance → load) or
// https://speedscope.app; .heapsnapshot in DevTools → Memory.

import { mkdirSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeHeapSnapshot } from "node:v8";
import type { BrowserWindow } from "electron";

const ENABLED = process.env.PWRSNAP_STARTUP_PROFILE === "1";

const PROFILE_DURATION_MS = (() => {
  const raw = Number(process.env.PWRSNAP_STARTUP_PROFILE_DURATION_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 15_000;
})();

/** Sampling interval in µs; 200µs matches DevTools' default fidelity. */
const SAMPLING_INTERVAL_US = 200;

/** Hard cap so a long-lived profiled session can't grow marks unboundedly. */
const MAX_MARKS = 2_000;

const t0 = Date.now();

let resolvedDir: string | null = null;
function outDir(): string {
  if (resolvedDir === null) {
    resolvedDir =
      process.env.PWRSNAP_STARTUP_PROFILE_DIR ??
      join(tmpdir(), `pwrsnap-startup-profile-${process.pid}`);
    mkdirSync(resolvedDir, { recursive: true });
  }
  return resolvedDir;
}

export function startupProfilingEnabled(): boolean {
  return ENABLED;
}

type StartupMark = { tMs: number; label: string };
const marks: StartupMark[] = [];

/**
 * Record a named startup milestone (ms relative to main-bundle eval).
 * No-op unless profiling is enabled. Callers on hot paths should guard
 * any label-string construction behind `startupProfilingEnabled()`.
 */
export function markStartup(label: string): void {
  if (!ENABLED) return;
  if (marks.length >= MAX_MARKS) return;
  const tMs = Date.now() - t0;
  marks.push({ tMs, label });
  // Straight to stdout on purpose — marks must be visible even before
  // the electron-log transports initialize.
  // eslint-disable-next-line no-console
  console.log(`[startup-profile] +${tMs}ms ${label}`);
}

function flushMarks(): void {
  writeFileSync(join(outDir(), "startup-marks.json"), JSON.stringify(marks, null, 2));
}

let mainSession: Session | null = null;

/**
 * Begin the main-process CPU profile. Called from startup-profile-boot.ts
 * at module-eval time so evaluation of the rest of the bundle is part of
 * the profile. Stops, writes main.cpuprofile + main.heapsnapshot, and
 * flushes marks PROFILE_DURATION_MS later.
 */
export function beginMainProcessProfile(): void {
  if (!ENABLED || mainSession !== null) return;
  const session = new Session();
  session.connect();
  session.post("Profiler.enable");
  session.post("Profiler.setSamplingInterval", { interval: SAMPLING_INTERVAL_US });
  session.post("Profiler.start");
  mainSession = session;
  markStartup("main: cpu profile started");
  // unref so profiling never keeps a quick-exit path (seeder CLI,
  // lost single-instance lock) alive.
  setTimeout(stopMainProcessProfile, PROFILE_DURATION_MS).unref();
}

function stopMainProcessProfile(): void {
  const session = mainSession;
  if (session === null) return;
  mainSession = null;
  session.post("Profiler.stop", (error, params) => {
    try {
      if (error !== null) {
        markStartup(`main: cpu profile failed: ${error.message}`);
      } else {
        const file = join(outDir(), "main.cpuprofile");
        writeFileSync(file, JSON.stringify(params.profile));
        markStartup(`main: cpu profile written → ${file}`);
      }
      const heapFile = writeHeapSnapshot(join(outDir(), "main.heapsnapshot"));
      markStartup(`main: heap snapshot written → ${heapFile}`);
    } catch (cause) {
      markStartup(
        `main: profile write failed: ${cause instanceof Error ? cause.message : String(cause)}`
      );
    } finally {
      session.disconnect();
      flushMarks();
    }
  });
}

/**
 * Attach a CDP session to `window` and capture a renderer CPU profile +
 * heap snapshot covering its startup, plus page lifecycle marks
 * (firstPaint / firstContentfulPaint / networkIdle…). Call immediately
 * after constructing the BrowserWindow, BEFORE loadURL/loadFile, so
 * script evaluation is captured. No-op unless profiling is enabled.
 */
export function attachRendererStartupProfiling(window: BrowserWindow, label: string): void {
  if (!ENABLED) return;
  const wc = window.webContents;
  const dbg = wc.debugger;
  try {
    dbg.attach("1.3");
  } catch (cause) {
    markStartup(
      `renderer(${label}): debugger attach failed: ${
        cause instanceof Error ? cause.message : String(cause)
      }`
    );
    return;
  }

  let stopped = false;

  dbg.on("message", (_event, method, params) => {
    if (method === "Page.lifecycleEvent") {
      const name = (params as { name?: string }).name ?? "?";
      markStartup(`renderer(${label}): lifecycle ${name}`);
    }
  });

  const arm = async (): Promise<void> => {
    if (stopped) return;
    try {
      await dbg.sendCommand("Page.enable");
      await dbg.sendCommand("Page.setLifecycleEventsEnabled", { enabled: true });
      await dbg.sendCommand("Profiler.enable");
      await dbg.sendCommand("Profiler.setSamplingInterval", {
        interval: SAMPLING_INTERVAL_US
      });
      await dbg.sendCommand("Profiler.start");
      markStartup(`renderer(${label}): cpu profile started`);
    } catch (cause) {
      // Re-arms race a profiler that's already running — "already
      // started" here is expected noise, not a failure.
      markStartup(
        `renderer(${label}): profiler arm skipped: ${
          cause instanceof Error ? cause.message : String(cause)
        }`
      );
    }
  };

  void arm();

  // A cross-process navigation (the first real load can swap renderer
  // processes) silently drops profiler state — re-arm on every
  // main-frame navigation. When the process did NOT swap, the second
  // Profiler.start throws and arm() ignores it.
  wc.on("did-frame-navigate", (_event, _url, _code, _status, isMainFrame) => {
    if (isMainFrame) void arm();
  });

  setTimeout(() => {
    void (async () => {
      stopped = true;
      if (wc.isDestroyed()) return;
      try {
        const { profile } = (await dbg.sendCommand("Profiler.stop")) as { profile: unknown };
        const file = join(outDir(), `renderer-${label}.cpuprofile`);
        writeFileSync(file, JSON.stringify(profile));
        markStartup(`renderer(${label}): cpu profile written → ${file}`);
      } catch (cause) {
        markStartup(
          `renderer(${label}): cpu profile failed: ${
            cause instanceof Error ? cause.message : String(cause)
          }`
        );
      }
      try {
        dbg.detach();
      } catch {
        // already detached (window closing) — nothing to clean up
      }
      try {
        const heapFile = join(outDir(), `renderer-${label}.heapsnapshot`);
        await wc.takeHeapSnapshot(heapFile);
        markStartup(`renderer(${label}): heap snapshot written → ${heapFile}`);
      } catch (cause) {
        markStartup(
          `renderer(${label}): heap snapshot failed: ${
            cause instanceof Error ? cause.message : String(cause)
          }`
        );
      }
      flushMarks();
    })();
  }, PROFILE_DURATION_MS).unref();
}
