import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let userDataDir = "";
vi.mock("electron", () => ({
  app: {
    getPath: (_: string) => userDataDir
  }
}));

import {
  approximateSpeechTiming,
  resolvePhraseTiming,
  resolveSpeechTiming,
  speechTimingCacheKey
} from "../speech-timing";

let audioPath = "";

beforeEach(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), "pwrsnap-sizzle-speech-timing-"));
  audioPath = join(userDataDir, "narration.mp3");
  await writeFile(audioPath, Buffer.from("FAKE-MP3"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (userDataDir) await rm(userDataDir, { recursive: true, force: true });
});

describe("resolveSpeechTiming", () => {
  it("returns precise word timings from the injected transcriber", async () => {
    const timing = await resolveSpeechTiming({
      provider: "openai",
      model: "tts-1-hd",
      voice: "onyx",
      text: "Generate the code, then approve pairing.",
      audioPath,
      durationSec: 3,
      apiKey: "sk-test",
      transcribe: async () => [
        { word: "Generate", startSec: 0.1, endSec: 0.4 },
        { word: "the", startSec: 0.42, endSec: 0.5 },
        { word: "code", startSec: 0.52, endSec: 0.8 }
      ]
    });

    expect(timing.cached).toBe(false);
    expect(timing.quality).toBe("precise");
    expect(timing.words).toEqual([
      { index: 0, word: "Generate", normalized: "generate", startSec: 0.1, endSec: 0.4 },
      { index: 1, word: "the", normalized: "the", startSec: 0.42, endSec: 0.5 },
      { index: 2, word: "code", normalized: "code", startSec: 0.52, endSec: 0.8 }
    ]);
  });

  it("falls back to approximate timing when precise timing is unavailable", async () => {
    const timing = await resolveSpeechTiming({
      provider: "xai",
      model: "tts-1-hd",
      voice: "onyx",
      text: "Generate the code",
      audioPath,
      durationSec: 1.5,
      apiKey: "xai-test"
    });

    expect(timing.quality).toBe("approximate");
    expect(timing.words.map((word) => word.normalized)).toEqual([
      "generate",
      "the",
      "code"
    ]);
    expect(timing.warnings.map((warning) => warning.code)).toContain("precise_unavailable");
    expect(timing.words[0]!.startSec).toBe(0);
    expect(timing.words.at(-1)!.endSec).toBeCloseTo(1.5, 2);
  });

  it("falls back instead of throwing when transcription fails", async () => {
    const timing = await resolveSpeechTiming({
      provider: "openai",
      model: "tts-1-hd",
      voice: "onyx",
      text: "Generate the code",
      audioPath,
      durationSec: 1.5,
      apiKey: "sk-test",
      transcribe: async () => {
        throw new Error("rate limited");
      }
    });

    expect(timing.quality).toBe("approximate");
    expect(timing.warnings.map((warning) => warning.code)).toContain("precise_failed");
  });

  it("caches timing by narration tuple and audio hash", async () => {
    const transcribe = vi.fn(async () => [
      { word: "Cached", startSec: 0, endSec: 0.4 },
      { word: "timing", startSec: 0.5, endSec: 1 }
    ]);
    const base = {
      provider: "openai" as const,
      model: "tts-1-hd" as const,
      voice: "onyx" as const,
      text: "Cached timing",
      audioPath,
      durationSec: 1,
      apiKey: "sk-test"
    };

    const first = await resolveSpeechTiming({ ...base, transcribe });
    const second = await resolveSpeechTiming({
      ...base,
      transcribe: async () => {
        throw new Error("should not transcribe on cache hit");
      }
    });

    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(second.words).toEqual(first.words);
    expect(transcribe).toHaveBeenCalledTimes(1);
  });
});

describe("resolvePhraseTiming", () => {
  it("resolves phrase anchors by occurrence order", () => {
    const timing = approximateSpeechTiming("code then send code then approve", 3);
    const first = resolvePhraseTiming(timing, { phrase: "code", occurrence: 1 });
    const second = resolvePhraseTiming(timing, { phrase: "code", occurrence: 2 });

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(second!.startSec).toBeGreaterThan(first!.startSec);
    expect(first!.matchedText).toBe("code");
  });

  it("ignores punctuation and case when matching phrases", () => {
    const timing = approximateSpeechTiming("Open Settings, then enable Telegram.", 4);
    const resolved = resolvePhraseTiming(timing, {
      phrase: "settings then",
      occurrence: 1,
      offsetSec: 0.1,
      durationSec: 0.75
    });

    expect(resolved).not.toBeNull();
    expect(resolved!.matchedText).toBe("Settings then");
    expect(resolved!.endSec - resolved!.startSec).toBeCloseTo(0.75, 3);
  });

  it("returns null for unresolved phrase anchors", () => {
    const timing = approximateSpeechTiming("Open Settings", 2);
    expect(resolvePhraseTiming(timing, { phrase: "approve pairing" })).toBeNull();
  });
});

describe("speechTimingCacheKey", () => {
  it("changes when the audio hash changes", () => {
    const args = {
      provider: "openai" as const,
      model: "tts-1-hd" as const,
      voice: "onyx" as const,
      text: "Same words"
    };
    expect(speechTimingCacheKey(args, "audio-a")).not.toBe(
      speechTimingCacheKey(args, "audio-b")
    );
  });
});
