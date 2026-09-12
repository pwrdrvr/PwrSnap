// Pins that the deleters of `<cacheRoot>` — and the writers that must — go
// THROUGH the gate.
//
// `derived-cache-gate.test.ts` proves the gate sequences correctly; nothing
// there proves anyone calls it. This file is the other half: it starts a real
// gated write, runs the real cleanup function, and checks both that the write
// was aborted and that the files went away. A fourth deleter added later
// without a gate call is the regression this catches — the symptom in
// production is an orphaned rendition for a capture that no longer exists,
// which nothing collects and no test would otherwise notice.

import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  capturesRoot: "",
  trashRoot: "",
  cacheRoot: "",
  legacyCacheRoot: ""
}));

vi.mock("../paths", () => ({
  getCapturesRoot: () => mocks.capturesRoot,
  getTrashRoot: () => mocks.trashRoot,
  getCacheRoot: () => mocks.cacheRoot,
  getLegacyCacheRoot: () => mocks.legacyCacheRoot,
  getCacheSourcePath: (id: string) => join(mocks.cacheRoot, id, "source.png"),
  getCacheLayerSourcePath: (id: string, sha: string) =>
    join(mocks.cacheRoot, id, "sources", `${sha}.png`)
}));

vi.mock("../bundle-store", () => ({
  readSourceFromBundle: vi.fn(),
  readSourceForCapture: vi.fn()
}));

vi.mock("../pending-source-store", () => ({
  deletePendingSourcesForCapture: vi.fn(async () => undefined)
}));

// `trimRenderCache` consults the DB for its keep-set. Nothing in this file
// cares which files survive a trim, only that it took the gate first.
vi.mock("../db", () => ({
  getDb: () => ({ prepare: () => ({ all: () => [] }) })
}));
vi.mock("../layers-repo", () => ({ listLayerTree: () => [] }));
vi.mock("../../render/compose-tree", () => ({ computeTreeRenderHash: () => "hash" }));

vi.mock("../../log", () => ({
  getMainLogger: () => ({
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined
  })
}));

const { purgeCacheForCapture } = await import("../source-store");
const { clearRenderCache, trimRenderCache } = await import("../render-cache-maintenance");
const { resetDerivedCacheGateForTests, runGatedCacheWrite } = await import("../derived-cache-gate");

const CAPTURE_ID = "cap-wiring";
let tempRoot: string;

/** A gated write for CAPTURE_ID that hangs until aborted, plus a handle on
 *  whether the gate actually aborted it. Mirrors an ffmpeg remux in flight. */
function startHangingWrite(captureId = CAPTURE_ID): {
  settled: Promise<unknown>;
  aborted: () => boolean;
} {
  let signalRef: AbortSignal | null = null;
  const settled = runGatedCacheWrite(captureId, `${captureId}/playback.mp4`, (signal) => {
    signalRef = signal;
    return new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  }).catch((cause: unknown) => cause);
  return { settled, aborted: () => signalRef?.aborted === true };
}

beforeEach(async () => {
  resetDerivedCacheGateForTests();
  tempRoot = await mkdtemp(join(tmpdir(), "pwrsnap-cache-wiring-"));
  mocks.cacheRoot = join(tempRoot, "render-cache");
  mocks.capturesRoot = join(tempRoot, "captures");
  mocks.trashRoot = join(tempRoot, "trash");
  mocks.legacyCacheRoot = join(tempRoot, "legacy-cache");
  await mkdir(join(mocks.cacheRoot, "video", CAPTURE_ID), { recursive: true });
  await writeFile(join(mocks.cacheRoot, "video", CAPTURE_ID, "playback.mp4"), "stale");
  await mkdir(join(mocks.cacheRoot, CAPTURE_ID), { recursive: true });
  await writeFile(join(mocks.cacheRoot, CAPTURE_ID, "bake.png"), "stale");
});

afterEach(async () => {
  resetDerivedCacheGateForTests();
  await rm(tempRoot, { recursive: true, force: true });
});

