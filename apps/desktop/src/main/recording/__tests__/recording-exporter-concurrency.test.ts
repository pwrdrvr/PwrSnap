// Concurrency-hygiene tests for the video exporter:
//   1. Two concurrent calls for the same (capture, format, preset,
//      range, audio) tuple share one ffmpeg run (in-flight de-dup).
//   2. More than MAX_CONCURRENT_ENCODES distinct keys queue rather
//      than spawning unbounded ffmpeg processes (concurrency cap).
//
// Tests fake out the ffmpeg invocation by stubbing
// `node:child_process::spawn` with a controllable EventEmitter that
// exits on demand. The rest of the I/O (mkdir / stat / video-repo
// cache writes) is stubbed to no-op so the test can focus on the
// concurrency machinery without touching disk or SQLite.

import { EventEmitter } from "node:events";
import { dirname, extname } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { CaptureRecord, VideoCaptureMetadata } from "@pwrsnap/shared";

// ── Spawn stub ────────────────────────────────────────────────────────
//
// Each spawn returns an EventEmitter that the test can resolve via
// `resolveNextSpawn(exitCode)`. Active spawns are tracked so a test
// can assert "exactly N spawns happened" and "K were concurrent".

type FakeChildProcess = EventEmitter & {
  stderr: EventEmitter;
};

const spawnQueue: Array<{ child: FakeChildProcess; args: string[] }> = [];
let totalSpawnCount = 0;
let activeSpawnPeak = 0;

function makeFakeChild(): FakeChildProcess {
  const ee = new EventEmitter() as FakeChildProcess;
  ee.stderr = new EventEmitter();
  return ee;
}

vi.mock("node:child_process", () => ({
  spawn: (_cmd: string, args: string[]): FakeChildProcess => {
    const child = makeFakeChild();
    spawnQueue.push({ child, args });
    totalSpawnCount++;
    activeSpawnPeak = Math.max(activeSpawnPeak, spawnQueue.length);
    return child;
  }
}));

// ── fs / fs.promises stubs ────────────────────────────────────────────

vi.mock("node:fs", () => ({
  existsSync: () => false
}));

const renameCalls: Array<{ from: string; to: string }> = [];
const rmCalls: Array<{ path: string; force: boolean | undefined }> = [];
let statSize = 12345;
let statIsFile = true;
let renameFailure: Error | null = null;

vi.mock("node:fs/promises", () => ({
  mkdir: async () => undefined,
  rename: async (from: string, to: string) => {
    renameCalls.push({ from, to });
    if (renameFailure !== null) throw renameFailure;
  },
  rm: async (path: string, options?: { force?: boolean }) => {
    rmCalls.push({ path, force: options?.force });
  },
  stat: async () => ({ size: statSize, isFile: () => statIsFile })
}));

// ── Other module mocks ────────────────────────────────────────────────

vi.mock("../ffmpeg-resolver", () => ({
  resolveFfmpegPath: () => "/usr/bin/ffmpeg-stub"
}));

vi.mock("../../persistence/paths", () => ({
  getCacheRoot: () => "/tmp/test-cache-root"
}));

const infoLogCalls: Array<{
  message: string;
  fields: Record<string, unknown> | undefined;
}> = [];

vi.mock("../../log", () => ({
  getMainLogger: () => ({
    debug: () => undefined,
    info: (message: string, fields?: Record<string, unknown>) => {
      infoLogCalls.push({ message, fields });
    },
    warn: () => undefined,
    error: () => undefined
  })
}));

// `lookupExport` always returns null so we exercise the encode path.
// `recordExport` is a no-op since we're not validating DB writes here.
vi.mock("../../persistence/video-repo", () => ({
  lookupExport: () => null,
  recordExport: () => undefined
}));

// Dynamically import after mocks are registered.
const {
  buildGifEncodeArgs,
  buildMp4VideoEncoderArgs,
  exportVideoRange,
  ffmpegFailureSummary,
  GIF_PRESETS,
  MP4_PRESETS
} = await import("../recording-exporter");

// ── Helpers ───────────────────────────────────────────────────────────

function resetSpawnState(): void {
  spawnQueue.length = 0;
  totalSpawnCount = 0;
  activeSpawnPeak = 0;
  renameCalls.length = 0;
  rmCalls.length = 0;
  statSize = 12345;
  statIsFile = true;
  renameFailure = null;
  infoLogCalls.length = 0;
}

