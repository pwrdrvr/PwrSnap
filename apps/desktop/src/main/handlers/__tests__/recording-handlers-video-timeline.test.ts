// Bus-level coverage for the timeline verbs added by the video
// transport + trim work (plan 2026-08-15-001):
//
//   • video:setDefaultRange — normalizes, persists, and broadcasts
//     `events:captures:changed` so the Library revalidates the record.
//   • video:frames — validates, delegates to the contact-strip
//     extractor, and returns a `pwrsnap-cache://v/…` URL + geometry.
//   • video:audio — short-circuits to `{ hasAudio: false }` for silent
//     recordings without spawning ffmpeg; mirrors the m4a otherwise.
//   • video:presetMetrics — size estimates re-derive from the persisted
//     range duration (a trimmed clip estimates smaller).
//
// ffmpeg, better-sqlite3, and the recorder are all mocked.

import { tmpdir } from "node:os";
// Aliased because a `vi.mock` factory references it, and those are hoisted
// above the imports — the alias keeps the two uses visibly distinct.
import { join, join as joinPath } from "node:path";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { CaptureRecord, VideoRange } from "@pwrsnap/shared";

const mocks = vi.hoisted(() => ({
  capture: null as CaptureRecord | null,
  /**
   * Cache root the mocked `videoAssetDir` answers from — a FRESH temp
   * directory per test (see `beforeEach`).
   *
   * This file used to point every path at the fixed, absolute
   * `/tmp/pwrsnap-test-cache`, and that is what made the sweep specs flaky
   * under load. Two things wipe that directory out from under a running
   * test:
   *
   *   • a SECOND `pnpm test` on the same machine — a second worktree, a
   *     second agent session, another shard on the same runner. Its
   *     `beforeEach` `rm -rf` lands between this run's `seed()` and its
   *     assertion, the handler's `mkdir` puts the (empty) directory back,
   *     and `present()` reports `[]` — bystanders the test itself wrote
   *     included;
   *   • this very run, when a test body exceeds the 5s default timeout.
   *     Vitest abandons the body but does NOT cancel it, then runs the next
   *     test's hooks — so a shared-path `rm -rf` from test N+1 could race
   *     the abandoned continuation of test N.
   *
   * A private directory per test closes both: no other process can guess
   * it, and no sibling test shares it. It also keeps the derived-cache
   * gate's module-global in-flight map from coalescing two tests onto one
   * entry, since that map is keyed by the output path.
   */
  cacheRoot: "",
  /** `cacheRoot` before the first `beforeEach`, so a caller that reaches for a
   *  path during module import fails here instead of being handed `/userdata`
   *  — a directory at the ROOT of the filesystem, which a container running as
   *  root would happily create. */
  requireCacheRoot(): string {
    if (mocks.cacheRoot === "") {
      throw new Error("mocks.cacheRoot read before beforeEach assigned a per-test temp root");
    }
    return mocks.cacheRoot;
  },
  setDefaultRange: vi.fn((_: string, range: VideoRange) => range),
  broadcast: vi.fn(),
  ensureVideoFrames: vi.fn(),
  extractVideoAudio: vi.fn(),
  prepareVideoPlayback: vi.fn()
}));

vi.mock("electron", (): Partial<typeof import("electron")> => ({
  systemPreferences: {
    getMediaAccessStatus: () => "granted"
  } as unknown as typeof import("electron").systemPreferences,
  shell: {
    openExternal: async () => undefined
  } as unknown as typeof import("electron").shell,
  BrowserWindow: {
    getAllWindows: () => []
  } as unknown as typeof import("electron").BrowserWindow,
  app: {
    getPath: () => `${mocks.requireCacheRoot()}/userdata`
  } as unknown as typeof import("electron").app
}));

vi.mock("../../persistence/captures-repo", () => ({
  getCaptureById: () => mocks.capture
}));

vi.mock("../../persistence/video-repo", () => ({
  getVideoMetadata: () => mocks.capture?.video ?? null,
  lookupExport: () => null,
  normalizeRange: (range: VideoRange, durationSec: number) => {
    const start = Math.max(0, Math.min(range.start, durationSec));
    const end = Math.max(start, Math.min(range.end, durationSec));
    return { start, end };
  },
  setDefaultRange: mocks.setDefaultRange
}));

vi.mock("../../events", () => ({
  broadcastCapturesChanged: mocks.broadcast
}));

vi.mock("../../recording/video-frames", () => ({
  ensureVideoFrames: mocks.ensureVideoFrames,
  videoAssetDir: (id: string) => joinPath(mocks.requireCacheRoot(), "video", id)
}));

