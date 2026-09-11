// Process/cache lifecycle tests. Audio fidelity is verified separately by
// recording-exporter-audio-ffmpeg.test.ts using real generated tone fixtures.
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

type Child = EventEmitter & { stderr: EventEmitter; kill: ReturnType<typeof vi.fn> };
const state = vi.hoisted(() => ({
  root: "", available: 2, probeError: false,
  holdProbe: false, holdClose: false,
  beforeStat: null as null | (() => Promise<void>),
  beforeRemove: null as null | ((path: string) => Promise<void>),
  beforeRename: null as null | (() => Promise<void>),
  calls: [] as Array<{ args: string[]; child: Child }>
}));
vi.mock("electron", () => ({ app: { getPath: () => state.root } }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...fs,
    stat: async (...args: Parameters<typeof fs.stat>) => {
      if (String(args[0]) === join(state.root, "source.mp4")) await state.beforeStat?.();
      return fs.stat(...args);
    },
    rm: async (...args: Parameters<typeof fs.rm>) => {
      await state.beforeRemove?.(String(args[0]));
      return fs.rm(...args);
    },
    rename: async (...args: Parameters<typeof fs.rename>) => {
      await state.beforeRename?.();
      return fs.rename(...args);
    }
  };
});
vi.mock("../../log", () => ({ getMainLogger: () => ({ info() {}, warn() {}, error() {}, debug() {} }) }));
vi.mock("../../persistence/db", () => ({ getDb: () => ({ prepare: () => ({ all: () => [] }) }) }));
vi.mock("../../persistence/layers-repo", () => ({ listLayerTree: () => [] }));
vi.mock("../../render/compose-tree", () => ({ computeTreeRenderHash: () => "unused" }));
vi.mock("../../recording/ffmpeg-resolver", () => ({ resolveFfmpegPath: () => "/fake/ffmpeg" }));
vi.mock("node:child_process", () => ({ spawn: (_bin: string, args: string[]) => {
  const child = new EventEmitter() as Child;
  child.stderr = new EventEmitter();
  child.kill = vi.fn(() => {
    if (!state.holdClose) setImmediate(() => child.emit("close", null));
    return true;
  });
  state.calls.push({ args, child });
  if (args.at(-1) === "-" && !state.holdProbe) {
    setImmediate(() => {
      child.stderr.emit("data", Buffer.from("Input #0, mov, from 'fixture':\n"));
      for (let i = 0; i < state.available; i++) {
        // Split header across chunks, including mp4 stream id and language.
        child.stderr.emit("data", Buffer.from(`  Stream #0:${i + 1}[0x${i + 2}](un`));
        child.stderr.emit("data", Buffer.from("d): Audio: aac, 48000 Hz\n"));
      }
      // Ignore output stream declarations and unrelated diagnostics.
      child.stderr.emit("data", Buffer.from("Stream mapping:\nOutput #0, null:\n  Stream #0:9: Audio: aac\n"));
      child.emit("close", state.probeError ? 1 : 0);
    });
  }
  return child;
} }));

import { extractVideoAudio, prepareVideoPlayback } from "../audio-extract";
import { probeAudioStreamCount } from "../../recording/recording-audio";
import { getCacheRoot } from "../../persistence/paths";
import { purgeCacheForCapture } from "../../persistence/source-store";
import { clearRenderCache, removeLegacyVideoPlaybackCache, trimRenderCache } from "../../persistence/render-cache-maintenance";

function source() {
  return { captureId: "capture-a", videoPath: join(state.root, "source.mp4"), hasSystemAudio: true, hasMicrophoneAudio: true };
}
function encodes() { return state.calls.filter((call) => call.args.at(-1) !== "-"); }
async function nextEncode() {
  await vi.waitFor(() => expect(encodes().length).toBeGreaterThan(0));
  return encodes().at(-1)!;
}
function finish(call: ReturnType<typeof encodes>[number], code = 0, bytes = "encoded") {
  writeFileSync(call.args.at(-1)!, bytes);
  call.child.emit("close", code);
}

