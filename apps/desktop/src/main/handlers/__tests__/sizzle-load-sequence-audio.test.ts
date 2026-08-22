// `sizzle:loadSequenceSceneAudio` is the cache-only read the composer
// makes on reel open. Pinning the contract the timeline depends on:
//
//   - A cached audio file WITH a cached speech-timing sidecar returns the
//     audio plus `durationSec` AND `words` (the transcript at spoken times)
//     — the renderer's RESOLVED state.
//   - A cached audio file WITHOUT a timing sidecar returns the audio with
//     `durationSec: null` AND `words: null` — null together, which is the
//     renderer's ESTIMATED state. There is no "duration known, no words"
//     middle state.
//   - No cached audio → `{ cached: false }`.
//   - The handler never synthesizes or resolves timing: only the cache
//     readers are consulted (`readAudio`, `resolveCachedSpeechTiming`).

import { beforeEach, describe, expect, test, vi } from "vitest";
import type { SizzleProject, SizzleScene, SizzleSpeechTiming } from "@pwrsnap/shared";
import type { CommandContext } from "../../command-bus";

type MockHandler = (req: unknown, ctx?: Partial<CommandContext>) => Promise<unknown>;

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, MockHandler>(),
  store: {
    get: vi.fn<(id: string) => Promise<SizzleProject | null>>(),
    list: vi.fn<() => Promise<SizzleProject[]>>(),
    create: vi.fn(),
    update: vi.fn(),
    duplicate: vi.fn(),
    delete: vi.fn()
  },
  readAudio: vi.fn<(audioPath: string) => Promise<Buffer>>(),
  resolveCachedSpeechTiming: vi.fn<(args: unknown) => Promise<SizzleSpeechTiming | null>>(),
  resolveSpeechTiming: vi.fn(),
  synthesize: vi.fn(),
  getValue: vi.fn(),
  dispatch: vi.fn(),
  send: vi.fn()
}));

vi.mock("electron", () => ({
  BrowserWindow: {
    getAllWindows: vi.fn(() => [
      { isDestroyed: () => false, webContents: { send: mocks.send } }
    ])
  },
  app: { getPath: vi.fn(() => "/tmp") },
  shell: { openPath: vi.fn(), showItemInFolder: vi.fn() }
}));

vi.mock("../../command-bus", () => ({
  bus: {
    register: vi.fn((name: string, handler: MockHandler) => {
      mocks.handlers.set(name, handler);
    }),
    dispatch: mocks.dispatch
  }
}));

vi.mock("../../sizzle/sizzle-store", () => ({
  getSizzleStore: () => mocks.store,
  SizzleProjectNotFoundError: class SizzleProjectNotFoundError extends Error {
    constructor(public readonly projectId: string) {
      super(`sizzle: project not found: ${projectId}`);
      this.name = "SizzleProjectNotFoundError";
    }
  }
}));

vi.mock("../sizzle-chat-handlers", () => ({
  cleanupProjectChats: vi.fn(),
  forkProjectChats: vi.fn()
}));

vi.mock("../../sizzle/tts", () => ({
  synthesize: mocks.synthesize,
  readAudio: mocks.readAudio,
  ttsCacheDir: () => "/tmp/tts-cache",
  ttsCacheFilename: (args: { text: string }) => `${args.text.length}.mp3`,
  TtsError: class TtsError extends Error {
    constructor(public readonly code: string, message: string) {
      super(message);
    }
  },
  pruneTtsCache: vi.fn()
}));

vi.mock("../../sizzle/speech-timing", () => ({
  resolveCachedSpeechTiming: mocks.resolveCachedSpeechTiming,
  resolveSpeechTiming: mocks.resolveSpeechTiming,
  // The real builder is pure; a tiny stand-in keeps the assertion on the
  // shape ("windows come from the timing") without re-testing it here.
  buildTranscriptPhraseSuggestions: (timing: SizzleSpeechTiming) =>
    timing.words.map((w) => ({
      text: w.word,
      startSec: w.startSec,
      endSec: w.endSec,
      wordStartIndex: w.index,
      wordEndIndex: w.index
    }))
}));

vi.mock("../../sizzle/composer", () => ({
  compose: vi.fn(),
  ComposeError: class ComposeError extends Error {
    constructor(public readonly code: string, message: string, public readonly details?: string) {
      super(message);
    }
  },
  probeDurationSec: vi.fn(),
  buildCompositionArgs: vi.fn()
}));

vi.mock("../../sizzle/audio-extract", () => ({
  AudioExtractError: class AudioExtractError extends Error {
    constructor(public readonly code: string, message: string, public readonly details?: string) {
      super(message);
    }
  },
  extractVideoAudio: vi.fn(),
  synthesizeSilence: vi.fn()
}));

vi.mock("../../window", () => ({
  createSizzleWindow: vi.fn(),
  findSizzleWindow: vi.fn(),
  positionSizzleWindowForSource: vi.fn()
}));

vi.mock("../../settings/desktop-secret-store", () => ({
  DesktopSecretStore: class {
    getValue = mocks.getValue;
  },
  SecretUnavailableError: class SecretUnavailableError extends Error {
    constructor(message: string = "secret unavailable") {
      super(message);
      this.name = "SecretUnavailableError";
    }
  }
}));

vi.mock("../../log", () => ({
  getMainLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}));

