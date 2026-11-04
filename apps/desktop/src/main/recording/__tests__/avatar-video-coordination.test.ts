// Real exporter, presenter preparation, admission gates and process bridge.
// Only the camera renderer and FFmpeg are faked; staging/publishing/cleanup
// use real files. Isolated module registries model the two process owners.
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi, type MockInstance } from "vitest";
import { DEFAULT_AVATAR_STYLE, type CaptureRecord, type CommandName, type VideoExportResult } from "@pwrsnap/shared";
import { BridgeEndpoint } from "../../process-bridge/endpoint";
import { inMemoryChannelPair } from "../../process-bridge/channel";
import { peerOwnsCommand } from "../../process-split/command-routing";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const state = vi.hoisted(() => ({
  root: "",
  record: null as CaptureRecord | null,
  workers: [] as Array<{ closed: boolean; frame: ReturnType<typeof deferred<string>> }>,
  frameTimes: [] as number[],
  legacyExport: null as { key: string; result: VideoExportResult } | null,
  spawns: [] as string[][]
}));

vi.mock("electron", () => ({
  app: { isPackaged: false, getPath: () => state.root },
  BrowserWindow: { getAllWindows: () => [] },
  systemPreferences: {}, shell: {}
}));
vi.mock("../../log", () => ({ getMainLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }) }));
vi.mock("../../persistence/paths", () => ({
  getCacheRoot: () => join(state.root, "cache"),
  getLegacyCacheRoot: () => join(state.root, "legacy-cache")
}));
vi.mock("../../persistence/captures-repo", () => ({ getCaptureById: () => state.record }));
vi.mock("../../persistence/video-repo", () => ({ lookupExport: (req: { segmentsKey: string }) => req.segmentsKey === state.legacyExport?.key ? state.legacyExport.result : null, recordExport: vi.fn() }));
vi.mock("../../persistence/db", () => ({ getDb: () => ({ prepare: () => ({ all: () => [] }) }) }));
vi.mock("../../persistence/pending-source-store", () => ({ deletePendingSourcesForCapture: async () => undefined }));
vi.mock("../../recording/recording-service", () => ({ getRecordingService: vi.fn() }));
vi.mock("../ffmpeg-resolver", () => ({ resolveFfmpegPath: () => "fake-ffmpeg" }));
vi.mock("../recording-audio", async (original) => ({
  ...await original<typeof import("../recording-audio")>(),
  probeAudioStreamCount: async () => 0
}));
vi.mock("../camera-worker", () => ({
  CameraWorker: class {
    closed = false;
    frame = deferred<string>();
    constructor() { state.workers.push(this); }
    async load() {}
    async call(name: string, time?: number) {
      if (name !== "frame") return undefined;
      state.frameTimes.push(time!);
      return this.frame.promise;
    }
    close() {
      this.closed = true;
      this.frame.reject(new DOMException("Camera worker closed", "AbortError"));
    }
  }
}));
vi.mock("node:child_process", async (original) => ({
  ...await original<typeof import("node:child_process")>(),
  spawn: (_binary: string, args: string[]) => {
    state.spawns.push(args);
    const child = new EventEmitter() as EventEmitter & {
      stdin: Writable; stdout: EventEmitter; stderr: EventEmitter;
      exitCode: number | null; kill: () => boolean;
    };
    child.exitCode = null;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    let writing = false;
    let killed = false;
    const close = () => {
      if (child.exitCode !== null) return;
      child.exitCode = killed ? 137 : 0;
      child.emit("close", child.exitCode);
    };
    const finish = async () => {
      writing = true;
      if (!killed) await writeFile(args.at(-1)!, "encoded fixture");
      close();
    };
    child.stdin = new Writable({
      write(_chunk, _encoding, callback) { callback(); },
      final(callback) { void finish().then(() => callback(), callback); }
    });
    child.kill = () => {
      killed = true;
      if (!writing) queueMicrotask(close);
      return true;
    };
    // Ordinary file exports don't feed stdin; mask/composition do.
    if (args.includes("-progress")) queueMicrotask(() => { void finish(); });
    return child;
  }
}));

