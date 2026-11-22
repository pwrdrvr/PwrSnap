// "Copy Frame" must hand over the picture the stage showed at the playhead:
// the latest frame at or before T. Oracle: real FFmpeg on a generated clip
// whose every frame carries its own timestamp as brightness (Y = 48 + 20·t).
// Each fixture frame's brightness is read back through the same PNG path as
// the still (limited→full range conversion differs between FFmpeg builds),
// and the still must match the reference for the frame on screen at T.
//
// The fixture is shaped like a native recording: frames only where the
// screen changed, so most instants fall in a stretch where an older frame is
// still on screen, the first frame is held, and the last frame is held past
// the end of the track. An accurate seek (`-ss` without
// `-noaccurate_seek`) returns the NEXT change in those stretches and nothing
// at all past the end — both are what this test exists to refuse.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import type { CaptureRecord } from "@pwrsnap/shared";

const state = vi.hoisted(() => ({ root: "" }));
vi.mock("electron", () => ({ app: { getAppPath: () => resolve("apps/desktop"), getPath: () => state.root } }));
vi.mock("../../persistence/paths", () => ({ getCacheRoot: () => state.root }));
vi.mock("../../log", () => ({ getMainLogger: () => ({ info() {}, warn() {}, error() {}, debug() {} }) }));

import { resolveFfmpegPath } from "../ffmpeg-resolver";
import { buildFrameStillArgs, ensureVideoFrameStill, normalizeFrameTime } from "../video-frame-still";
import { frameStillCapturedAt } from "../video-frame-time";

const ffmpeg = resolveFfmpegPath();
const W = 96;
const H = 64;
/** Sparse frame times, like a recorder that appends only changed frames. */
const FRAME_TIMES = [0, 1.25, 1.3, 2.7, 4.05, 6.5];
const DURATION_SEC = 8;

function run(args: string[]): Buffer {
  return execFileSync(ffmpeg!, ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", ...args], {
    timeout: 30_000,
    maxBuffer: 16 * 1024 * 1024
  });
}

/** Mean luma of a PNG, read through FFmpeg so the check is independent of sharp. */
function meanLuma(png: string): number {
  const plane = run(["-i", png, "-vf", "scale=8:8,format=gray", "-f", "rawvideo", "pipe:1"]);
  let sum = 0;
  for (const b of plane) sum += b;
  return sum / plane.length;
}

let dir = "";
let clip = "";
/** Brightness of each FRAME_TIMES frame, decoded the way a still is. */
const referenceLuma = new Map<number, number>();

beforeAll(() => {
  if (ffmpeg === null) return;
  dir = mkdtempSync(join(tmpdir(), "pwrsnap-frame-still-"));
  state.root = join(dir, "cache");
  clip = join(dir, "stills.mp4");
  // Render 100 fps of time-coded luma, then keep only FRAME_TIMES. The
  // `select` keeps their original timestamps (VFR), which is the shape the
  // native recorder writes.
  const keep = FRAME_TIMES.map((t) => `eq(n\\,${Math.round(t * 100)})`).join("+");
  run([
    "-f", "lavfi", "-i", `color=c=black:s=${W}x${H}:r=100:d=${DURATION_SEC}`,
    "-vf", `geq=lum='48+20*T':cb=128:cr=128,select='${keep}'`,
    "-fps_mode", "vfr", "-g", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p", clip
  ]);
  FRAME_TIMES.forEach((t, k) => {
    const ref = join(dir, `ref-${k}.png`);
    run(["-i", clip, "-vf", `select='eq(n\\,${k})'`, "-fps_mode", "passthrough", "-frames:v", "1", ref]);
    referenceLuma.set(t, meanLuma(ref));
  });
});

/** The FRAME_TIMES frame whose reference brightness is nearest. */
function identify(luma: number): number {
  let best = FRAME_TIMES[0]!;
  for (const t of FRAME_TIMES) {
    if (Math.abs(referenceLuma.get(t)! - luma) < Math.abs(referenceLuma.get(best)! - luma)) best = t;
  }
  return best;
}

afterAll(() => {
  if (dir !== "") rmSync(dir, { recursive: true, force: true });
});

function record(): CaptureRecord {
  return {
    id: "framestill000001",
    kind: "video",
    legacy_src_path: clip,
    video: { durationSec: DURATION_SEC }
  } as unknown as CaptureRecord;
}

/** The oracle: the frame a player shows at T. */
function frameOnScreenAt(t: number): number {
  let shown = FRAME_TIMES[0]!;
  for (const f of FRAME_TIMES) if (f <= t + 1e-9) shown = f;
  return shown;
}

describe.skipIf(ffmpeg === null)("video frame still (real FFmpeg)", () => {
  test("every playhead time yields the latest frame at or before it", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc.integer({ min: 0, max: (DURATION_SEC + 1) * 1000 }).map((ms) => ms / 1000),
          // Exactly on a frame, and a hair either side of one.
          fc.constantFrom(...FRAME_TIMES).chain((f) =>
            fc.constantFrom(f, Math.max(0, f - 0.001), f + 0.001)
          )
        ),
        async (t) => {
          const still = await ensureVideoFrameStill(record(), t);
          expect(still.widthPx).toBe(W);
          expect(still.heightPx).toBe(H);
          const expectedT = frameOnScreenAt(normalizeFrameTime(t, DURATION_SEC));
          expect(identify(meanLuma(still.path))).toBe(expectedT);
        }
      ),
      { numRuns: 24 }
    );
  }, 120_000);

  test("argv seeks to a keyframe, never accurately (which returns the next change)", () => {
    const args = buildFrameStillArgs({ sourcePath: "/in.mp4", seekSec: 2.5, selectSec: 0, outputPath: "/o.png" });
    expect(args).toContain("-noaccurate_seek");
    expect(args.slice(args.indexOf("-ss"), args.indexOf("-ss") + 2)).toEqual(["-ss", "2.500"]);
    expect(args.indexOf("-ss")).toBeLessThan(args.indexOf("-i"));
    expect(args).toContain("-update");
  });
});

describe("frame time helpers", () => {
  test("normalizeFrameTime stays inside the clip on whole milliseconds", () => {
    fc.assert(
      fc.property(fc.double({ noNaN: false }), fc.double({ min: 0, max: 1e5, noNaN: true }), (t, d) => {
        const n = normalizeFrameTime(t, d);
        expect(n).toBeGreaterThanOrEqual(0);
        expect(n).toBeLessThanOrEqual(Math.round(d * 1000) / 1000 + 1e-9);
        expect(Math.abs(n * 1000 - Math.round(n * 1000))).toBeLessThan(1e-6);
      })
    );
  });

  test("a frame's capture time sits inside the take and moves with the playhead", () => {
    const end = Date.parse("2026-11-21T10:00:00.000Z");
    fc.assert(
      fc.property(
        fc.double({ min: 0.1, max: 3600, noNaN: true }),
        fc.double({ min: -10, max: 4000, noNaN: true }),
        fc.double({ min: -10, max: 4000, noNaN: true }),
        (duration, a, b) => {
          const at = (t: number) => Date.parse(frameStillCapturedAt(new Date(end).toISOString(), duration, t));
          const [lo, hi] = a <= b ? [a, b] : [b, a];
          expect(at(lo)).toBeLessThanOrEqual(at(hi));
          expect(at(lo)).toBeGreaterThanOrEqual(end - duration * 1000 - 1);
          expect(at(hi)).toBeLessThanOrEqual(end);
        }
      )
    );
  });
});
