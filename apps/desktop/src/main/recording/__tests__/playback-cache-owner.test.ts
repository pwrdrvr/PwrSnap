import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { CaptureRecord, Req } from "@pwrsnap/shared";

const mocks = vi.hoisted(() => ({
  getCapture: vi.fn(), source: vi.fn(), prepare: vi.fn(), purge: vi.fn(), clear: vi.fn(), trim: vi.fn(),
  installForwarder: vi.fn()
}));
vi.mock("../../log", () => ({ getMainLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }) }));
vi.mock("../../persistence/captures-repo", () => ({ getCaptureById: mocks.getCapture }));
vi.mock("../../persistence/source-store", () => ({ ensureEffectiveSrcPath: mocks.source, purgeCacheForCapture: mocks.purge }));
vi.mock("../../persistence/render-cache-maintenance", () => ({ clearRenderCache: mocks.clear, trimRenderCache: mocks.trim }));
vi.mock("../../persistence/video-playback-cache", () => ({ installVideoPlaybackCacheCleanupForwarder: mocks.installForwarder }));
vi.mock("../../sizzle/audio-extract", () => ({ prepareVideoPlayback: mocks.prepare }));

import { bus } from "../../command-bus";
import { peerOwnsCommand } from "../../process-split/command-routing";
import { installVideoPlaybackCacheOwner, resolvePreparedVideoPlayback } from "../playback-cache-owner";

const record = { id: "capture_1", kind: "video", video: { hasSystemAudio: true, hasMicrophoneAudio: true } } as CaptureRecord;
const cleanupOperations: Req<"storage:runRenderCacheCleanup">[] = [
  { operation: "purge", captureId: record.id }, { operation: "clear" }, { operation: "trim" }
];
beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCapture.mockReturnValue(record);
  mocks.source.mockResolvedValue("/trusted/source.mp4");
  mocks.prepare.mockResolvedValue("/cache/playback.mp4");
  mocks.purge.mockResolvedValue(undefined);
  mocks.clear.mockResolvedValue(undefined);
  mocks.trim.mockResolvedValue(undefined);
});
afterEach(() => {
  bus.unregister("video:preparePlayback");
  bus.unregister("storage:runRenderCacheCleanup");
  bus.uninstallRemoteForwarderForTests();
});