// Agent and library import independent buses/gates, as two Electron mains do.
const agentBus = (await import("../../command-bus")).bus;
const agentGate = await import("../../persistence/derived-cache-gate");
const agentAvatar = await import("../avatar-video");
const { exportVideoRange } = await import("../recording-exporter");
(await import("../../process-role")).setRuntimeProcessRole("agent");
(await import("../../handlers/recording-handlers")).registerRecordingHandlers();
(await import("../../handlers/derived-cache-handlers")).registerDerivedCacheCleanupOwner("agent");
vi.resetModules();
const libraryBus = (await import("../../command-bus")).bus;
(await import("../../process-role")).setRuntimeProcessRole("library");
const libraryAvatar = await import("../avatar-video");
const { prepareSceneAvatar } = await import("../../sizzle/avatar-preparation");
const relay = await import("../../process-split/event-relay");
const libraryGate = await import("../../persistence/derived-cache-gate");
(await import("../../handlers/derived-cache-handlers")).registerDerivedCacheCleanupOwner("library");
const { clearRenderCache, trimRenderCache } = await import("../../persistence/render-cache-maintenance");
const { purgeCacheForCapture } = await import("../../persistence/source-store");

let endpoints: BridgeEndpoint[] = [];
let gated: MockInstance<typeof agentGate.runGatedCacheWrite>;

beforeEach(async () => {
  state.root = await mkdtemp(join(tmpdir(), "pwrsnap-avatar-coordination-"));
  state.workers.length = 0;
  state.spawns.length = 0;
  state.frameTimes.length = 0;
  state.legacyExport = null;
  state.record = {
    id: "presenter-test", kind: "video", legacy_src_path: join(state.root, "screen.mp4"),
    sha256: "a".repeat(64), width_px: 640, height_px: 480, deleted_at: null,
    video: {
      durationSec: 1, defaultRange: { start: 0, end: 1 }, segments: [{ start: 0, end: 1 }],
      hasSystemAudio: false, hasMicrophoneAudio: false,
      camera: { version: 1, durationSec: 0.01, width: 640, height: 480, offsetSec: 0, sha256: "b".repeat(64), mimeType: "video/mp4" },
      avatar: { ...DEFAULT_AVATAR_STYLE }
    }
  } as CaptureRecord;
  await writeFile(state.record.legacy_src_path!, "immutable screen");
  gated = vi.spyOn(agentGate, "runGatedCacheWrite");
  const [agentChannel, libraryChannel] = inMemoryChannelPair();
  const agent = new BridgeEndpoint({
    role: "agent", channel: agentChannel,
    dispatchLocal: (name, req, context) => agentBus.dispatch(name as CommandName, req as never, context),
    onRemoteCancel: (key) => agentBus.cancel(key)
  });
  const library = new BridgeEndpoint({
    role: "library", channel: libraryChannel,
    dispatchLocal: (name, req, context) => libraryBus.dispatch(name as CommandName, req as never, context)
  });
  endpoints = [agent, library];
  libraryBus.installRemoteForwarder({
    canForward: (name) => peerOwnsCommand("library", name),
    forward: (name, req, context) => library.dispatchRemote(name, req, context)
  });
  relay.installCancellationForwarder((key) => library.cancelRemote(key));
});

afterEach(async () => {
  await agentGate.withDerivedCacheCleanup("all", async () => undefined);
  endpoints.forEach((endpoint) => endpoint.close());
  libraryBus.uninstallRemoteForwarderForTests();
  relay.uninstallCancellationForwarderForTests();
  gated.mockRestore();
  await rm(state.root, { recursive: true, force: true });
});

async function waitForMaskConsumers(count: number) {
  await vi.waitFor(() => {
    expect(gated.mock.calls.filter((call) => call[1].startsWith("mask-")).length).toBe(count);
    expect(state.workers).toHaveLength(1);
    expect(state.spawns).toHaveLength(1);
  });
}

function exportPreset(preset: "low" | "high", signal: AbortSignal) {
  return exportVideoRange({
    record: state.record!, video: state.record!.video!, preset, format: "mp4",
    range: { start: 0, end: 1 }, audio: { includeSystemAudio: false, includeMicrophone: false },
    signal
  });
}