vi.mock("../../sizzle/audio-extract", () => ({
  extractVideoAudio: mocks.extractVideoAudio,
  prepareVideoPlayback: (...args: unknown[]) => mocks.prepareVideoPlayback(...args),
  // Fixed so the expected filename is spelled once, in PLAYBACK_KEY.
  computeVideoPlaybackCacheKey: async () => PLAYBACK_KEY,
  // The asset filename is derived from this, at module scope. Omitting it
  // made the handler import `undefined.m4a`.
  AUDIO_PIPELINE_VERSION: "mixed-audio-v2"
}));

const PLAYBACK_KEY = "0123456789abcdef01234567";

vi.mock("../../recording/recording-service", () => ({
  getRecordingService: () => ({
    start: vi.fn(),
    stop: vi.fn(),
    cancel: vi.fn(),
    restart: vi.fn(),
    isActive: () => false
  })
}));

vi.mock("../../recording/video-poster", () => ({
  ensureVideoPoster: async () => "/tmp/poster.png"
}));

vi.mock("../../render/file-alias", () => ({
  prepareRenderedFileAlias: async (path: string) => path
}));

const { bus } = await import("../../command-bus");
const { resetDerivedCacheGateForTests } = await import("../../persistence/derived-cache-gate");
const { registerRecordingHandlers } = await import("../recording-handlers");

registerRecordingHandlers();

function videoCapture(overrides: Partial<NonNullable<CaptureRecord["video"]>> = {}): CaptureRecord {
  return {
    id: "vid_Timeline1",
    kind: "video",
    captured_at: "2026-08-15T12:00:00.000Z",
    legacy_src_path: "/tmp/vid_Timeline1.mp4",
    bundle_path: null,
    flat_png_path: null,
    bundle_modified_at: null,
    bundle_format_version: 1,
    bundle_edits_version: 0,
    width_px: 1920,
    height_px: 1080,
    device_pixel_ratio: 1,
    byte_size: 10_000_000,
    sha256: "sha-timeline",
    edits_version: 0,
    source_app_bundle_id: null,
    source_app_name: null,
    source_window_title: null,
    has_alpha: false,
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
    video: {
      durationSec: 16,
      containerFormat: "mp4",
      hasSystemAudio: false,
      hasMicrophoneAudio: false,
      requestedSystemAudio: false,
      requestedMicrophone: false,
      defaultRange: { start: 0, end: 16 },
      previewPath: null,
      previewStatus: "ready",
      ...overrides
    }
  } as CaptureRecord;
}

/** Per-run root, removed wholesale in `afterAll`. */
let runRoot = "";
/** Every root handed out, so the guard spec below can prove they differ. */
const handedOut: string[] = [];

/**
 * The capture's asset directory for the CURRENTLY running test.
 *
 * Resolve it ONCE, at the top of the test, and pass the result around. The
 * root moves in `beforeEach`, so a helper that calls this again later reads
 * whichever test is running THEN — which for a body vitest abandoned at its
 * 5s timeout is somebody else's fixture.
 */
function videoDir(): string {
  return joinPath(mocks.requireCacheRoot(), "video", "vid_Timeline1");
}

beforeAll(async () => {
  runRoot = await mkdtemp(join(tmpdir(), "pwrsnap-video-timeline-"));
});