beforeEach(() => {
  vi.stubEnv("PWRSNAP_DATA_ROOT", "");
  state.root = mkdtempSync(join(tmpdir(), "pwrsnap-audio-cache-"));
  writeFileSync(source().videoPath, "fixture");
  state.calls.length = 0;
  state.available = 2;
  state.probeError = false;
  state.holdProbe = false;
  state.holdClose = false;
  state.beforeStat = null;
  state.beforeRemove = null;
  state.beforeRename = null;
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(state.root, { recursive: true, force: true });
});

function barrier() {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  return { pending, release };
}

const cleanups = [
  { name: "purge", run: () => purgeCacheForCapture(source().captureId) },
  { name: "Clear", run: clearRenderCache },
  { name: "Trim", run: trimRenderCache }
];

function writeFixture(path: string, bytes = "keep") {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}

function legacyPlaybackPath() { return join(state.root, "sizzle-cache", "video-playback", "old.mp4"); }

function retainedFixtures() {
  return [
    source().videoPath,
    join(state.root, "sizzle-cache", "native-audio", "keep.m4a"),
    join(state.root, "sizzle-cache", "silence", "keep.m4a"),
    join(state.root, "sizzle-cache", "music", "keep.mp3"),
    join(state.root, "pwrsnap.db"),
    join(state.root, "pwrsnap-settings.json")
  ];
}