function sequenceScene(overrides: Partial<SizzleScene> = {}): SizzleScene {
  return {
    id: "sc-seq",
    kind: "sequence",
    captureId: "cap-1",
    scriptLine: "PwrSnap captures the moment",
    narration: "PwrSnap captures the moment",
    beats: [
      {
        id: "bt-1",
        captureId: "cap-1",
        timing: { kind: "auto" },
        mediaTrim: null,
        transition: "cut",
        videoFit: "smart-fit"
      }
    ],
    durationOverrideSec: null,
    mediaTrim: null,
    audioSource: "voiceover",
    transition: "crossfade",
    ...overrides
  };
}

function project(scenes: SizzleScene[]): SizzleProject {
  return {
    id: "proj-1",
    name: "Reel",
    createdAt: "2026-08-22T00:00:00.000Z",
    modifiedAt: "2026-08-22T00:00:00.000Z",
    coverCaptureId: null,
    scenes,
    voice: "onyx",
    ttsModel: "tts-1",
    ttsProvider: "openai",
    resolution: "1080p",
    outputPath: null,
    lastRenderedAt: null
  };
}

const TIMING: SizzleSpeechTiming = {
  text: "PwrSnap captures the moment",
  durationSec: 1.9,
  quality: "precise",
  words: [
    { index: 0, word: "PwrSnap", normalized: "pwrsnap", startSec: 0.1, endSec: 0.6 },
    { index: 1, word: "captures", normalized: "captures", startSec: 0.65, endSec: 1.1 },
    { index: 2, word: "the", normalized: "the", startSec: 1.15, endSec: 1.3 },
    { index: 3, word: "moment", normalized: "moment", startSec: 1.35, endSec: 1.8 }
  ],
  warnings: []
};

beforeEach(() => {
  vi.resetModules();
  mocks.handlers.clear();
  mocks.store.get.mockReset();
  mocks.readAudio.mockReset();
  mocks.resolveCachedSpeechTiming.mockReset();
  mocks.resolveSpeechTiming.mockReset();
  mocks.synthesize.mockReset();
});

async function loadHandler(): Promise<MockHandler> {
  const { registerSizzleHandlers } = await import("../sizzle-handlers");
  registerSizzleHandlers();
  const handler = mocks.handlers.get("sizzle:loadSequenceSceneAudio");
  expect(handler).toBeDefined();
  return handler!;
}

describe("sizzle:loadSequenceSceneAudio", () => {
  test("cached audio + cached timing → durationSec and words together (resolved)", async () => {
    mocks.store.get.mockResolvedValue(project([sequenceScene()]));
    mocks.readAudio.mockResolvedValue(Buffer.from("mp3"));
    mocks.resolveCachedSpeechTiming.mockResolvedValue(TIMING);
    const handler = await loadHandler();
    const res = (await handler({ projectId: "proj-1", sceneId: "sc-seq" })) as {
      ok: boolean;
      value: { cached: boolean; durationSec: number | null; words: unknown[] | null; transcriptPhrases: unknown[] };
    };
    expect(res.ok).toBe(true);
    expect(res.value.cached).toBe(true);
    expect(res.value.durationSec).toBe(1.9);
    expect(res.value.words).toEqual(TIMING.words);
    expect(res.value.transcriptPhrases).toHaveLength(4);
    // Cache-only: nothing synthesized, nothing resolved against an API.
    expect(mocks.synthesize).not.toHaveBeenCalled();
    expect(mocks.resolveSpeechTiming).not.toHaveBeenCalled();
  });

  test("cached audio WITHOUT a timing sidecar → durationSec and words are null together (estimated)", async () => {
    mocks.store.get.mockResolvedValue(project([sequenceScene()]));
    mocks.readAudio.mockResolvedValue(Buffer.from("mp3"));
    mocks.resolveCachedSpeechTiming.mockResolvedValue(null);
    const handler = await loadHandler();
    const res = (await handler({ projectId: "proj-1", sceneId: "sc-seq" })) as {
      ok: boolean;
      value: { cached: boolean; durationSec: number | null; words: unknown[] | null; transcriptPhrases: unknown[] };
    };
    expect(res.ok).toBe(true);
    expect(res.value.cached).toBe(true);
    expect(res.value.durationSec).toBeNull();
    expect(res.value.words).toBeNull();
    expect(res.value.transcriptPhrases).toEqual([]);
  });

  test("no cached audio → cached: false, and timing is never consulted", async () => {
    mocks.store.get.mockResolvedValue(project([sequenceScene()]));
    mocks.readAudio.mockRejectedValue(new Error("ENOENT"));
    const handler = await loadHandler();
    const res = (await handler({ projectId: "proj-1", sceneId: "sc-seq" })) as {
      ok: boolean;
      value: { cached: boolean };
    };
    expect(res.ok).toBe(true);
    expect(res.value).toEqual({ cached: false });
    expect(mocks.resolveCachedSpeechTiming).not.toHaveBeenCalled();
  });

  test("an empty script is a miss, not an error", async () => {
    mocks.store.get.mockResolvedValue(project([sequenceScene({ scriptLine: "  ", narration: "  " })]));
    const handler = await loadHandler();
    const res = (await handler({ projectId: "proj-1", sceneId: "sc-seq" })) as {
      ok: boolean;
      value: { cached: boolean };
    };
    expect(res.ok).toBe(true);
    expect(res.value).toEqual({ cached: false });
    expect(mocks.readAudio).not.toHaveBeenCalled();
  });
});