/** Wait until `spawnQueue.length >= n`. Beats microtask-counting
 *  because the exporter's path to `spawn()` crosses N awaits
 *  (mkdir / acquireEncodeSlot / inner encode promise) that vary by
 *  format. The poll uses `setImmediate` so each iteration flushes
 *  microtasks AND yields to the event loop. */
async function waitForSpawnCount(n: number, timeout = 2000): Promise<void> {
  const start = Date.now();
  while (spawnQueue.length < n) {
    if (Date.now() - start > timeout) {
      throw new Error(`spawnQueue.length stuck at ${spawnQueue.length}, expected >= ${n}`);
    }
    await new Promise((r) => setImmediate(r));
  }
}

/** Resolve the next pending spawn with the given exit code. The
 *  exporter's encode promise resolves when this fires. */
async function resolveNextSpawn(exitCode: number = 0): Promise<void> {
  await waitForSpawnCount(1);
  const next = spawnQueue.shift();
  if (next === undefined) throw new Error("no pending spawn to resolve");
  // Emit on a nextTick so the exporter's `child.on('exit', …)` listener
  // is registered before we fire — mirroring real child_process behavior.
  await new Promise<void>((resolve) => {
    setImmediate(() => {
      next.child.emit("exit", exitCode);
      resolve();
    });
  });
}

/** Resolve all currently-pending spawns. Used at end of a test to
 *  drain any unawaited Promises so afterEach doesn't leak state. */
async function drainAllSpawns(): Promise<void> {
  while (spawnQueue.length > 0) await resolveNextSpawn(0);
}