describe("presenter consumers", () => {
  test("cancelling one preset leaves the other export's preparation alive", async () => {
    const first = new AbortController(), second = new AbortController();
    const a = exportPreset("low", first.signal).catch((cause: unknown) => cause);
    const b = exportPreset("high", second.signal);
    await waitForMaskConsumers(1);
    await vi.waitFor(() => expect(gated.mock.calls.filter((call) => call[1].startsWith("avatar-")).length).toBe(2));
    first.abort();
    expect(await a).toMatchObject({ name: "AbortError" });
    expect(state.workers[0]!.closed).toBe(false);
    state.workers[0]!.frame.resolve("cG5n");
    expect((await b).byteSize).toBeGreaterThan(0);
    expect(state.spawns).toHaveLength(3); // mask, composite, surviving preset
    expect(await readFile(state.record!.legacy_src_path!, "utf8")).toBe("immutable screen");
  });

  test("two placements share a mask; cancelling its first caller leaves the second alive", async () => {
    const first = new AbortController(), second = new AbortController();
    const a = agentAvatar.prepareAvatarVideo(state.record!, undefined, first.signal).catch((cause: unknown) => cause);
    const b = agentAvatar.prepareAvatarVideo(state.record!, { ...DEFAULT_AVATAR_STYLE, x: 0.65 }, second.signal);
    await waitForMaskConsumers(2);
    first.abort();
    expect(await a).toMatchObject({ name: "AbortError" });
    expect(state.workers[0]!.closed).toBe(false);
    state.workers[0]!.frame.resolve("cG5n");
    expect(await readFile(await b, "utf8")).toBe("encoded fixture");
    expect(state.workers).toHaveLength(1);
  });
});

describe("presenter cache process ownership", () => {
  test("cancellation immediately after dispatch is preserved across the bridge", async () => {
    const controller = new AbortController();
    const scene = prepareSceneAvatar(state.record!, undefined, controller.signal, { width: 1280, height: 720 });
    controller.abort();
    await expect(scene).rejects.toMatchObject({ name: "AbortError" });
    expect(state.spawns).toEqual([]);
  });

  test.each(["clear", "trim", "purge"] as const)("Library %s drains scene and ordinary export preparation in the agent", async (operation) => {
    const localWrite = vi.spyOn(libraryGate, "runGatedCacheWrite");
    const scene = prepareSceneAvatar(state.record!, undefined, undefined, { width: 1280, height: 720 }).catch((cause: unknown) => cause);
    const ordinary = exportPreset("high", new AbortController().signal).catch((cause: unknown) => cause);
    await waitForMaskConsumers(2);
    expect(localWrite).not.toHaveBeenCalled();
    if (operation === "clear") await clearRenderCache();
    else if (operation === "trim") await trimRenderCache();
    else await purgeCacheForCapture(state.record!.id);
    expect(await scene).toMatchObject({ name: "AbortError" });
    expect(await ordinary).toMatchObject({ name: "AbortError" });
    expect(state.workers[0]!.closed).toBe(true);
    const files = await readdir(join(state.root, "cache"), { recursive: true });
    expect(files.filter((name) => /avatar-|partial/.test(name))).toEqual([]);
    localWrite.mockRestore();
  });

  test("a cancelled Library scene releases only its own mask consumer", async () => {
    const signal = new AbortController();
    const scene = prepareSceneAvatar(state.record!, undefined, signal.signal, { width: 1280, height: 720 }).catch((cause: unknown) => cause);
    const ordinary = exportPreset("high", new AbortController().signal);
    await waitForMaskConsumers(2);
    signal.abort();
    expect(await scene).toMatchObject({ name: "AbortError" });
    expect(state.workers[0]!.closed).toBe(false);
    state.workers[0]!.frame.resolve("cG5n");
    expect((await ordinary).byteSize).toBeGreaterThan(0);
  });

  test("Library code cannot bypass the owner, even with a warm cache", async () => {
    await expect(libraryAvatar.prepareAvatarVideo(state.record!)).rejects.toThrow(/cache owner/);
    libraryBus.uninstallRemoteForwarderForTests();
    await expect(prepareSceneAvatar(state.record!, undefined, undefined, { width: 1280, height: 720 })).rejects.toThrow(/unknown command/);
    expect(state.spawns).toEqual([]);
  });

  test("the owner rejects renderer requests and invalid scene dimensions", async () => {
    expect(await agentBus.dispatch("video:prepareAvatar", { captureId: state.record!.id }, { principal: "ipc" })).toMatchObject({ ok: false, error: { code: "internal_command" } });
    expect(await agentBus.dispatch("video:prepareAvatar", { captureId: state.record!.id, canvas: { width: 0, height: 720 } }, { principal: "bridge" })).toMatchObject({ ok: false, error: { code: "invalid_canvas" } });
    expect(state.spawns).toEqual([]);
  });
});


