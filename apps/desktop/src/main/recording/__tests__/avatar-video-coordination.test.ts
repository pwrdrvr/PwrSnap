// Real exporter, presenter preparation, admission gates and process bridge.
// Only the camera renderer and FFmpeg are faked; staging/publishing/cleanup
// use real files. Isolated module registries model the two process owners.
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi, type MockInstance } from "vitest";
import { DEFAULT_AVATAR_STYLE, type CaptureRecord, type CommandName } from "@pwrsnap/shared";
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
vi.mock("../../persistence/video-repo", () => ({ lookupExport: () => null, recordExport: vi.fn() }));
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
    async call(name: string) { return name === "frame" ? this.frame.promise : undefined; }
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
