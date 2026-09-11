// The split Library must never write playback derivatives or remove cache
// files locally. Its request must finish only when the agent's whole cleanup
// finishes; cancellation/event delivery alone is not a drain acknowledgement.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ProcessRole } from "../../process-role";
import type { VideoPlaybackCacheCleanupOperation } from "../video-playback-cache";

const state = vi.hoisted(() => ({
  root: "", role: "library" as ProcessRole,
  stat: vi.fn(), mkdir: vi.fn(), rm: vi.fn(), rename: vi.fn(),
  probe: vi.fn(), encode: vi.fn()
}));
vi.mock("electron", () => ({ app: { getPath: () => state.root } }));
vi.mock("../../process-role", () => ({ getRuntimeProcessRole: () => state.role }));
vi.mock("../../log", () => ({ getMainLogger: () => ({ info() {}, warn() {}, error() {}, debug() {} }) }));
vi.mock("../db", () => ({ getDb: () => ({ prepare: () => ({ all: () => [] }) }) }));
vi.mock("../layers-repo", () => ({ listLayerTree: () => [] }));
vi.mock("../../render/compose-tree", () => ({ computeTreeRenderHash: () => "unused" }));
vi.mock("../../recording/recording-audio", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../recording/recording-audio")>(),
  probeAudioStreamCount: state.probe,
  runAudioFfmpeg: state.encode
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...fs,
    stat: (...args: Parameters<typeof fs.stat>) => { state.stat(...args); return fs.stat(...args); },
    mkdir: (...args: Parameters<typeof fs.mkdir>) => { state.mkdir(...args); return fs.mkdir(...args); },
    rm: (...args: Parameters<typeof fs.rm>) => { state.rm(...args); return fs.rm(...args); },
    rename: (...args: Parameters<typeof fs.rename>) => { state.rename(...args); return fs.rename(...args); }
  };
});

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubEnv("PWRSNAP_DATA_ROOT", "");
  state.role = "library";
  state.root = mkdtempSync(join(tmpdir(), "pwrsnap-playback-owner-"));
  for (const path of fixturePaths()) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "fixture");
  }
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(state.root, { recursive: true, force: true });
});

function fixturePaths() {
  return [
    join(state.root, "source.mp4"),
    join(state.root, "render-cache", "video", "capture-a", "prepared.mp4"),
    join(state.root, "sizzle-cache", "video-playback", "old.mp4"),
    join(state.root, "pending-sources", "capture-a", "keep.png")
  ];
}

function expectNoLocalWork() {
  for (const call of [state.stat, state.mkdir, state.rm, state.rename, state.probe, state.encode]) {
    expect(call).not.toHaveBeenCalled();
  }
  for (const path of fixturePaths()) expect(existsSync(path)).toBe(true);
}

async function runCleanup(operation: VideoPlaybackCacheCleanupOperation) {
  const { clearRenderCache, trimRenderCache } = await import("../render-cache-maintenance");
  const { purgeCacheForCapture } = await import("../source-store");
  if (operation.operation === "purge") return purgeCacheForCapture(operation.captureId);
  if (operation.operation === "clear") return clearRenderCache();
  return trimRenderCache();
}

const operations: VideoPlaybackCacheCleanupOperation[] = [
  { operation: "purge", captureId: "capture-a" }, { operation: "clear" }, { operation: "trim" }
];

describe("split playback cache ownership", () => {
  test.each([true, false])("Library rejects direct playback before stat/probe/mkdir (dual=%s)", async (dual) => {
    const { prepareVideoPlayback } = await import("../../sizzle/audio-extract");
    await expect(prepareVideoPlayback({
      captureId: "capture-a", videoPath: fixturePaths()[0]!, hasSystemAudio: dual, hasMicrophoneAudio: true
    })).rejects.toThrow("must run in the agent process");
    expectNoLocalWork();
  });

  test("Library cannot bypass the owner by invoking the lower-level job or cleanup registry", async () => {
    const { runVideoPlaybackPreparation, withVideoPlaybackCacheCleanup } = await import("../video-playback-cache");
    const work = vi.fn();
    await expect(runVideoPlaybackPreparation("capture-a", "source", work)).rejects.toThrow("agent process");
    await expect(withVideoPlaybackCacheCleanup(undefined, work)).rejects.toThrow("agent process");
    expect(work).not.toHaveBeenCalled();
    expectNoLocalWork();
  });

  test.each(operations)("Library $operation waits for the owner's complete cleanup without local file operations", async (operation) => {
    const { installVideoPlaybackCacheCleanupForwarder } = await import("../video-playback-cache");
    let finish!: () => void;
    const ownerDone = new Promise<void>((resolve) => { finish = resolve; });
    const forward = vi.fn(() => ownerDone);
    installVideoPlaybackCacheCleanupForwarder(forward);
    let settled = false;
    const pending = runCleanup(operation).then(() => { settled = true; });
    await vi.waitFor(() => expect(forward).toHaveBeenCalledWith(operation));
    expect(settled).toBe(false);
    expectNoLocalWork();
    finish();
    await pending;
    expect(settled).toBe(true);
    expectNoLocalWork();
  });

  test.each(operations)("Library $operation fails closed without a bridge owner", async (operation) => {
    await expect(runCleanup(operation)).rejects.toThrow("agent owner unavailable");
    expectNoLocalWork();
  });

  test.each(operations)("Library $operation propagates owner failure without local fallback", async (operation) => {
    const { installVideoPlaybackCacheCleanupForwarder } = await import("../video-playback-cache");
    const forward = vi.fn().mockRejectedValue(new Error("bridge closed before owner drain"));
    installVideoPlaybackCacheCleanupForwarder(forward);
    await expect(runCleanup(operation)).rejects.toThrow("bridge closed before owner drain");
    expect(forward).toHaveBeenCalledWith(operation);
    expectNoLocalWork();
  });

  test.each(["agent", "combined"] as const)("%s owns local cleanup even if a forwarder is installed", async (role) => {
    state.role = role;
    const { installVideoPlaybackCacheCleanupForwarder } = await import("../video-playback-cache");
    const forward = vi.fn();
    installVideoPlaybackCacheCleanupForwarder(forward);
    await runCleanup({ operation: "clear" });
    expect(forward).not.toHaveBeenCalled();
    expect(existsSync(fixturePaths()[0]!)).toBe(true);
    expect(existsSync(fixturePaths()[1]!)).toBe(false);
    expect(existsSync(fixturePaths()[2]!)).toBe(false);
    expect(existsSync(fixturePaths()[3]!)).toBe(true);
  });
});