describe("purgeCacheForCapture", () => {
  test("aborts an in-flight write for that capture before removing its files", async () => {
    const write = startHangingWrite();
    // Let the gate register it, as `video:playback` would.
    await Promise.resolve();

    await purgeCacheForCapture(CAPTURE_ID);

    expect(write.aborted()).toBe(true);
    await expect(write.settled).resolves.toMatchObject({ name: "AbortError" });
    expect(existsSync(join(mocks.cacheRoot, "video", CAPTURE_ID))).toBe(false);
    expect(existsSync(join(mocks.cacheRoot, CAPTURE_ID))).toBe(false);
  });

  test("leaves another capture's in-flight write alone", async () => {
    const other = startHangingWrite("cap-other");
    await Promise.resolve();

    await purgeCacheForCapture(CAPTURE_ID);

    expect(other.aborted()).toBe(false);

    // Settle it before leaving. A write that never resolves outlives the
    // test with its `abort` listener attached, and makes the gate's
    // "reset with work outstanding" warning fire on every run — training
    // the reader to ignore the warning that exists to catch real leaks.
    // `resetDerivedCacheGateForTests` aborts what it drops, so this is what
    // that abort resolves into.
    resetDerivedCacheGateForTests();
    await expect(other.settled).resolves.toMatchObject({ name: "AbortError" });
  });
});

describe("clearRenderCache", () => {
  test("aborts every in-flight write before emptying the root", async () => {
    const a = startHangingWrite();
    const b = startHangingWrite("cap-other");
    await Promise.resolve();

    await clearRenderCache();

    expect(a.aborted()).toBe(true);
    expect(b.aborted()).toBe(true);
    await expect(a.settled).resolves.toMatchObject({ name: "AbortError" });
    await expect(b.settled).resolves.toMatchObject({ name: "AbortError" });
    expect(existsSync(join(mocks.cacheRoot, CAPTURE_ID))).toBe(false);
    // Re-created empty, not left missing — callers `mkdir` lazily but the
    // root is expected to exist.
    expect(existsSync(mocks.cacheRoot)).toBe(true);
  });
});

describe("trimRenderCache", () => {
  test("aborts every in-flight write before walking the root", async () => {
    const write = startHangingWrite();
    await Promise.resolve();

    await trimRenderCache();

    expect(write.aborted()).toBe(true);
    await expect(write.settled).resolves.toMatchObject({ name: "AbortError" });
  });
});

// The writer half. A behavioural test per lane would need a full ffmpeg mock
// harness for each of four modules; what actually regresses is someone
// deleting one `runGatedCacheWrite` call, and a source scan catches exactly
// that for the price of reading four files. Same reasoning as
// `video-transport-volume.test.ts`: pin the thing that breaks, not a
// reconstruction of the machinery around it.
describe("gated writers", () => {
  const LANES = [
    ["the playback rendition", "../../handlers/recording-handlers.ts", "ensureVideoPlaybackAsset"],
    ["the waveform asset", "../../handlers/recording-handlers.ts", "ensureVideoAudioAsset"],
    ["the contact strip", "../../recording/video-frames.ts", "ensureVideoFrames"],
    ["the poster frame", "../../recording/video-poster.ts", "ensureVideoPoster"]
  ] as const;

  test.each(LANES)("%s publishes inside the gate", (_label, file, entry) => {
    const source = readFileSync(resolve(import.meta.dirname, file), "utf8");
    expect(source).toContain(`function ${entry}`);
    expect(source).toContain("runGatedCacheWrite");
    // The import too, so a stale mention in a comment cannot satisfy this.
    expect(source).toMatch(/import \{[^}]*runGatedCacheWrite[^}]*\}/);
  });

  test("the exporter is deliberately NOT gated", () => {
    // Stated in the gate's header and in AGENTS.md: a user-requested export
    // must not be killed by a background cache trim. If someone gates it,
    // this fails and they have to change the documented decision too.
    const source = readFileSync(
      resolve(import.meta.dirname, "../../recording/recording-exporter.ts"),
      "utf8"
    );
    expect(source).not.toContain("runGatedCacheWrite");
  });
});