afterAll(async () => {
  await rm(runRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  mocks.capture = videoCapture();
  mocks.setDefaultRange.mockClear();
  mocks.broadcast.mockClear();
  mocks.ensureVideoFrames.mockReset();
  mocks.extractVideoAudio.mockReset();
  mocks.prepareVideoPlayback.mockReset();
  // A fresh directory rather than emptying a shared one: nothing to race.
  // It also moves the gate's in-flight key, which is the output path — so no
  // leaked entry from an earlier test can be ADOPTED by this one.
  mocks.cacheRoot = await mkdtemp(join(runRoot, "t-"));
  handedOut.push(mocks.cacheRoot);
  // Not redundant with the line above: that stops adoption, this drops the
  // leaked entry itself along with its abort listener, so a write abandoned
  // by a timed-out test cannot publish into a directory we still own.
  resetDerivedCacheGateForTests();
});

// The prepared rendition is a FULL COPY of a recording, so the lane that
// writes them is also the only thing that reclaims them. These pin the
// deletion itself — the predicates are pinned in protocols-parse.test.ts,
// but nothing there says this handler actually removes the right files.
describe("video:playback rendition sweep", () => {
  const CURRENT = `playback-mixed-audio-v2-${PLAYBACK_KEY}.mp4`;
  // Everything that must survive: the other lane's asset, an older spelling
  // of it, and the filmstrip in both of its spellings.
  const BYSTANDERS = ["mixed-audio-v2.m4a", "audio.m4a", "frames-v2-n24-w96.jpg", "frames-n24-w96.jpg"];
  // Renditions of earlier revisions of the same source, including the
  // unkeyed name #496 shipped.
  const STALE = ["playback-mixed-audio-v2.mp4", "playback-mixed-audio-v2-feedfacefeedfacefeedface.mp4"];

  async function seed(dir: string): Promise<void> {
    await mkdir(dir, { recursive: true });
    for (const name of [...BYSTANDERS, ...STALE]) await writeFile(joinPath(dir, name), "x");
  }
  // Takes the directory rather than re-resolving it, and deliberately does NOT
  // swallow a read failure. The old `.catch(() => [])` turned "the directory is
  // gone" into a perfectly plausible empty listing, which is how a cross-run
  // collision read as "the sweep took the bystanders with it" for as long as
  // it did.
  async function present(dir: string): Promise<string[]> {
    return (await readdir(dir)).sort();
  }
  /** Both audible, so the predicate demands a rendition. */
  const dualAudio = {
    hasSystemAudio: true,
    hasMicrophoneAudio: true,
    requestedSystemAudio: true,
    requestedMicrophone: true
  };

  test("keeps the rendition it just published and retires the older ones", async () => {
    const dir = videoDir();
    mocks.capture = videoCapture(dualAudio);
    await seed(dir);
    mocks.prepareVideoPlayback.mockImplementation(async (target: string) => {
      await writeFile(target, "rendition");
      return target;
    });

    const result = await bus.dispatch("video:playback", { captureId: "vid_Timeline1" }, { principal: "ipc" });
    expect(result).toMatchObject({ ok: true, value: { prepared: true } });
    expect((result as { value: { url: string } }).value.url).toContain(CURRENT);
    expect(await present(dir)).toEqual([...BYSTANDERS, CURRENT].sort());
  });

  // The decline path: metadata claims two tracks, the file disagrees, so
  // preparation hands back the original. Returning early here is what left
  // a source-sized rendition that nothing would EVER collect — every later
  // call takes the same early return.
  test("retires every rendition when preparation declines and the original plays", async () => {
    const dir = videoDir();
    mocks.capture = videoCapture(dualAudio);
    await seed(dir);
    mocks.prepareVideoPlayback.mockImplementation(
      async (_target: string, args: { videoPath: string }) => args.videoPath
    );

    const result = await bus.dispatch("video:playback", { captureId: "vid_Timeline1" }, { principal: "ipc" });
    expect(result).toMatchObject({ ok: true, value: { prepared: false } });
    expect(await present(dir)).toEqual([...BYSTANDERS].sort());
  });

  test("a capture that needs no rendition sweeps nothing and never prepares", async () => {
    // Mic only: it already occupies the slot a player takes.
    const dir = videoDir();
    mocks.capture = videoCapture({ hasMicrophoneAudio: true, requestedMicrophone: true });
    await seed(dir);

    const result = await bus.dispatch("video:playback", { captureId: "vid_Timeline1" }, { principal: "ipc" });
    expect(result).toMatchObject({ ok: true, value: { prepared: false } });
    expect(mocks.prepareVideoPlayback).not.toHaveBeenCalled();
    expect(await present(dir)).toEqual([...BYSTANDERS, ...STALE].sort());
  });
});

describe("video:setDefaultRange", () => {
  test("persists the normalized range and broadcasts captures:changed", async () => {
    const result = await bus.dispatch(
      "video:setDefaultRange",
      { captureId: "vid_Timeline1", range: { start: 3.4, end: 11.2 } },
      { principal: "ipc" }
    );
    expect(result.ok).toBe(true);
    expect(mocks.setDefaultRange).toHaveBeenCalledWith("vid_Timeline1", { start: 3.4, end: 11.2 });
    expect(mocks.broadcast).toHaveBeenCalledWith(["vid_Timeline1"]);
  });

  test("clamps an out-of-bounds range to the clip before persisting", async () => {
    const result = await bus.dispatch(
      "video:setDefaultRange",
      { captureId: "vid_Timeline1", range: { start: -1, end: 99 } },
      { principal: "ipc" }
    );
    expect(result.ok).toBe(true);
    expect(mocks.setDefaultRange).toHaveBeenCalledWith("vid_Timeline1", { start: 0, end: 16 });
  });

  test("rejects non-finite ranges and image captures without touching the repo", async () => {
    const bad = await bus.dispatch(
      "video:setDefaultRange",
      { captureId: "vid_Timeline1", range: { start: Number.NaN, end: 2 } },
      { principal: "ipc" }
    );
    expect(bad.ok).toBe(false);
    if (bad.ok) throw new Error("expected error");
    expect(bad.error.code).toBe("invalid_range");

    mocks.capture = { ...videoCapture(), kind: "image", video: null } as CaptureRecord;
    const img = await bus.dispatch(
      "video:setDefaultRange",
      { captureId: "vid_Timeline1", range: { start: 0, end: 1 } },
      { principal: "ipc" }
    );
    expect(img.ok).toBe(false);
    if (img.ok) throw new Error("expected error");
    expect(img.error.code).toBe("not_a_video");
    expect(mocks.setDefaultRange).not.toHaveBeenCalled();
    expect(mocks.broadcast).not.toHaveBeenCalled();
  });

  test("rejects inverted and too-short ranges without persisting a zero-length default", async () => {
    for (const range of [
      { start: 10, end: 2 },
      { start: 4, end: 4.05 }
    ]) {
      const result = await bus.dispatch(
        "video:setDefaultRange",
        { captureId: "vid_Timeline1", range },
        { principal: "ipc" }
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected error");
      expect(result.error.code).toBe("invalid_range");
    }
    expect(mocks.setDefaultRange).not.toHaveBeenCalled();
    expect(mocks.broadcast).not.toHaveBeenCalled();
  });
});

describe("video:frames", () => {
  test("returns a v/ cache URL plus the strip geometry from the extractor", async () => {
    mocks.ensureVideoFrames.mockResolvedValue({
      path: joinPath(videoDir(), "frames-v2-n24-w96.jpg"),
      fileName: "frames-v2-n24-w96.jpg",
      spec: { count: 24, frameWidth: 96, frameHeight: 54 }
    });
    const result = await bus.dispatch(
      "video:frames",
      { captureId: "vid_Timeline1", count: 24, frameWidth: 96 },
      { principal: "ipc" }
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value).toEqual({
      url: "pwrsnap-cache://v/vid_Timeline1/frames-v2-n24-w96.jpg",
      frameCount: 24,
      frameWidth: 96,
      frameHeight: 54
    });
    expect(mocks.ensureVideoFrames).toHaveBeenCalledWith(
      expect.objectContaining({ id: "vid_Timeline1" }),
      expect.objectContaining({ durationSec: 16 }),
      { count: 24, frameWidth: 96 }
    );
  });

  test("maps extractor failures to a render error", async () => {
    mocks.ensureVideoFrames.mockRejectedValue(new Error("ffmpeg exited 1"));
    const result = await bus.dispatch(
      "video:frames",
      { captureId: "vid_Timeline1" },
      { principal: "ipc" }
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.kind).toBe("render");
    expect(result.error.code).toBe("video_frames_failed");
  });

  test("rejects a non-finite count", async () => {
    const result = await bus.dispatch(
      "video:frames",
      { captureId: "vid_Timeline1", count: Number.POSITIVE_INFINITY },
      { principal: "ipc" }
    );
    expect(result.ok).toBe(false);
    expect(mocks.ensureVideoFrames).not.toHaveBeenCalled();
  });
});

describe("video:audio", () => {
  test("silent recordings return hasAudio:false without extracting", async () => {
    const result = await bus.dispatch(
      "video:audio",
      { captureId: "vid_Timeline1" },
      { principal: "ipc" }
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value).toEqual({ hasAudio: false });
    expect(mocks.extractVideoAudio).not.toHaveBeenCalled();
  });

  test("extraction failure maps to a render error", async () => {
    mocks.capture = videoCapture({ hasSystemAudio: true });
    mocks.extractVideoAudio.mockRejectedValue(new Error("boom"));
    const result = await bus.dispatch(
      "video:audio",
      { captureId: "vid_Timeline1" },
      { principal: "ipc" }
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.code).toBe("video_audio_failed");
    expect(mocks.extractVideoAudio).toHaveBeenCalledWith({
      videoPath: "/tmp/vid_Timeline1.mp4",
      hasSystemAudio: true,
      hasMicrophoneAudio: false,
      // Forwarded so the extractor can place the microphone at the index the
      // recorder actually wrote it to, rather than inferring one from which
      // sources happened to carry samples.
      requestedSystemAudio: false,
      requestedMicrophone: false,
      startSec: 0,
      durationSec: 16
    // The gate's signal, threaded so a purge can cut a full-clip extract
    // short instead of waiting it out.
    }, expect.any(AbortSignal));
  });

  test("replaces legacy single-track waveform audio with both recorded tracks", async () => {
    mocks.capture = videoCapture({ hasSystemAudio: true, hasMicrophoneAudio: true });
    const dir = videoDir();
    await mkdir(dir, { recursive: true });
    await writeFile(joinPath(dir, "audio.m4a"), "old system-only audio");
    const extracted = joinPath(dir, "extracted.m4a");
    await writeFile(extracted, "mixed system and microphone");
    mocks.extractVideoAudio.mockResolvedValue(extracted);
    const result = await bus.dispatch("video:audio", { captureId: "vid_Timeline1" }, { principal: "ipc" });
    expect(result).toEqual({ ok: true, value: {
      hasAudio: true, url: "pwrsnap-cache://v/vid_Timeline1/mixed-audio-v2.m4a", mimeType: "audio/mp4"
    } });
    expect(mocks.extractVideoAudio).toHaveBeenCalledWith({
      videoPath: "/tmp/vid_Timeline1.mp4", hasSystemAudio: true, hasMicrophoneAudio: true,
      requestedSystemAudio: false, requestedMicrophone: false,
      startSec: 0, durationSec: 16
    }, expect.any(AbortSignal));
    expect(await readFile(joinPath(dir, "mixed-audio-v2.m4a"), "utf8")).toBe(
      "mixed system and microphone"
    );
    mocks.extractVideoAudio.mockClear();
    await bus.dispatch("video:audio", { captureId: "vid_Timeline1" }, { principal: "ipc" });
    expect(mocks.extractVideoAudio).not.toHaveBeenCalled();
  });

  test("joins concurrent extraction requests for the same capture", async () => {
    mocks.capture = videoCapture({ hasSystemAudio: true });
    const extracted = joinPath(mocks.requireCacheRoot(), "video-audio.m4a");
    let finishExtraction: ((path: string) => void) | undefined;
    mocks.extractVideoAudio.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          finishExtraction = resolve;
        })
    );

    const first = bus.dispatch(
      "video:audio",
      { captureId: "vid_Timeline1" },
      { principal: "ipc" }
    );
    await vi.waitFor(() => expect(mocks.extractVideoAudio).toHaveBeenCalledTimes(1));
    const second = bus.dispatch(
      "video:audio",
      { captureId: "vid_Timeline1" },
      { principal: "ipc" }
    );
    await Promise.resolve();
    expect(mocks.extractVideoAudio).toHaveBeenCalledTimes(1);

    await writeFile(extracted, "audio");
    if (finishExtraction === undefined) throw new Error("extraction did not start");
    finishExtraction(extracted);
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.ok).toBe(true);
    expect(secondResult.ok).toBe(true);
    expect(mocks.extractVideoAudio).toHaveBeenCalledTimes(1);
  });
});