describe("playback cache owner commands", () => {
  test.each(["agent", "combined"] as const)("%s resolves its own source and flags", async (role) => {
    installVideoPlaybackCacheOwner(role);
    const result = await bus.dispatch("video:preparePlayback", {
      captureId: record.id, videoPath: "/peer/untrusted.mp4", hasMicrophoneAudio: false
    } as Req<"video:preparePlayback">, { principal: "bridge" });
    expect(result).toEqual({ ok: true, value: { path: "/cache/playback.mp4" } });
    expect(mocks.prepare).toHaveBeenCalledWith({
      captureId: record.id, videoPath: "/trusted/source.mp4", hasSystemAudio: true, hasMicrophoneAudio: true
    });
    expect(mocks.getCapture).toHaveBeenCalledTimes(2);
    expect(mocks.installForwarder).not.toHaveBeenCalled();
  });

  test("rejects a capture purged while source resolution was pending", async () => {
    installVideoPlaybackCacheOwner("agent");
    let finish!: (path: string) => void;
    mocks.source.mockImplementation(() => new Promise<string>((resolve) => { finish = resolve; }));
    const result = resolvePreparedVideoPlayback(record.id);
    await vi.waitFor(() => expect(mocks.source).toHaveBeenCalledOnce());
    mocks.getCapture.mockReturnValue(null);
    finish("/stale/source.mp4");
    expect(await result).toBeNull();
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  test("missing captures never touch the source or encoder", async () => {
    installVideoPlaybackCacheOwner("agent");
    mocks.getCapture.mockReturnValue(null);
    expect(await resolvePreparedVideoPlayback(record.id)).toBeNull();
    expect(mocks.source).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  test.each(["ipc", "rpc", "seeder"] as const)("%s cannot invoke internal cleanup or obtain local paths", async (principal) => {
    installVideoPlaybackCacheOwner("agent");
    const requests = [
      bus.dispatch("video:preparePlayback", { captureId: record.id }, { principal }),
      ...cleanupOperations.map((req) => bus.dispatch("storage:runRenderCacheCleanup", req, { principal }))
    ];
    for (const request of requests) expect(await request).toMatchObject({ ok: false, error: { code: "internal_command" } });
    expect(mocks.source).not.toHaveBeenCalled();
    expect(mocks.purge).not.toHaveBeenCalled();
    expect(mocks.clear).not.toHaveBeenCalled();
    expect(mocks.trim).not.toHaveBeenCalled();
  });

  test.each(["", "../capture", "capture/child"])("rejects invalid capture id %s before filesystem work", async (captureId) => {
    installVideoPlaybackCacheOwner("agent");
    expect(await bus.dispatch("video:preparePlayback", { captureId }, { principal: "bridge" }))
      .toMatchObject({ ok: false, error: { code: "invalid_request" } });
    expect(await bus.dispatch("storage:runRenderCacheCleanup", { operation: "purge", captureId }, { principal: "bridge" }))
      .toMatchObject({ ok: false, error: { code: "invalid_request" } });
    expect(mocks.getCapture).not.toHaveBeenCalled();
    expect(mocks.purge).not.toHaveBeenCalled();
  });

  test.each(cleanupOperations)("acknowledges $operation only after the entire operation finishes", async (req) => {
    installVideoPlaybackCacheOwner("agent");
    const cleanup = mocks[req.operation];
    let finish!: () => void;
    cleanup.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    let done = false;
    const result = bus.dispatch("storage:runRenderCacheCleanup", req, { principal: "bridge" }).then((value) => { done = true; return value; });
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledOnce());
    expect(done).toBe(false);
    finish();
    expect(await result).toEqual({ ok: true, value: {} });
  });
});

describe("library playback cache forwarding", () => {
  test("routes preparation by capture ID and awaits cleanup acknowledgement from the same owner", async () => {
    installVideoPlaybackCacheOwner("library");
    expect(bus.isRegistered("video:preparePlayback")).toBe(false);
    expect(bus.isRegistered("storage:runRenderCacheCleanup")).toBe(false);
    const forward = vi.fn(async (name: string) => ({ ok: true as const, value: name === "video:preparePlayback" ? { path: "/cache/playback.mp4" } : {} }));
    bus.installRemoteForwarder({ canForward: (name) => peerOwnsCommand("library", name), forward });
    expect(await resolvePreparedVideoPlayback(record.id)).toBe("/cache/playback.mp4");
    expect(forward).toHaveBeenCalledWith("video:preparePlayback", { captureId: record.id }, { principal: "bridge" });
    const cleanup = mocks.installForwarder.mock.calls[0]![0] as (req: Req<"storage:runRenderCacheCleanup">) => Promise<void>;
    for (const operation of cleanupOperations) {
      await cleanup(operation);
      expect(forward).toHaveBeenLastCalledWith("storage:runRenderCacheCleanup", operation, { principal: "bridge" });
    }
    expect(mocks.source).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.purge).not.toHaveBeenCalled();
    expect(mocks.clear).not.toHaveBeenCalled();
    expect(mocks.trim).not.toHaveBeenCalled();
  });

  test("a disconnected Library never falls back to local preparation or cleanup", async () => {
    installVideoPlaybackCacheOwner("library");
    await expect(resolvePreparedVideoPlayback(record.id)).rejects.toThrow("unknown command");
    const cleanup = mocks.installForwarder.mock.calls[0]![0] as (req: Req<"storage:runRenderCacheCleanup">) => Promise<void>;
    for (const operation of cleanupOperations) await expect(cleanup(operation)).rejects.toThrow("unknown command");
    expect(mocks.source).not.toHaveBeenCalled();
    expect(mocks.purge).not.toHaveBeenCalled();
    expect(mocks.clear).not.toHaveBeenCalled();
    expect(mocks.trim).not.toHaveBeenCalled();
  });
});