const record: CaptureRecord = {
  id: "cap-test",
  kind: "video",
  captured_at: new Date().toISOString(),
  legacy_src_path: "/fake/source.mp4",
  bundle_path: null,
  flat_png_path: null,
  bundle_modified_at: null,
  bundle_format_version: 1,
  bundle_edits_version: 0,
  width_px: 1280,
  height_px: 720,
  device_pixel_ratio: 1,
  byte_size: 100,
  sha256: "x",
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

const video: VideoCaptureMetadata = {
  durationSec: 10,
  containerFormat: "mp4",
  hasSystemAudio: false,
  hasMicrophoneAudio: false,
  defaultRange: { start: 0, end: 10 },
  previewPath: null,
  previewStatus: "ready"
};

const baseInput = {
  record,
  video,
  format: "mp4" as const,
  preset: "med" as const,
  range: { start: 0, end: 10 },
  audio: { includeSystemAudio: false, includeMicrophone: false }
};

// ── Tests ─────────────────────────────────────────────────────────────

describe("MP4 platform encoder contract", () => {
  test("uses Media Foundation on Windows without VideoToolbox-only flags", () => {
    const args = buildMp4VideoEncoderArgs("win32", MP4_PRESETS.med);

    expect(args).toEqual(
      expect.arrayContaining(["-c:v", "h264_mf", "-b:v", "5000k", "-g", "60"])
    );
    expect(args).not.toContain("h264_videotoolbox");
    expect(args).not.toContain("-allow_sw");
  });

  test("uses VideoToolbox with software fallback on macOS", () => {
    const args = buildMp4VideoEncoderArgs("darwin", MP4_PRESETS.med);

    expect(args).toEqual(
      expect.arrayContaining([
        "-c:v",
        "h264_videotoolbox",
        "-allow_sw",
        "1",
        "-b:v",
        "5000k",
        "-g",
        "60"
      ])
    );
    expect(args).not.toContain("h264_mf");
  });
});

describe("GIF production filter contract", () => {
  test("shares the complete palette pipeline with artifact smoke coverage", () => {
    expect(
      buildGifEncodeArgs(
        "C:\\captures\\source clip.mp4",
        { start: 1.25, end: 2.5 },
        GIF_PRESETS.low,
        "C:\\exports\\output.gif"
      )
    ).toEqual([
      "-y",
      "-ss",
      "1.250",
      "-t",
      "1.250",
      "-i",
      "C:\\captures\\source clip.mp4",
      "-filter_complex",
      "[0:v] fps=15,scale=480:-2:flags=lanczos,split [a][b];" +
        "[a] palettegen=stats_mode=diff [p];" +
        "[b][p] paletteuse=dither=bayer:bayer_scale=5",
      "C:\\exports\\output.gif"
    ]);
  });
});

describe("exportVideoRange concurrency", () => {
  beforeEach(() => resetSpawnState());
  afterEach(async () => {
    await drainAllSpawns();
  });

  test("in-flight de-dup: two concurrent calls for the same key share one spawn", async () => {
    // Fire both in parallel — the second should find the first's
    // in-flight Promise via `inFlightEncodes.get(key)` and await it
    // instead of starting its own encode.
    const promiseA = exportVideoRange(baseInput);
    const promiseB = exportVideoRange(baseInput);

    await resolveNextSpawn(0);
    const [a, b] = await Promise.all([promiseA, promiseB]);

    // Exactly one ffmpeg invocation despite two callers.
    expect(totalSpawnCount).toBe(1);
    // Both callers got the same path (same encode).
    expect(a.path).toBe(b.path);
    // Second caller is tagged `fromCache: true` because it didn't
    // pay for the encode itself — it rode the in-flight wave.
    expect(b.fromCache).toBe(true);
  });

  test("concurrency cap: four distinct keys peak at MAX_CONCURRENT_ENCODES active spawns", async () => {
    // Issue 4 distinct encodes — different (format, preset)
    // combinations so they don't de-dup. The cap should hold
    // active spawns at MAX_CONCURRENT_ENCODES (= 2 in production
    // config).
    const inputs = [
      { ...baseInput, format: "gif" as const, preset: "low" as const },
      { ...baseInput, format: "gif" as const, preset: "med" as const },
      { ...baseInput, format: "mp4" as const, preset: "high" as const },
      { ...baseInput, format: "mp4" as const, preset: "low" as const }
    ];

    const promises = inputs.map((i) => exportVideoRange(i));

    // First 2 should hit spawn; the next 2 should wait in the queue.
    await waitForSpawnCount(2);
    expect(spawnQueue.length).toBe(2);
    expect(activeSpawnPeak).toBe(2);

    // Drain progressively — each resolution opens a slot for the
    // queued ones. The peak should never exceed 2.
    await resolveNextSpawn(0);
    await waitForSpawnCount(2);
    expect(spawnQueue.length).toBe(2);
    expect(activeSpawnPeak).toBe(2);

    await resolveNextSpawn(0);
    await waitForSpawnCount(1);
    expect(spawnQueue.length).toBeGreaterThanOrEqual(1);

    while (spawnQueue.length > 0) {
      await resolveNextSpawn(0);
    }

    await Promise.all(promises);
    expect(totalSpawnCount).toBe(4);
    // Confirms the cap held throughout — never more than 2 active
    // at any observed moment.
    expect(activeSpawnPeak).toBe(2);
  });

  test("encodeMs starts after a queued export acquires its semaphore slot", async () => {
    const realNow = Date.now.bind(Date);
    let clockOffsetMs = 0;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => realNow() + clockOffsetMs);
    try {
      // Fill both encoder slots, then queue a third distinct export.
      const first = exportVideoRange({ ...baseInput, format: "gif", preset: "low" });
      const second = exportVideoRange({ ...baseInput, format: "gif", preset: "med" });
      await waitForSpawnCount(2);
      const queued = exportVideoRange({ ...baseInput, format: "mp4", preset: "high" });
      await new Promise((resolve) => setImmediate(resolve));
      expect(totalSpawnCount).toBe(2);

      // Simulate a long scheduler wait, then release one slot. The queued MP4
      // starts while this offset is active, so its encode timer must start here.
      clockOffsetMs = 8_000;
      await resolveNextSpawn(0);
      await waitForSpawnCount(2);

      // Finish the remaining work roughly 100 ms of logical encode time later.
      clockOffsetMs = 8_100;
      while (spawnQueue.length > 0) await resolveNextSpawn(0);
      await Promise.all([first, second, queued]);

      const queuedLog = infoLogCalls.find(
        ({ message, fields }) => message === "video export encoded" && fields?.preset === "high"
      );
      expect(queuedLog).toBeDefined();
      const encodeMs = queuedLog?.fields?.encodeMs;
      expect(typeof encodeMs).toBe("number");
      expect(encodeMs as number).toBeGreaterThanOrEqual(100);
      expect(encodeMs as number).toBeLessThan(1_000);
    } finally {
      nowSpy.mockRestore();
    }
  });

  test("after rejection, the in-flight entry is cleared so retries work", async () => {
    // First call fails — ffmpeg exits non-zero.
    const failing = exportVideoRange(baseInput);
    await waitForSpawnCount(1);
    const failedTempPath = spawnQueue[0]?.args.at(-1);
    await resolveNextSpawn(1);
    await expect(failing).rejects.toThrow(/ffmpeg exited 1/);

    expect(totalSpawnCount).toBe(1);
    expect(rmCalls).toContainEqual({ path: failedTempPath, force: true });
    expect(renameCalls).toHaveLength(0);

    // Retry — should spawn fresh, NOT share the dead promise.
    const retry = exportVideoRange(baseInput);
    await resolveNextSpawn(0);
    const result = await retry;
    expect(result.path).toBeDefined();
    expect(totalSpawnCount).toBe(2);
  });

  test("writes through a same-directory .mp4 temp and atomically promotes it", async () => {
    const pending = exportVideoRange(baseInput);
    await waitForSpawnCount(1);
    const tempPath = spawnQueue[0]?.args.at(-1);
    if (tempPath === undefined) throw new Error("missing ffmpeg output argument");

    await resolveNextSpawn(0);
    const result = await pending;

    expect(tempPath).not.toBe(result.path);
    expect(dirname(tempPath)).toBe(dirname(result.path));
    expect(extname(tempPath)).toBe(".mp4");
    expect(renameCalls).toEqual([{ from: tempPath, to: result.path }]);
    expect(rmCalls).toHaveLength(0);
  });

  test("rejects and removes a zero-byte ffmpeg output before promotion", async () => {
    statSize = 0;
    const pending = exportVideoRange(baseInput);
    await waitForSpawnCount(1);
    const tempPath = spawnQueue[0]?.args.at(-1);

    await resolveNextSpawn(0);
    await expect(pending).rejects.toThrow(/empty or invalid MP4 export/);

    expect(renameCalls).toHaveLength(0);
    expect(rmCalls).toContainEqual({ path: tempPath, force: true });
  });

  test("removes the temp output when atomic promotion fails", async () => {
    renameFailure = new Error("EPERM: destination is temporarily locked");
    const pending = exportVideoRange(baseInput);
    await waitForSpawnCount(1);
    const tempPath = spawnQueue[0]?.args.at(-1);

    await resolveNextSpawn(0);
    await expect(pending).rejects.toThrow(/destination is temporarily locked/);

    expect(renameCalls).toHaveLength(1);
    expect(rmCalls).toContainEqual({ path: tempPath, force: true });
  });

  test("LOW / MED MP4 re-encodes pass an explicit 60-frame GOP to the platform encoder", async () => {
    const low = exportVideoRange({ ...baseInput, preset: "low" });
    await waitForSpawnCount(1);

    expect(spawnQueue[0]?.args).toEqual(
      expect.arrayContaining([
        "-c:v",
        process.platform === "win32" ? "h264_mf" : "h264_videotoolbox",
        "-g",
        "60",
        "-keyint_min",
        "60"
      ])
    );
    expect(spawnQueue[0]?.args.at(-1)).toMatch(/\.low\.gop60\.s0m0\.tmp-.+\.mp4$/);

    await resolveNextSpawn(0);
    const lowResult = await low;
    expect(lowResult.path).toContain(".low.gop60.s0m0.mp4");

    const med = exportVideoRange({ ...baseInput, preset: "med" });
    await waitForSpawnCount(1);

    expect(spawnQueue[0]?.args).toEqual(
      expect.arrayContaining([
        "-c:v",
        process.platform === "win32" ? "h264_mf" : "h264_videotoolbox",
        "-g",
        "60",
        "-keyint_min",
        "60"
      ])
    );
    expect(spawnQueue[0]?.args.at(-1)).toMatch(/\.med\.gop60\.s0m0\.tmp-.+\.mp4$/);

    await resolveNextSpawn(0);
    const medResult = await med;
    expect(medResult.path).toContain(".med.gop60.s0m0.mp4");
  });

  test("MP4 audio maps tolerate stale track metadata from older recordings", async () => {
    const encoded = exportVideoRange({
      ...baseInput,
      video: {
        ...video,
        hasSystemAudio: true,
        hasMicrophoneAudio: true
      },
      audio: {
        includeSystemAudio: true,
        includeMicrophone: true
      }
    });
    await waitForSpawnCount(1);

    const args = spawnQueue[0]?.args ?? [];
    expect(args).toEqual(expect.arrayContaining(["-map", "0:a:0?", "-map", "0:a:1?"]));
    expect(args).not.toContain("0:a:0");
    expect(args).not.toContain("0:a:1");

    await resolveNextSpawn(0);
    await encoded;
  });

  test("ffmpeg failures surface the actionable error instead of its build banner", async () => {
    const failing = exportVideoRange(baseInput);
    await waitForSpawnCount(1);
    spawnQueue[0]?.child.stderr.emit(
      "data",
      Buffer.from(
        [
          "ffmpeg version 8.1 Copyright (c) 2000-2026 the FFmpeg developers",
          "  built with Apple clang version 21.0.0",
          "  configuration: --prefix=/opt/homebrew/Cellar/ffmpeg/8.1 --enable-shared --enable-videotoolbox",
          "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from '/Users/person/Documents/PwrSnap/source.mp4':",
          "Stream map '0:a:1' matches no streams.",
          "To ignore this, add a trailing '?' to the map."
        ].join("\n")
      )
    );

    await resolveNextSpawn(234);
    await expect(failing).rejects.toThrow(
      "ffmpeg exited 234: Stream map '0:a:1' matches no streams. To ignore this, add a trailing '?' to the map."
    );
  });

  test("ffmpeg failure summaries retain root causes before generic teardown lines", () => {
    const summary = ffmpegFailureSummary(
      [
        "ffmpeg version 8.1 Copyright (c) 2000-2026 the FFmpeg developers",
        "  built with Apple clang version 21.0.0",
        "  configuration: --prefix=/opt/homebrew/Cellar/ffmpeg/8.1 --enable-videotoolbox",
        "[h264 @ 0x1234] Invalid NAL unit size (4294967295 > 2048).",
        "[in#0/mov,mp4,m4a,3gp,3g2,mj2 @ 0x2345] Error during demuxing: Invalid data found when processing input",
        "[out#0/mp4 @ 0x3456] Error muxing a packet",
        "[out#0/mp4 @ 0x3456] Task finished with error code: -1094995529 (Invalid data found when processing input)",
        "[out#0/mp4 @ 0x3456] Terminating thread with return code -1094995529 (Invalid data found when processing input)",
        "Nothing was written into output file, because at least one of its streams received no packets.",
        "Conversion failed!"
      ].join("\n")
    );

    expect(summary).toContain("Invalid NAL unit size");
    expect(summary).toContain("Conversion failed!");
    expect(summary).not.toContain("ffmpeg version");
    expect(summary).not.toContain("configuration:");
    expect(summary.length).toBeLessThanOrEqual(900);
  });

  test("HIGH MP4 re-encodes at source resolution with GOP flags", async () => {
    const high = exportVideoRange({ ...baseInput, preset: "high" });
    await waitForSpawnCount(1);

    const args = spawnQueue[0]?.args ?? [];
    expect(args).toEqual(
      expect.arrayContaining([
        "-c:v",
        process.platform === "win32" ? "h264_mf" : "h264_videotoolbox",
        "-b:v",
        "6000k",
        "-g",
        "60",
        "-keyint_min",
        "60"
      ])
    );
    expect(args).not.toContain("copy");
    expect(args).not.toContain("-vf");
    expect(args.at(-1)).toMatch(/\.high\.gop60\.s0m0\.tmp-.+\.mp4$/);

    await resolveNextSpawn(0);
    const result = await high;
    expect(result.path).toContain(".high.gop60.s0m0.mp4");
  });

  test("HIGH MP4 snaps odd source dimensions to even codec-safe dimensions", async () => {
    const high = exportVideoRange({
      ...baseInput,
      preset: "high",
      record: {
        ...record,
        width_px: 1681,
        height_px: 946
      }
    });
    await waitForSpawnCount(1);

    const args = spawnQueue[0]?.args ?? [];
    expect(args).toEqual(
      expect.arrayContaining([
        "-vf",
        "scale=1680:946:flags=lanczos",
        "-c:v",
        process.platform === "win32" ? "h264_mf" : "h264_videotoolbox"
      ])
    );

    await resolveNextSpawn(0);
    const result = await high;
    expect(result.widthPx).toBe(1680);
    expect(result.heightPx).toBe(946);
  });
});