describe("video:presetMetrics honors the persisted range", () => {
  test("a trimmed defaultRange yields proportionally smaller MP4 estimates", async () => {
    const full = await bus.dispatch(
      "video:presetMetrics",
      { captureId: "vid_Timeline1" },
      { principal: "ipc" }
    );
    mocks.capture = videoCapture({ defaultRange: { start: 4, end: 12 } });
    const trimmed = await bus.dispatch(
      "video:presetMetrics",
      { captureId: "vid_Timeline1" },
      { principal: "ipc" }
    );
    if (!full.ok || !trimmed.ok) throw new Error("expected ok");
    const fullMed = full.value.metrics.find((m) => m.format === "mp4" && m.preset === "med")!;
    const trimMed = trimmed.value.metrics.find((m) => m.format === "mp4" && m.preset === "med")!;
    expect(trimMed.byteSize).toBe(fullMed.byteSize / 2);
  });
});

// Pins the isolation the specs above depend on. Reverting any path in this
// file to a fixed absolute one — the shape it shipped with — fails here
// rather than as an unreproducible `[]` in the sweep specs weeks later.
describe("fixture isolation", () => {
  test("each test gets a private cache root under the OS temp dir", () => {
    // `mkdtemp` actually ran: a fixed absolute path fails the first two, and
    // a root that IS `tmpdir()` (no unique segment) fails the third.
    expect(runRoot.startsWith(tmpdir())).toBe(true);
    expect(videoDir().startsWith(runRoot)).toBe(true);
    expect(runRoot).not.toBe(tmpdir());
    // Distinct per test, so a sibling's teardown cannot reach into this one —
    // including the teardown of a test vitest abandoned at its 5s timeout.
    // No lower bound on the count: under a `-t` filter this spec is the only
    // one that runs, and a floor of 2 would fail on the very filter someone
    // reaches for while debugging the isolation this pins.
    expect(new Set(handedOut).size).toBe(handedOut.length);
  });
});
