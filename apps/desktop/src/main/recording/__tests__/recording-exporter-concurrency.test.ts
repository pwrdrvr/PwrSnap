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

vi.mock("node:fs/promises", () => ({
  mkdir: async () => undefined,
  stat: async () => ({ size: 12345 })
}));

// ── Other module mocks ────────────────────────────────────────────────

vi.mock("../ffmpeg-resolver", () => ({
  resolveFfmpegPath: () => "/usr/bin/ffmpeg-stub"
}));

vi.mock("../../persistence/paths", () => ({
  getCacheRoot: () => "/tmp/test-cache-root"
}));

// `lookupExport` always returns null so we exercise the encode path.
// `recordExport` is a no-op since we're not validating DB writes here.
vi.mock("../../persistence/video-repo", () => ({
  lookupExport: () => null,
  recordExport: () => undefined
}));

// Dynamically import after mocks are registered.
const { exportVideoRange } = await import("../recording-exporter");

// ── Helpers ───────────────────────────────────────────────────────────

function resetSpawnState(): void {
  spawnQueue.length = 0;
  totalSpawnCount = 0;
  activeSpawnPeak = 0;
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

  test("after rejection, the in-flight entry is cleared so retries work", async () => {
    // First call fails — ffmpeg exits non-zero.
    const failing = exportVideoRange(baseInput);
    await resolveNextSpawn(1);
    await expect(failing).rejects.toThrow(/ffmpeg exited 1/);

    expect(totalSpawnCount).toBe(1);

    // Retry — should spawn fresh, NOT share the dead promise.
    const retry = exportVideoRange(baseInput);
    await resolveNextSpawn(0);
    const result = await retry;
    expect(result.path).toBeDefined();
    expect(totalSpawnCount).toBe(2);
  });
});
