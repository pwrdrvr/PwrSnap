// Process/cache lifecycle tests. Audio fidelity is verified separately by
// recording-exporter-audio-ffmpeg.test.ts using real generated tone fixtures.
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

type Child = EventEmitter & { stderr: EventEmitter; kill: ReturnType<typeof vi.fn> };
const state = vi.hoisted(() => ({
  root: "", available: 2, probeError: false,
  calls: [] as Array<{ args: string[]; child: Child }>
}));
vi.mock("electron", () => ({ app: { getPath: () => state.root } }));
vi.mock("../../recording/ffmpeg-resolver", () => ({ resolveFfmpegPath: () => "/fake/ffmpeg" }));
vi.mock("node:child_process", () => ({ spawn: (_bin: string, args: string[]) => {
  const child = new EventEmitter() as Child;
  child.stderr = new EventEmitter();
  child.kill = vi.fn(() => { setImmediate(() => child.emit("close", null)); return true; });
  state.calls.push({ args, child });
  if (args.at(-1) === "-") {
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

function source() {
  return { videoPath: join(state.root, "source.mp4"), hasSystemAudio: true, hasMicrophoneAudio: true };
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
  state.root = mkdtempSync(join(tmpdir(), "pwrsnap-audio-cache-"));
  writeFileSync(source().videoPath, "fixture");
  state.calls.length = 0;
  state.available = 2;
  state.probeError = false;
});
afterEach(() => { rmSync(state.root, { recursive: true, force: true }); });

describe("audio derivative cache lifecycle", () => {
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