describe("presenter export preparation bounds", () => {
  function longTake() {
    const record = state.record!;
    record.video!.durationSec = 60;
    record.video!.defaultRange = { start: 0, end: 60 };
    record.video!.segments = [{ start: 0, end: 60 }];
    record.video!.camera!.durationSec = 60;
    return record;
  }
  function rangeExport(record: CaptureRecord, start: number, end: number, format: "mp4" | "gif" = "mp4") {
    return exportVideoRange({
      record, video: record.video!, preset: "high", format, range: { start, end },
      audio: { includeSystemAudio: false, includeMicrophone: false }
    });
  }
  async function releaseFrames() {
    await vi.waitFor(() => expect(state.workers).toHaveLength(1));
    state.workers[0]!.frame.resolve("cG5n");
  }
  const recordId = () => state.record!.id;
  function composition() {
    return state.spawns.find((args) => args.includes("-filter_complex") && !args.includes("-progress"))!;
  }

  test("full-take fixture prepares 900 sequential frames and 60 seconds of composition", async () => {
    const pending = rangeExport(longTake(), 0, 60);
    await releaseFrames();
    await pending;
    expect(state.frameTimes).toHaveLength(900);
    expect(state.frameTimes[0]).toBe(0);
    expect(state.frameTimes.at(-1)).toBe(899 / 15);
    const args = composition();
    expect(args[args.indexOf("-t") + 1]).toBe("60");
  });

  test.each([
    { camera: -0.4, sync: -0.6, frames: 46 },
    { camera: 0.4, sync: 0.6, frames: 16 },
    { camera: -0.4, sync: 0.6, frames: 28 },
    { camera: 0.4, sync: -0.6, frames: 34 }
  ])("maps the end through camera $camera and style $sync offsets", async ({ camera, sync, frames }) => {
    const record = longTake();
    record.video!.camera!.offsetSec = camera;
    record.video!.avatar!.syncOffsetSec = sync;
    const pending = rangeExport(record, 0, 2);
    await releaseFrames();
    await pending;
    expect(state.frameTimes).toHaveLength(frames);
    expect(state.frameTimes).toEqual(Array.from({ length: frames }, (_, i) => i / 15));
  });

  test("the prefix includes pre-roll required by a kept piece's presenter sync", async () => {
    const record = longTake();
    record.video!.camera!.offsetSec = 0.5;
    record.video!.avatarSpans = [{ start: 0.5, end: 1.5, avatar: { ...DEFAULT_AVATAR_STYLE, syncOffsetSec: -1.5 } }];
    const pending = rangeExport(record, 0, 2);
    await releaseFrames();
    await pending;
    expect(state.frameTimes).toHaveLength(46); // piece's effective offset -1 s
    expect(composition().join(" ")).toContain("trim=start=1.000000");
  });

  test("cleanup aborts and drains a prefix before deletion and rejects admission during cleanup", async () => {
    const record = longTake();
    const pending = rangeExport(record, 0, 2).catch((cause: unknown) => cause);
    await vi.waitFor(() => expect(state.frameTimes).toHaveLength(1));
    await agentGate.withDerivedCacheCleanup({ captureId: record.id }, async () => {
      expect(state.workers[0]!.closed).toBe(true);
      await expect(agentAvatar.prepareAvatarVideo(record, undefined, undefined, undefined, 2)).rejects.toMatchObject({ name: "AbortError" });
      await rm(join(state.root, "cache", "video", record.id), { recursive: true, force: true });
    });
    expect(await pending).toMatchObject({ name: "AbortError" });
    expect(await readdir(join(state.root, "cache", "video"))).toEqual([]);
  });

  test("a late trim preserves time-zero preparation, and cuts do not ripple preparation timestamps", async () => {
    const record = longTake();
    const spans = [{ start: 2, end: 3 }, { start: 7, end: 8 }];
    const pending = exportVideoRange({
      record, video: record.video!, preset: "high", format: "mp4",
      range: { start: 2, end: 8 }, spans,
      audio: { includeSystemAudio: false, includeMicrophone: false }
    });
    await releaseFrames();
    expect((await pending).durationSec).toBe(2);
    expect(state.frameTimes).toHaveLength(121);
    expect(state.frameTimes[0]).toBe(0);
    expect(state.frameTimes.at(-1)).toBe(120 / 15);
    const args = composition();
    expect(args[args.indexOf("-t") + 1]).toBe("8");
    const final = state.spawns.at(-1)!;
    expect(final.join(" ")).toContain("trim=start=2.000:end=3.000");
    expect(final.join(" ")).toContain("trim=start=7.000:end=8.000");
  });

  test.each([undefined, 2])("old prefix compositions and final exports are not accepted (revision %s)", async (revision) => {
    const record = longTake();
    // Prior pipeline fixtures, including the pre-VFR boundary revision.
    const oldKey = createHash("sha256").update(JSON.stringify([
      "mediapipe-landscape-490e9ea7-v1", record.sha256, record.video!.camera,
      record.video!.avatar, undefined, { sourceEndSec: 2, ...(revision === undefined ? {} : { boundaryVersion: revision }) }
    ])).digest("hex").slice(0, 24);
    const directory = join(state.root, "cache", "video", record.id);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, `avatar-${oldKey}.mp4`), "old truncated prefix");
    const stale = join(state.root, "old-export.gif");
    await writeFile(stale, "old missing-presenter export");
    state.legacyExport = {
      key: `:avatar:${agentAvatar.avatarCacheKey(record)}${revision === undefined ? "" : ":prefix-v2"}`,
      result: { path: stale, byteSize: 29, durationSec: 2, widthPx: 640, heightPx: 480, fromCache: true }
    };
    const pending = rangeExport(record, 0, 2, "gif");
    await releaseFrames();
    const result = await pending;
    expect(result.path).not.toBe(stale);
    expect(result.fromCache).toBe(false);
    expect(state.frameTimes).toHaveLength(31);
  });

  test("an earlier full composition cannot bypass the screen clock correction for a prefix", async () => {
    const record = longTake();
    const oldFullKey = createHash("sha256").update(JSON.stringify([
      "mediapipe-landscape-490e9ea7-v1", record.sha256, record.video!.camera,
      record.video!.avatar, undefined
    ])).digest("hex").slice(0, 24);
    const directory = join(state.root, "cache", "video", record.id);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, `avatar-${oldFullKey}.mp4`), "old VFR composition");
    const pending = agentAvatar.prepareAvatarVideo(record, undefined, undefined, undefined, 2);
    await releaseFrames();
    expect(await readFile(await pending, "utf8")).toBe("encoded fixture");
    expect(composition().join(" ")).toContain("tpad=stop_mode=clone:stop_duration=2.000000,trim=end=2.000000[screen]");
  });

  test("a prefix cannot satisfy a later horizon or the full-take Sizzle consumer", async () => {
    const record = longTake();
    const short = agentAvatar.prepareAvatarVideo(record, undefined, undefined, undefined, 2);
    await releaseFrames();
    const shortPath = await short;
    const longer = agentAvatar.prepareAvatarVideo(record, undefined, undefined, undefined, 4);
    await vi.waitFor(() => expect(state.workers).toHaveLength(2));
    state.workers[1]!.frame.resolve("cG5n");
    const longerPath = await longer;
    expect(longerPath).not.toBe(shortPath);
    expect(state.frameTimes).toHaveLength(31 + 61);
    // Reuse a completed preparation of the same horizon; no new worker/spawn.
    const spawns = state.spawns.length;
    expect(await agentAvatar.prepareAvatarVideo(record, undefined, undefined, undefined, 4)).toBe(longerPath);
    expect(state.spawns).toHaveLength(spawns);
    const scene = prepareSceneAvatar(record, undefined, undefined, { width: 640, height: 480 });
    await vi.waitFor(() => expect(state.workers).toHaveLength(3));
    state.workers[2]!.frame.resolve("cG5n");
    expect(await scene).not.toBe(shortPath);
    expect(state.frameTimes).toHaveLength(31 + 61 + 900);
  });

  test("a warm full-take composition safely serves a shorter export without new preparation", async () => {
    const record = longTake();
    const full = agentAvatar.prepareAvatarVideo(record);
    await releaseFrames();
    await full;
    expect(state.frameTimes).toHaveLength(900);
    const spawns = state.spawns.length;
    const result = await rangeExport(record, 2, 4);
    expect(result.durationSec).toBe(2);
    expect(state.workers).toHaveLength(1);
    expect(state.spawns).toHaveLength(spawns + 1); // the requested final encode only
  });

  test("a warm full mask serves a new placement's prefix without another segmentation pass", async () => {
    const record = longTake();
    const full = agentAvatar.prepareAvatarVideo(record);
    await releaseFrames();
    const fullPath = await full;
    const spawns = state.spawns.length;
    const prefix = await agentAvatar.prepareAvatarVideo(record, { ...DEFAULT_AVATAR_STYLE, x: 0.1 }, undefined, undefined, 2);
    expect(prefix).not.toBe(fullPath);
    expect(state.frameTimes).toHaveLength(900);
    expect(state.workers).toHaveLength(1);
    expect(state.spawns).toHaveLength(spawns + 1); // new composition only
  });

  test("a presenter that begins after the prefix skips preparation", async () => {
    const record = longTake();
    record.video!.camera!.offsetSec = 3;
    const result = await rangeExport(record, 0, 2);
    expect(result.durationSec).toBe(2);
    expect(state.workers).toEqual([]);
    expect(state.spawns).toHaveLength(1); // final encode only
  });

  test("concurrent different horizons do not adopt or cancel each other's prefix", async () => {
    const record = longTake();
    const controller = new AbortController();
    const short = agentAvatar.prepareAvatarVideo(record, undefined, controller.signal, undefined, 2).catch((cause: unknown) => cause);
    const long = agentAvatar.prepareAvatarVideo(record, undefined, undefined, undefined, 4);
    await vi.waitFor(() => expect(state.workers).toHaveLength(2));
    controller.abort();
    expect(await short).toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(state.workers.filter((worker) => !worker.closed)).toHaveLength(1));
    state.workers.find((worker) => !worker.closed)!.frame.resolve("cG5n");
    await long;
    await agentGate.withDerivedCacheCleanup("all", async () => undefined);
    const files = await readdir(join(state.root, "cache"), { recursive: true });
    expect(files.filter((name) => name.includes("partial"))).toEqual([]);
    expect(files.filter((name) => name.endsWith("-frames31.mp4"))).toEqual([]);
    expect(files.filter((name) => name.endsWith("-frames61.mp4"))).toHaveLength(1);
  });

  test("frame rejection drains preparation without publishing, then a retry prepares the same prefix", async () => {
    const record = longTake();
    const pending = rangeExport(record, 0, 2).catch((cause: unknown) => cause);
    await vi.waitFor(() => expect(state.frameTimes).toHaveLength(1));
    state.workers[0]!.frame.reject(new Error("fixture decode failed"));
    expect(await pending).toMatchObject({ message: "fixture decode failed" });
    expect(state.workers[0]!.closed).toBe(true);
    const files = await readdir(join(state.root, "cache"), { recursive: true });
    expect(files.filter((name) => /avatar-|partial/.test(name))).toEqual([]);
    const retry = rangeExport(record, 0, 2);
    await vi.waitFor(() => expect(state.workers).toHaveLength(2));
    state.workers[1]!.frame.resolve("cG5n");
    expect((await retry).durationSec).toBe(2);
    expect(state.frameTimes).toHaveLength(32); // one rejected call + the complete prefix
  });

  test.each(["mp4", "gif"] as const)("a 2-second %s trim omits the unused tail of a 60-second take", async (format) => {
    const pending = rangeExport(longTake(), 0, 2, format);
    await releaseFrames();
    await pending;
    expect(state.frameTimes).toHaveLength(31);
    expect(state.frameTimes.at(-1)).toBe(30 / 15);
    const files = await readdir(join(state.root, "cache", "video", recordId()));
    const manifest = files.find((name) => name.endsWith("-frames31.mp4.json"))!;
    expect(JSON.parse(await readFile(join(state.root, "cache", "video", recordId(), manifest), "utf8"))).toMatchObject({ frameCount: 31, durationSec: 31 / 15, fps: 15 });
    const args = composition();
    expect(args[args.indexOf("-t") + 1]).toBe("2");
  });
});