describe("audio derivative cache lifecycle", () => {
  test.each(cleanups)("$name removes a finished playback copy through production cleanup and preserves originals", async ({ name, run }) => {
    const pending = prepareVideoPlayback(source());
    finish(await nextEncode());
    const path = await pending;
    expect(dirname(path)).toBe(join(getCacheRoot(), "video", source().captureId));
    expect(path).toMatch(/playback-[a-f0-9]+\.mp4$/);
    writeFixture(legacyPlaybackPath(), "obsolete full MP4");
    for (const keep of retainedFixtures()) writeFixture(keep);
    const otherCapture = join(getCacheRoot(), "video", "capture-b", "other.mp4");
    writeFixture(otherCapture);

    await run();
    expect(existsSync(path)).toBe(false);
    expect(existsSync(dirname(path))).toBe(false);
    expect(existsSync(legacyPlaybackPath())).toBe(false);
    for (const keep of retainedFixtures()) expect(readFileSync(keep, "utf8")).toBe("keep");
    expect(existsSync(otherCapture)).toBe(name === "purge");
  });

  test("startup migration removes only the obsolete full-MP4 bucket, including with a data-root override", async () => {
    vi.stubEnv("PWRSNAP_DATA_ROOT", join(state.root, "override"));
    writeFixture(legacyPlaybackPath());
    for (const keep of retainedFixtures()) writeFixture(keep);
    const current = join(getCacheRoot(), "video", source().captureId, "playback-current.mp4");
    writeFixture(current);
    await removeLegacyVideoPlaybackCache();
    await removeLegacyVideoPlaybackCache();
    expect(existsSync(dirname(legacyPlaybackPath()))).toBe(false);
    expect(readFileSync(current, "utf8")).toBe("keep");
    for (const keep of retainedFixtures()) expect(readFileSync(keep, "utf8")).toBe("keep");
  });

  test.each(cleanups)("$name cancels coalesced active encodes and waits for child close and staging removal", async ({ run }) => {
    state.holdClose = true;
    const a = prepareVideoPlayback(source());
    const b = prepareVideoPlayback(source());
    const rejected = Promise.all([a, b].map((p) => expect(p).rejects.toMatchObject({ name: "AbortError" })));
    const encode = await nextEncode();
    const staging = encode.args.at(-1)!;
    writeFileSync(staging, "incomplete MP4");
    const removing = barrier();
    const entered = barrier();
    state.beforeRemove = async (path) => {
      if (path === staging) { entered.release(); await removing.pending; }
    };
    let cleanupDone = false;
    let preparationDone = false;
    void rejected.then(() => { preparationDone = true; });
    const cleanup = run().then(() => { cleanupDone = true; });
    expect(encode.child.kill).toHaveBeenCalledWith("SIGKILL");
    await new Promise((resolve) => setImmediate(resolve));
    expect(cleanupDone).toBe(false);
    expect(existsSync(staging)).toBe(true);
    encode.child.emit("close", null);
    await entered.pending;
    expect(cleanupDone).toBe(false);
    expect(preparationDone).toBe(false);
    removing.release();
    await Promise.all([rejected, cleanup]);
    expect(existsSync(staging)).toBe(false);
    expect(existsSync(dirname(staging))).toBe(false);
    expect(readFileSync(source().videoPath, "utf8")).toBe("fixture");
    expect(encodes()).toHaveLength(1);
  });

  for (const stage of ["queued", "stat", "probe", "rename"] as const) {
    test.each(cleanups)(`$name drains ${stage} preparation without recreating the cache`, async ({ run }) => {
      const blocked = barrier();
      const entered = barrier();
      if (stage === "stat") state.beforeStat = async () => { entered.release(); await blocked.pending; };
      if (stage === "probe") { state.holdProbe = true; state.holdClose = true; }
      if (stage === "rename") state.beforeRename = async () => { entered.release(); await blocked.pending; };
      const pending = prepareVideoPlayback(source());
      const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
      if (stage === "stat") await entered.pending;
      if (stage === "probe") await vi.waitFor(() => expect(state.calls).toHaveLength(1));
      if (stage === "rename") { finish(await nextEncode()); await entered.pending; }
      const cleanup = run();
      if (stage === "probe") {
        expect(state.calls[0]!.child.kill).toHaveBeenCalledWith("SIGKILL");
        state.calls[0]!.child.emit("close", null);
      }
      blocked.release();
      await Promise.all([rejected, cleanup]);
      expect(existsSync(join(getCacheRoot(), "video", source().captureId))).toBe(false);
      expect(encodes()).toHaveLength(stage === "rename" ? 1 : 0);
      if (stage === "queued" || stage === "stat") expect(state.calls).toHaveLength(0);
      expect(readFileSync(source().videoPath, "utf8")).toBe("fixture");
    });
  }

  test.each(cleanups)("$name rejects new prepares throughout filesystem cleanup", async ({ name, run }) => {
    const blocked = barrier();
    const entered = barrier();
    state.beforeRemove = async (path) => {
      if (path === dirname(legacyPlaybackPath())) { entered.release(); await blocked.pending; }
    };
    const cleanup = run();
    await entered.pending;
    await expect(prepareVideoPlayback(source())).rejects.toMatchObject({ name: "AbortError" });
    const other = prepareVideoPlayback({ ...source(), captureId: "capture-b", hasMicrophoneAudio: false });
    if (name === "purge") await expect(other).resolves.toBe(source().videoPath);
    else await expect(other).rejects.toMatchObject({ name: "AbortError" });
    expect(state.calls).toHaveLength(0);
    blocked.release();
    await cleanup;
    // Clear/Trim are temporary gates; captures still present in the DB can
    // rebuild on demand. Purged captures are excluded by the protocol's
    // synchronous DB recheck before it calls prepareVideoPlayback.
    if (name !== "purge") {
      const retry = prepareVideoPlayback(source());
      finish(await nextEncode());
      await expect(retry).resolves.toMatch(/playback-.*\.mp4$/);
    }
  });

  test("overlapping Clear and Trim keep admission closed until both filesystem cleanups finish", async () => {
    const first = barrier();
    const firstEntered = barrier();
    const second = barrier();
    const secondEntered = barrier();
    let passes = 0;
    state.beforeRemove = async (path) => {
      if (path !== dirname(legacyPlaybackPath())) return;
      if (++passes === 1) { firstEntered.release(); await first.pending; }
      else { secondEntered.release(); await second.pending; }
    };
    const clear = clearRenderCache();
    const trim = trimRenderCache();
    await firstEntered.pending;
    first.release();
    await clear;
    await secondEntered.pending;
    await expect(prepareVideoPlayback(source())).rejects.toMatchObject({ name: "AbortError" });
    second.release();
    await trim;
    const retry = prepareVideoPlayback(source());
    finish(await nextEncode());
    await expect(retry).resolves.toMatch(/playback-.*\.mp4$/);
  });

  test("a failed Clear releases admission and does not poison the next cleanup", async () => {
    state.beforeRemove = async (path) => {
      if (path === dirname(legacyPlaybackPath())) throw new Error("fixture removal failure");
    };
    await expect(clearRenderCache()).rejects.toThrow("fixture removal failure");
    state.beforeRemove = null;
    const retry = prepareVideoPlayback(source());
    finish(await nextEncode());
    const path = await retry;
    await trimRenderCache();
    expect(existsSync(path)).toBe(false);
  });

  test.each(["playback", "extraction"])("%s coalesces cold requests and publishes only after FFmpeg closes", async (kind) => {
    const start = () => kind === "playback" ? prepareVideoPlayback(source()) : extractVideoAudio({ ...source(), startSec: 0, durationSec: 2 });
    const a = start();
    const b = start();
    const encode = await nextEncode();
    expect(state.calls).toHaveLength(2); // one probe + one encode
    const staging = encode.args.at(-1)!;
    expect(staging).toContain(".partial.");
    writeFileSync(staging, "unfinished media");
    expect(await readdir(dirname(staging))).toEqual([staging.split(/[\\/]/).at(-1)]);
    let settled = false;
    void b.then(() => { settled = true; });
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    finish(encode);
    const [first, second] = await Promise.all([a, b]);
    expect(first).toBe(second);
    expect(first).not.toBe(staging);
    expect(existsSync(first)).toBe(true);
    expect(existsSync(staging)).toBe(false);
    expect(await start()).toBe(first);
    expect(state.calls).toHaveLength(2);
  });

  test.each(["failed", "empty"])("%s encode removes staging, clears shared failure, and allows retry", async (kind) => {
    const pending = prepareVideoPlayback(source());
    const rejection = expect(pending).rejects.toThrow(/ffmpeg/);
    const encode = await nextEncode();
    finish(encode, kind === "failed" ? 1 : 0, kind === "empty" ? "" : "truncated");
    await rejection;
    expect(await readdir(dirname(encode.args.at(-1)!))).toEqual([]);
    state.calls.length = 0;
    const retry = prepareVideoPlayback(source());
    finish(await nextEncode());
    await expect(retry).resolves.toMatch(/\.mp4$/);
  });

  test("failed probe is surfaced instead of silently assuming no audio", async () => {
    state.probeError = true;
    await expect(prepareVideoPlayback(source())).rejects.toThrow(/ffmpeg exited/);
    expect(encodes()).toHaveLength(0);
    state.probeError = false;
    state.available = 1;
    await expect(prepareVideoPlayback(source())).resolves.toBe(source().videoPath);
    expect(encodes()).toHaveLength(0);
  });

  test("single-track playback uses the original without stat, probing or encoding", async () => {
    await expect(prepareVideoPlayback({ ...source(), videoPath: "/not-read.mp4", hasSystemAudio: false })).resolves.toBe("/not-read.mp4");
    expect(state.calls).toHaveLength(0);
  });

  test("probe counts only input audio headers across arbitrary stderr chunks", async () => {
    expect(await probeAudioStreamCount(source().videoPath)).toBe(2);
    state.available = 0;
    expect(await probeAudioStreamCount(source().videoPath)).toBe(0);
  });

  test("aborting a probe kills its child and rejects", async () => {
    const controller = new AbortController();
    const pending = probeAudioStreamCount(source().videoPath, controller.signal);
    const rejection = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await rejection;
    expect(state.calls[0]?.child.kill).toHaveBeenCalledWith("SIGKILL");
  });
});
