// On-demand multi-process Chrome trace recorder (`PWRSNAP_TRACE=1`).
//
// Why this exists: the hot-CPU harness can name the burning process but
// not explain it when that process is the GPU process — the GPU process
// runs no V8, so there is nothing to CPU-profile. `contentTracing`
// records the browser, GPU, and every renderer's trace-event stream into
// one Chrome trace, which is where compositor frame cadence, damage, and
// raster/draw/swap attribution actually live.
//
// Alongside the trace we sample `app.getAppMetrics()` into `cpu.ndjson`
// for the same window. Without that, a trace tells you what the GPU
// process DID but not what it COST, and the whole question here is cost.
//
// Triggers, in order of usefulness:
//   - `kill -USR2 <main pid>`     start (or stop early) a recording
//   - `PWRSNAP_TRACE_AUTOSTART_DELAY_MS=20000`  one-shot after boot
// SIGUSR2 is used because it is the one signal a foreground Electron
// dev run leaves alone (SIGINT/SIGTERM/SIGHUP are already owned by
// `terminal-signal-shutdown.ts`), and because it needs no UI — which
// matters when the whole point is to not perturb what is being measured.

import { app, contentTracing } from "electron";
import { getMainLogger } from "../log";
import { resolveContentTraceConfig, type ContentTraceConfig } from "./content-trace-config";
import { contentTraceDiagnosticsRoot } from "./content-trace-paths";
import {
  createContentTraceSession,
  type ContentTraceSession
} from "./content-trace-session";
import { ProcessCpuBreakdownTracker } from "./process-cpu-breakdown";

const CPU_SAMPLE_INTERVAL_MS = 1_000;

type RecorderState = {
  config: Extract<ContentTraceConfig, { enabled: true }>;
  session: ContentTraceSession | null;
  traceIndex: number;
  recording: boolean;
  stopTimer: NodeJS.Timeout | null;
  cpuTimer: NodeJS.Timeout | null;
  cpuTracker: ProcessCpuBreakdownTracker;
};

let state: RecorderState | null = null;

function log() {
  return getMainLogger("content-trace");
}

function versions(): {
  appVersion: string;
  electronVersion: string;
  chromeVersion: string;
  nodeVersion: string;
} {
  return {
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron ?? "unknown",
    chromeVersion: process.versions.chrome ?? "unknown",
    nodeVersion: process.versions.node
  };
}

async function ensureSession(current: RecorderState): Promise<ContentTraceSession | null> {
  if (current.session !== null) return current.session;
  const result = await createContentTraceSession({
    config: current.config,
    versions: versions()
  });
  if (!result.ok) {
    log().warn(result.message);
    return null;
  }
  current.session = result.session;
  log().info(`session ${result.session.directoryPath}`);
  return result.session;
}

/** Per-process CPU for the trace window, in the same cumulative-delta
 *  form the hot-CPU harness uses. Sampled into its own NDJSON rather
 *  than into the trace: the trace's own JSON is written by Chromium and
 *  is not ours to extend. */
function startCpuSampling(current: RecorderState, session: ContentTraceSession): void {
  current.cpuTracker.reset();
  const sample = (): void => {
    const sampledAtMs = Date.now();
    const processes = current.cpuTracker.sample(app.getAppMetrics(), sampledAtMs);
    void session
      .appendEvent({
        capturedAt: new Date(sampledAtMs).toISOString(),
        type: "cpu-sample",
        detail: { processes }
      })
      .catch(() => undefined);
  };
  sample();
  current.cpuTimer = setInterval(sample, CPU_SAMPLE_INTERVAL_MS);
  current.cpuTimer.unref();
}

function stopCpuSampling(current: RecorderState): void {
  if (current.cpuTimer !== null) {
    clearInterval(current.cpuTimer);
    current.cpuTimer = null;
  }
}

export async function startContentTrace(reason: string): Promise<void> {
  const current = state;
  if (current === null) return;
  if (current.recording) {
    log().info("already recording — ignoring start");
    return;
  }

  const session = await ensureSession(current);
  if (session === null) return;

  current.recording = true;
  current.traceIndex += 1;
  const index = current.traceIndex;

  try {
    await contentTracing.startRecording({
      included_categories: current.config.categories
    });
  } catch (error) {
    current.recording = false;
    log().warn(
      `startRecording failed: ${error instanceof Error ? error.message : String(error)}`
    );
    return;
  }

  await session.appendEvent({
    capturedAt: new Date().toISOString(),
    type: "trace-start",
    detail: {
      reason,
      index,
      categories: current.config.categories,
      durationMs: current.config.durationMs
    }
  });
  startCpuSampling(current, session);
  log().info(
    `recording ${current.config.durationMs}ms (reason=${reason}, index=${index})`
  );

  current.stopTimer = setTimeout(() => {
    void stopContentTrace("duration-elapsed");
  }, current.config.durationMs);
  current.stopTimer.unref();
}

export async function stopContentTrace(reason: string): Promise<string | null> {
  const current = state;
  if (current === null || !current.recording) return null;
  const session = current.session;
  if (session === null) return null;

  if (current.stopTimer !== null) {
    clearTimeout(current.stopTimer);
    current.stopTimer = null;
  }
  stopCpuSampling(current);
  current.recording = false;

  const tracePath = session.createTracePath(current.traceIndex);
  try {
    await contentTracing.stopRecording(tracePath);
  } catch (error) {
    log().warn(
      `stopRecording failed: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }

  const filename = tracePath.slice(session.directoryPath.length + 1);
  await session.registerArtifact(filename);
  await session.appendEvent({
    capturedAt: new Date().toISOString(),
    type: "trace-stop",
    detail: { reason, path: tracePath }
  });
  log().info(`wrote ${tracePath} (reason=${reason})`);
  return tracePath;
}

/** SIGUSR2 toggles: a second signal during a recording ends it early
 *  rather than being ignored, so a run can be cut short when the thing
 *  being reproduced stops happening. */
function handleToggleSignal(): void {
  if (state === null) return;
  if (state.recording) {
    void stopContentTrace("sigusr2");
    return;
  }
  void startContentTrace("sigusr2");
}

export function installContentTraceHook(options?: {
  env?: NodeJS.ProcessEnv;
  outputRoot?: string;
}): boolean {
  if (state !== null) return true;
  const config = resolveContentTraceConfig({
    ...(options?.env !== undefined ? { env: options.env } : {}),
    outputRoot: options?.outputRoot ?? contentTraceDiagnosticsRoot()
  });
  if (!config.enabled) return false;

  state = {
    config,
    session: null,
    traceIndex: 0,
    recording: false,
    stopTimer: null,
    cpuTimer: null,
    cpuTracker: new ProcessCpuBreakdownTracker()
  };

  process.on("SIGUSR2", handleToggleSignal);
  log().info(
    `armed (pid ${process.pid}) — "kill -USR2 ${process.pid}" to record ` +
      `${config.durationMs}ms into ${config.outputRoot}`
  );

  if (config.autoStartDelayMs > 0) {
    const timer = setTimeout(() => {
      void startContentTrace("autostart");
    }, config.autoStartDelayMs);
    timer.unref();
  }
  return true;
}

/** Test seam: drops the installed hook and its listener. */
export function resetContentTraceHookForTests(): void {
  if (state === null) return;
  if (state.stopTimer !== null) clearTimeout(state.stopTimer);
  stopCpuSampling(state);
  process.off("SIGUSR2", handleToggleSignal);
  state = null;
}
