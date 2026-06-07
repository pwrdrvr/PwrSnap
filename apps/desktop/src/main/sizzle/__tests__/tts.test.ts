import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SizzleProject } from "@pwrsnap/shared";

// Mock electron's `app.getPath("userData")` so the cache directory
// lives inside our temp dir for each test. Must be hoisted before the
// imports of the unit-under-test.
let userDataDir = "";
vi.mock("electron", () => ({
  app: {
    getPath: (_: string) => userDataDir
  }
}));

import {
  pruneTtsCache,
  synthesize,
  ttsCacheDir,
  ttsCacheFilename,
  TtsError
} from "../tts";

beforeEach(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), "pwrsnap-sizzle-tts-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (userDataDir) await rm(userDataDir, { recursive: true, force: true });
});

function fakeProject(overrides: Partial<SizzleProject> = {}): SizzleProject {
  return {
    id: "sz_test",
    name: "Test",
    createdAt: "2026-05-27T00:00:00Z",
    modifiedAt: "2026-05-27T00:00:00Z",
    coverCaptureId: null,
    scenes: [],
    voice: "onyx",
    ttsModel: "tts-1-hd",
    ttsProvider: "openai",
    resolution: "1080p",
    outputPath: null,
    lastRenderedAt: null,
    ...overrides
  };
}

describe("ttsCacheFilename", () => {
  it("is stable for the same inputs", () => {
    const a = ttsCacheFilename({
      provider: "openai",
      model: "tts-1-hd",
      voice: "onyx",
      text: "hello world"
    });
    const b = ttsCacheFilename({
      provider: "openai",
      model: "tts-1-hd",
      voice: "onyx",
      text: "hello world"
    });
    expect(a).toBe(b);
    expect(a).toMatch(/\.mp3$/);
  });

  it("differs when text changes by even one character", () => {
    const a = ttsCacheFilename({
      provider: "openai",
      model: "tts-1-hd",
      voice: "onyx",
      text: "blurry"
    });
    const b = ttsCacheFilename({
      provider: "openai",
      model: "tts-1-hd",
      voice: "onyx",
      text: "blury"
    });
    expect(a).not.toBe(b);
  });

  it("differs when voice or model or provider changes", () => {
    const base = {
      provider: "openai" as const,
      model: "tts-1-hd" as const,
      voice: "onyx" as const,
      text: "hello"
    };
    expect(ttsCacheFilename(base)).not.toBe(
      ttsCacheFilename({ ...base, voice: "alloy" })
    );
    expect(ttsCacheFilename(base)).not.toBe(
      ttsCacheFilename({ ...base, model: "tts-1" })
    );
    expect(ttsCacheFilename(base)).not.toBe(
      ttsCacheFilename({ ...base, provider: "xai" })
    );
  });
});

describe("synthesize", () => {
  it("rejects empty text", async () => {
    await expect(
      synthesize({
        provider: "openai",
        apiKey: "sk-test",
        text: "   ",
        voice: "onyx",
        model: "tts-1-hd"
      })
    ).rejects.toMatchObject({ code: "empty_text" });
  });

  it("rejects missing api key", async () => {
    await expect(
      synthesize({
        provider: "openai",
        apiKey: "",
        text: "hello",
        voice: "onyx",
        model: "tts-1-hd"
      })
    ).rejects.toMatchObject({ code: "no_api_key" });
  });

  it("rejects xai provider (not wired up)", async () => {
    await expect(
      synthesize({
        provider: "xai",
        apiKey: "xai-test",
        text: "hello",
        voice: "onyx",
        model: "tts-1-hd"
      })
    ).rejects.toMatchObject({ code: "provider_unavailable" });
  });

  it("cache HIT returns the existing file path without calling fetch", async () => {
    // Pre-seed the cache file at the hash we expect for these inputs.
    const expectedName = ttsCacheFilename({
      provider: "openai",
      model: "tts-1-hd",
      voice: "onyx",
      text: "preseeded"
    });
    const cachedPath = join(ttsCacheDir(), expectedName);
    await mkdir(ttsCacheDir(), { recursive: true });
    await writeFile(cachedPath, Buffer.from("FAKE-MP3-BYTES"));
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("fetch should not have been called on cache HIT");
    });
    const result = await synthesize({
      provider: "openai",
      apiKey: "sk-test",
      text: "preseeded",
      voice: "onyx",
      model: "tts-1-hd"
    });
    expect(result.cached).toBe(true);
    expect(result.audioPath).toBe(cachedPath);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("cache MISS fetches from OpenAI, writes the bytes, returns the path", async () => {
    const fakeBytes = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00]); // "ID3" mp3 header + a couple bytes
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(fakeBytes, { status: 200 })
    );
    const result = await synthesize({
      provider: "openai",
      apiKey: "sk-test",
      text: "fresh",
      voice: "onyx",
      model: "tts-1-hd"
    });
    expect(result.cached).toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const onDisk = await readFile(result.audioPath);
    expect(onDisk).toEqual(Buffer.from(fakeBytes));
  });

  it("propagates HTTP failures as TtsError", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("rate limited", { status: 429 })
    );
    const promise = synthesize({
      provider: "openai",
      apiKey: "sk-test",
      text: "burst",
      voice: "onyx",
      model: "tts-1-hd"
    });
    await expect(promise).rejects.toBeInstanceOf(TtsError);
    await expect(promise).rejects.toMatchObject({ code: "http_failed" });
  });

  it("edits to the text produce a new cache file (does NOT overwrite the old)", async () => {
    const fakeBytes1 = new Uint8Array([1, 1, 1]);
    const fakeBytes2 = new Uint8Array([2, 2, 2]);
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(fakeBytes1, { status: 200 }))
      .mockResolvedValueOnce(new Response(fakeBytes2, { status: 200 }));
    const a = await synthesize({
      provider: "openai",
      apiKey: "sk-test",
      text: "blurry",
      voice: "onyx",
      model: "tts-1-hd"
    });
    const b = await synthesize({
      provider: "openai",
      apiKey: "sk-test",
      text: "blury",
      voice: "onyx",
      model: "tts-1-hd"
    });
    expect(a.audioPath).not.toBe(b.audioPath);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    // Both files still exist on disk — neither was clobbered.
    const onDiskA = await readFile(a.audioPath);
    const onDiskB = await readFile(b.audioPath);
    expect(onDiskA).toEqual(Buffer.from(fakeBytes1));
    expect(onDiskB).toEqual(Buffer.from(fakeBytes2));
  });
});

