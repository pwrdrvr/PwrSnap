import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { CaptureRecord, VideoCaptureMetadata, VideoExportResult } from "@pwrsnap/shared";
import type {
  ExportInput,
  VideoExportProgressObserver,
  VideoExportProgressUpdate
} from "../recording-exporter";

type FakeChildProcess = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
};

type SpawnCall = {
  command: string;
  args: string[];
  options: unknown;
  child: FakeChildProcess;
};

const spawnCalls: SpawnCall[] = [];
let cachedExport: VideoExportResult | null = null;
const existingPaths = new Set<string>();

function makeFakeChild(): FakeChildProcess {
  const child = new EventEmitter() as FakeChildProcess;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn(() => true);
  return child;
}

vi.mock("node:child_process", () => ({
  spawn: (command: string, args: string[], options: unknown): FakeChildProcess => {
    const child = makeFakeChild();
    spawnCalls.push({ command, args, options, child });
    return child;
  }
}));

vi.mock("node:fs", () => ({
  existsSync: (path: string) => existingPaths.has(path)
}));

vi.mock("node:fs/promises", () => ({
  mkdir: async () => undefined,
  rename: async (from: string, to: string) => {
    existingPaths.delete(from);
    existingPaths.add(to);
  },
  rm: async (path: string) => {
    existingPaths.delete(path);
  },
  stat: async () => ({ size: 12_345 })
}));

vi.mock("../ffmpeg-resolver", () => ({
  resolveFfmpegPath: () => "/usr/bin/ffmpeg-test"
}));

vi.mock("../../persistence/paths", () => ({
  getCacheRoot: () => "/tmp/pwrsnap-progress-test"
}));

vi.mock("../../persistence/video-repo", () => ({
  lookupExport: () => cachedExport,
  recordExport: vi.fn()
}));

const { exportVideoRange } = await import("../recording-exporter");

const video: VideoCaptureMetadata = {
  durationSec: 30,
  containerFormat: "mp4",
  hasSystemAudio: false,
  hasMicrophoneAudio: false,
  defaultRange: { start: 0, end: 30 },
  previewPath: null,
  previewStatus: "ready"
};

function record(id: string): CaptureRecord {
  return {
    id,
    kind: "video",
    captured_at: "2026-08-23T12:00:00.000Z",
    legacy_src_path: `/captures/${id}.mp4`,
    bundle_path: null,
    flat_png_path: null,
    bundle_modified_at: null,
    bundle_format_version: 1,
    bundle_edits_version: 0,
    width_px: 1_920,
    height_px: 1_080,
    device_pixel_ratio: 1,
    byte_size: 1_000,
    sha256: `sha-${id}`,
    edits_version: 0,
    source_app_bundle_id: null,
    source_app_name: null,
    deleted_at: null,
    app_id: null,
    title: null,
    description: null,
    filename: null,
    notes: null,
    rating: null,
    starred: 0,
    archived: 0,
    pinned: 0,
    video: null
  } as unknown as CaptureRecord;
}

function observer(
  runId: string,
  updates: VideoExportProgressUpdate[]
): VideoExportProgressObserver {
  return {
    runId,
    emit: (update) => updates.push(update)
  };
}

function input(options: {
  id: string;
  format?: "gif" | "mp4";
  range?: { start: number; end: number };
  runId?: string;
  updates?: VideoExportProgressUpdate[];
  signal?: AbortSignal;
}): ExportInput {
  const updates = options.updates ?? [];
  return {
    record: record(options.id),
    video,
    format: options.format ?? "mp4",
    preset: "med",
    range: options.range ?? { start: 0, end: 10 },
    audio: { includeSystemAudio: false, includeMicrophone: false },
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    ...(options.runId !== undefined
      ? { progress: observer(options.runId, updates) }
      : {})
  };
}

async function waitForSpawnCount(count: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (spawnCalls.length >= count) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`spawn count stayed at ${spawnCalls.length}; expected ${count}`);
}

function sendProgress(
  call: SpawnCall,
  outTimeSec: number,
  disposition: "continue" | "end" = "continue"
): void {
  call.child.stdout.emit(
    "data",
    Buffer.from(
      `out_time_us=${String(Math.round(outTimeSec * 1_000_000))}\nprogress=${disposition}\n`
    )
  );
}

function close(call: SpawnCall, code: number): void {
  call.child.emit("close", code);
}

function updatesForPhase(
  updates: readonly VideoExportProgressUpdate[],
  phase: VideoExportProgressUpdate["phase"]
): VideoExportProgressUpdate[] {
  return updates.filter((update) => update.phase === phase);
}

beforeEach(() => {
  spawnCalls.length = 0;
  cachedExport = null;
  existingPaths.clear();
  vi.useRealTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("recording exporter progress", () => {
  test("uses FFmpeg's machine progress flags and the selected trim duration", async () => {
    const updates: VideoExportProgressUpdate[] = [];
    const work = exportVideoRange(
      input({
        id: "mp4-trim",
        range: { start: 10, end: 14 },
        runId: "run-trim",
        updates
      })
    );

    await waitForSpawnCount(1);
    const call = spawnCalls[0]!;
    expect(call.command).toBe("/usr/bin/ffmpeg-test");
    expect(call.args.slice(0, 7)).toEqual([
      "-nostdin",
      "-hide_banner",
      "-nostats",
      "-stats_period",
      "0.25",
      "-progress",
      "pipe:1"
    ]);
    expect(call.args).toEqual(
      expect.arrayContaining(["-ss", "10.000", "-t", "4.000"])
    );
    expect(call.options).toEqual({ stdio: ["ignore", "pipe", "pipe"] });

    // Two seconds through the selected four-second trim is 50%. MP4 reserves
    // the final 1% for its stat/cache finalization work.
    sendProgress(call, 2);
    expect(updates.at(-1)).toEqual({ phase: "encoding", ratio: 0.495 });

    close(call, 0);
    const result = await work;
    expect(result.durationSec).toBe(4);
    expect(updatesForPhase(updates, "encoding")).toEqual(
      expect.arrayContaining([
        { phase: "encoding", ratio: null },
        { phase: "encoding", ratio: 0.495 }
      ])
    );
    expect(
      updatesForPhase(updates, "encoding").every(
        (update) => update.ratio === null || update.ratio <= 0.99
      )
    ).toBe(true);
    expect(updates.slice(-2)).toEqual([
      { phase: "finalizing", ratio: 0.99 },
      { phase: "done", ratio: 1, outcome: "succeeded" }
    ]);
  });

  test("throttles application progress to 250ms and keeps the newest pending record", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const updates: VideoExportProgressUpdate[] = [];
    const work = exportVideoRange(
      input({ id: "mp4-throttle", runId: "run-throttle", updates })
    );

    await waitForSpawnCount(1);
    const call = spawnCalls[0]!;
    sendProgress(call, 1);
    sendProgress(call, 2);
    sendProgress(call, 3);

    expect(updatesForPhase(updates, "encoding").at(-1)).toEqual({
      phase: "encoding",
      ratio: 0.099
    });
    await vi.advanceTimersByTimeAsync(249);
    expect(updatesForPhase(updates, "encoding").at(-1)).toEqual({
      phase: "encoding",
      ratio: 0.099
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(updatesForPhase(updates, "encoding").at(-1)).toEqual({
      phase: "encoding",
      ratio: 0.297
    });

    close(call, 0);
    await work;
  });

  test("keeps GIF palette work indeterminate, then weights mux progress into the second half", async () => {
    const updates: VideoExportProgressUpdate[] = [];
    const work = exportVideoRange(
      input({
        id: "gif-progress",
        format: "gif",
        range: { start: 4, end: 8 },
        runId: "run-gif",
        updates
      })
    );

    await waitForSpawnCount(1);
    expect(updates).toEqual(
      expect.arrayContaining([
        { phase: "queued", ratio: null },
        { phase: "palette", ratio: null }
      ])
    );

    sendProgress(spawnCalls[0]!, 1);
    const encoding = updatesForPhase(updates, "encoding").at(-1);
    expect(encoding?.ratio).toBeCloseTo(0.6225, 8);
    expect(encoding?.ratio).toBeGreaterThanOrEqual(0.5);
    expect(encoding?.ratio).toBeLessThan(1);

    close(spawnCalls[0]!, 0);
    await work;
    expect(updates.slice(-2)).toEqual([
      { phase: "finalizing", ratio: 0.99 },
      { phase: "done", ratio: 1, outcome: "succeeded" }
    ]);
  });

  test("cache hits still publish a complete queued/finalizing/succeeded lifecycle", async () => {
    const path = "/cache/r0.000-10.000.med.gop60.s0m0.mp4";
    cachedExport = {
      path,
      byteSize: 99,
      durationSec: 10,
      widthPx: 0,
      heightPx: 0,
      fromCache: true
    };
    existingPaths.add(path);
    const updates: VideoExportProgressUpdate[] = [];

    const result = await exportVideoRange(
      input({ id: "mp4-cache", runId: "run-cache", updates })
    );

    expect(result.fromCache).toBe(true);
    expect(spawnCalls).toHaveLength(0);
    expect(updates).toEqual([
      { phase: "queued", ratio: null },
      { phase: "finalizing", ratio: 0.99 },
      { phase: "done", ratio: 1, outcome: "succeeded" }
    ]);
  });

  test("reports one failed terminal update for nonzero close and spawn error", async () => {
    const closeUpdates: VideoExportProgressUpdate[] = [];
    const failedClose = exportVideoRange(
      input({ id: "mp4-close-fail", runId: "run-close-fail", updates: closeUpdates })
    );
    await waitForSpawnCount(1);
    spawnCalls[0]!.child.stderr.emit("data", Buffer.from("encoder exploded"));
    close(spawnCalls[0]!, 7);
    await expect(failedClose).rejects.toThrow("ffmpeg exited 7: encoder exploded");
    expect(updatesForPhase(closeUpdates, "done")).toEqual([
      {
        phase: "done",
        ratio: null,
        outcome: "failed",
        error: {
          code: "video_export_failed",
          message: "ffmpeg exited 7: encoder exploded"
        }
      }
    ]);

    const errorUpdates: VideoExportProgressUpdate[] = [];
    const spawnError = exportVideoRange(
      input({ id: "mp4-spawn-fail", runId: "run-spawn-fail", updates: errorUpdates })
    );
    await waitForSpawnCount(2);
    spawnCalls[1]!.child.emit("error", new Error("spawn ENOENT"));
    await expect(spawnError).rejects.toThrow("spawn ENOENT");
    expect(updatesForPhase(errorUpdates, "done")).toEqual([
      {
        phase: "done",
        ratio: null,
        outcome: "failed",
        error: {
          code: "video_export_failed",
          message: "spawn ENOENT"
        }
      }
    ]);
  });

  test("AbortSignal kills FFmpeg, reports cancelled once, and drops pending or late progress", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const controller = new AbortController();
    const updates: VideoExportProgressUpdate[] = [];
    const work = exportVideoRange(
      input({
        id: "mp4-abort",
        runId: "run-abort",
        updates,
        signal: controller.signal
      })
    );

    await waitForSpawnCount(1);
    const call = spawnCalls[0]!;
    sendProgress(call, 1);
    sendProgress(call, 2); // pending inside the throttle
    controller.abort();

    await expect(work).rejects.toMatchObject({ name: "AbortError" });
    expect(call.child.kill).toHaveBeenCalledTimes(1);
    expect(call.child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(updatesForPhase(updates, "done")).toEqual([
      { phase: "done", ratio: null, outcome: "cancelled" }
    ]);

    const countAfterAbort = updates.length;
    sendProgress(call, 9, "end");
    close(call, 0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(updates).toHaveLength(countAfterAbort);
  });

  test("a cancelled stale-row re-encode never exposes its partial file as a cache hit", async () => {
    const id = "mp4-stale-row";
    const finalPath =
      `/tmp/pwrsnap-progress-test/video/${id}/` +
      "r0.000-10.000.med.gop60.s0m0.mp4";
    cachedExport = {
      path: finalPath,
      byteSize: 99,
      durationSec: 10,
      widthPx: 1_280,
      heightPx: 720,
      fromCache: true
    };
    // Clear/Trim Render Cache removed the file but deliberately retained
    // the row, so this request must encode again.
    expect(existingPaths.has(finalPath)).toBe(false);

    const controller = new AbortController();
    const first = exportVideoRange(
      input({ id, signal: controller.signal, runId: "run-stale-cancel" })
    );
    await waitForSpawnCount(1);
    const firstCall = spawnCalls[0]!;
    const stagingPath = firstCall.args.at(-1);
    expect(stagingPath).toMatch(/\.partial\.mp4$/);
    expect(stagingPath).not.toBe(finalPath);

    // Model FFmpeg having written a non-empty partial artifact before the
    // renderer cancels. Only the private staging path may exist.
    existingPaths.add(stagingPath!);
    controller.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    close(firstCall, 0);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(existingPaths.has(stagingPath!)).toBe(false);
    expect(existingPaths.has(finalPath)).toBe(false);

    const retry = exportVideoRange(input({ id, runId: "run-stale-retry" }));
    await waitForSpawnCount(2);
    expect(spawnCalls[1]!.args.at(-1)).not.toBe(finalPath);
    close(spawnCalls[1]!, 0);
    await expect(retry).resolves.toMatchObject({
      path: finalPath,
      fromCache: false
    });
    expect(existingPaths.has(finalPath)).toBe(true);
  });

  test("an immediate same-key retry waits for the cancelled FFmpeg close", async () => {
    const controller = new AbortController();
    const cancelledUpdates: VideoExportProgressUpdate[] = [];
    const firstInput = input({
      id: "mp4-cancel-retry",
      runId: "run-cancelled",
      updates: cancelledUpdates,
      signal: controller.signal
    });
    const first = exportVideoRange(firstInput);

    await waitForSpawnCount(1);
    const cancelledChild = spawnCalls[0]!;
    controller.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });

    const retryUpdates: VideoExportProgressUpdate[] = [];
    const retry = exportVideoRange({
      ...firstInput,
      signal: new AbortController().signal,
      progress: observer("run-retry", retryUpdates)
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    // The retry must not join the aborted promise or spawn another writer
    // against the same output while the killed child still owns it.
    expect(spawnCalls).toHaveLength(1);
    expect(retryUpdates).toEqual([]);

    close(cancelledChild, 0);
    await waitForSpawnCount(2);
    expect(spawnCalls[1]).not.toBe(cancelledChild);
    close(spawnCalls[1]!, 0);
    await expect(retry).resolves.toMatchObject({ fromCache: false });
    expect(updatesForPhase(retryUpdates, "done")).toEqual([
      { phase: "done", ratio: 1, outcome: "succeeded" }
    ]);
  });

  test("a killed child keeps its concurrency slot until close", async () => {
    const controller = new AbortController();
    const cancelled = exportVideoRange(
      input({ id: "slot-cancelled", signal: controller.signal })
    );
    await waitForSpawnCount(1);
    const killedCall = spawnCalls[0]!;
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    killedCall.child.emit("error", new Error("kill ESRCH"));

    const second = exportVideoRange(input({ id: "slot-second" }));
    const third = exportVideoRange(input({ id: "slot-third" }));
    await waitForSpawnCount(2);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(spawnCalls).toHaveLength(2);

    close(killedCall, 0);
    await waitForSpawnCount(3);
    close(spawnCalls[1]!, 0);
    close(spawnCalls[2]!, 0);
    await expect(Promise.all([second, third])).resolves.toHaveLength(2);
  });

  test("deduplicated callers with different run IDs receive replay and isolated observer updates", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const firstUpdates: VideoExportProgressUpdate[] = [];
    const secondUpdates: VideoExportProgressUpdate[] = [];
    const firstInput = input({
      id: "mp4-dedup",
      range: { start: 2, end: 10 },
      runId: "run-first",
      updates: firstUpdates
    });
    const first = exportVideoRange(firstInput);

    await waitForSpawnCount(1);
    const call = spawnCalls[0]!;
    sendProgress(call, 2);
    expect(firstUpdates.at(-1)).toEqual({ phase: "encoding", ratio: 0.2475 });

    const second = exportVideoRange({
      ...firstInput,
      progress: observer("run-second", secondUpdates)
    });
    // A late subscriber gets the latest application-level update immediately,
    // rather than waiting up to one throttle interval for another FFmpeg beat.
    expect(secondUpdates).toEqual([{ phase: "encoding", ratio: 0.2475 }]);
    expect(spawnCalls).toHaveLength(1);

    sendProgress(call, 4);
    await vi.advanceTimersByTimeAsync(250);
    expect(firstUpdates.at(-1)).toEqual({ phase: "encoding", ratio: 0.495 });
    expect(secondUpdates.at(-1)).toEqual({ phase: "encoding", ratio: 0.495 });

    close(call, 0);
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.fromCache).toBe(false);
    expect(secondResult.fromCache).toBe(true);
    expect(updatesForPhase(firstUpdates, "done")).toEqual([
      { phase: "done", ratio: 1, outcome: "succeeded" }
    ]);
    expect(updatesForPhase(secondUpdates, "done")).toEqual([
      { phase: "done", ratio: 1, outcome: "succeeded" }
    ]);
    expect(firstUpdates).not.toBe(secondUpdates);
  });
});