describe("pruneTtsCache", () => {
  beforeEach(async () => {
    // Pre-create the cache dir so unlink calls have something to clear.
    await rm(ttsCacheDir(), { recursive: true, force: true });
    // Each fetch call gets a fresh Response — Response bodies can only
    // be read once, so `mockResolvedValue` with a single Response
    // instance breaks the second `await synthesize(...)` call.
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(new Uint8Array([0]), { status: 200 })
    );
  });

  it("returns 0/0/0 on a missing cache directory", async () => {
    const result = await pruneTtsCache([]);
    expect(result).toEqual({ scanned: 0, removed: 0, kept: 0 });
  });

  it("keeps files referenced by any project scene and recent prior scripts", async () => {
    // Synthesize three audio files. Reference only two from the project.
    const a = await synthesize({
      provider: "openai",
      apiKey: "sk",
      text: "kept-1",
      voice: "onyx",
      model: "tts-1-hd"
    });
    const b = await synthesize({
      provider: "openai",
      apiKey: "sk",
      text: "kept-2",
      voice: "onyx",
      model: "tts-1-hd"
    });
    const c = await synthesize({
      provider: "openai",
      apiKey: "sk",
      text: "orphan",
      voice: "onyx",
      model: "tts-1-hd"
    });
    const project = fakeProject({
      scenes: [
        { id: "sc1", captureId: "cap1", scriptLine: "kept-1", durationOverrideSec: null, mediaTrim: null, audioSource: "auto", transition: "crossfade" },
        { id: "sc2", captureId: "cap2", scriptLine: " kept-2 ", durationOverrideSec: null, mediaTrim: null, audioSource: "auto", transition: "crossfade" }
      ]
    });
    const result = await pruneTtsCache([project]);
    expect(result.scanned).toBe(3);
    expect(result.kept).toBe(3);
    expect(result.removed).toBe(0);
    const entries = await readdir(ttsCacheDir());
    expect(entries.sort()).toEqual(
      [a.audioPath, b.audioPath, c.audioPath].map((p) => basename(p)).sort()
    );
  });

  it("uses trimmed scriptLine when computing the live set", async () => {
    await synthesize({
      provider: "openai",
      apiKey: "sk",
      text: "trim-me",
      voice: "onyx",
      model: "tts-1-hd"
    });
    const project = fakeProject({
      scenes: [
        { id: "s", captureId: "c", scriptLine: "  trim-me  \n", durationOverrideSec: null, mediaTrim: null, audioSource: "auto", transition: "crossfade" }
      ]
    });
    const result = await pruneTtsCache([project]);
    expect(result.removed).toBe(0);
    expect(result.kept).toBe(1);
  });

  it("treats empty scripts as no reference (file is orphaned)", async () => {
    await synthesize({
      provider: "openai",
      apiKey: "sk",
      text: "something",
      voice: "onyx",
      model: "tts-1-hd"
    });
    const project = fakeProject({
      scenes: [{ id: "s", captureId: "c", scriptLine: "  ", durationOverrideSec: null, mediaTrim: null, audioSource: "auto", transition: "crossfade" }]
    });
    const result = await pruneTtsCache([project]);
    expect(result.removed).toBe(0);
    expect(result.kept).toBe(1);
  });

  it("keeps only the five most recent prior-script cache files", async () => {
    const paths: string[] = [];
    for (let i = 0; i < 6; i++) {
      const result = await synthesize({
        provider: "openai",
        apiKey: "sk",
        text: `prior-${i}`,
        voice: "onyx",
        model: "tts-1-hd"
      });
      paths.push(result.audioPath);
      const when = new Date(Date.UTC(2026, 0, 1, 0, i, 0));
      await utimes(result.audioPath, when, when);
    }

    const result = await pruneTtsCache([]);
    expect(result.kept).toBe(5);
    expect(result.removed).toBe(1);
    const entries = await readdir(ttsCacheDir());
    expect(entries).not.toContain(basename(paths[0]!));
    expect(entries).toContain(basename(paths[5]!));
  });
});
