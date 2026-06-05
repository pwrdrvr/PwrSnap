// Tests for the `sizzle:toggleScene` command handler. This one runs
// the full handler-registration scaffolding under mocks because the
// add/remove logic interacts with the sizzle-store. Pinning the
// contract:
//
//   - Calling toggleScene with a captureId NOT yet in the project's
//     scenes APPENDS a new scene at the tail (with sensible defaults:
//     empty script, no media trim, audioSource "auto", transition
//     "crossfade").
//   - Calling toggleScene with a captureId that IS in the project's
//     scenes REMOVES that scene from the array.
//   - Missing-project id returns a validation error.
//   - Both add and remove paths broadcast `events:sizzle:projects:changed`
//     so the Library sidebar refreshes live.
//   - Validation rejects empty / malformed input.

import { beforeEach, describe, expect, test, vi } from "vitest";
import type { SizzleProject, SizzleScene } from "@pwrsnap/shared";
import type { CommandContext } from "../../command-bus";

type MockHandler = (req: unknown, ctx?: Partial<CommandContext>) => Promise<unknown>;

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, MockHandler>(),
  store: {
    get: vi.fn<(id: string) => Promise<SizzleProject | null>>(),
    list: vi.fn<() => Promise<SizzleProject[]>>(),
    create: vi.fn(),
    update: vi.fn<(
      id: string,
      patch: Partial<Omit<SizzleProject, "id" | "createdAt">>
    ) => Promise<SizzleProject>>(),
    duplicate: vi.fn<(
      id: string,
      name?: string
    ) => Promise<SizzleProject>>(),
    delete: vi.fn()
  },
  cleanupProjectChats: vi.fn(),
  forkProjectChats: vi.fn(),
  createSizzleWindow: vi.fn(),
  findSizzleWindow: vi.fn(),
  positionSizzleWindowForSource: vi.fn(),
  send: vi.fn(),
  getValue: vi.fn()
}));

vi.mock("electron", () => ({
  BrowserWindow: {
    getAllWindows: vi.fn(() => [
      {
        isDestroyed: () => false,
        webContents: { send: mocks.send }
      }
    ])
  },
  app: { getPath: vi.fn(() => "/tmp") },
  shell: { openPath: vi.fn(), showItemInFolder: vi.fn() }
}));

vi.mock("../../command-bus", () => ({
  bus: {
    register: vi.fn((name: string, handler: MockHandler) => {
      mocks.handlers.set(name, handler);
    })
  }
}));

vi.mock("../../sizzle/sizzle-store", () => ({
  getSizzleStore: () => mocks.store,
  // toError() instanceof-checks against this; the real export
  // declares it as a class — keep the constructor shape compatible.
  SizzleProjectNotFoundError: class SizzleProjectNotFoundError extends Error {
    constructor(public readonly projectId: string) {
      super(`sizzle: project not found: ${projectId}`);
      this.name = "SizzleProjectNotFoundError";
    }
  }
}));

vi.mock("../sizzle-chat-handlers", () => ({
  cleanupProjectChats: mocks.cleanupProjectChats,
  forkProjectChats: mocks.forkProjectChats
}));

vi.mock("../../sizzle/tts", () => ({
  synthesize: vi.fn(),
  TtsError: class TtsError extends Error {
    constructor(public readonly code: string, message: string) {
      super(message);
    }
  },
  pruneTtsCache: vi.fn()
}));

vi.mock("../../sizzle/composer", () => ({
  compose: vi.fn(),
  ComposeError: class ComposeError extends Error {
    constructor(
      public readonly code: string,
      message: string,
      public readonly details?: string
    ) {
      super(message);
    }
  },
  probeDurationSec: vi.fn(),
  buildCompositionArgs: vi.fn()
}));

vi.mock("../../sizzle/audio-extract", () => ({
  AudioExtractError: class AudioExtractError extends Error {
    constructor(
      public readonly code: string,
      message: string,
      public readonly details?: string
    ) {
      super(message);
    }
  },
  extractVideoAudio: vi.fn(),
  synthesizeSilence: vi.fn()
}));

vi.mock("../../window", () => ({
  createSizzleWindow: mocks.createSizzleWindow,
  findSizzleWindow: mocks.findSizzleWindow,
  positionSizzleWindowForSource: mocks.positionSizzleWindowForSource
}));

vi.mock("../../settings/desktop-secret-store", () => ({
  DesktopSecretStore: class {
    getValue = mocks.getValue;
  },
  // toError() instanceof-checks against this — keep the shape
  // compatible with the production export.
  SecretUnavailableError: class SecretUnavailableError extends Error {
    constructor(message: string = "secret unavailable") {
      super(message);
      this.name = "SecretUnavailableError";
    }
  }
}));

vi.mock("../../bundle-cache/cache-fs", () => ({
  resolveCacheFile: vi.fn()
}));

vi.mock("../../log", () => ({
  getMainLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}));

function makeProject(overrides: Partial<SizzleProject> = {}): SizzleProject {
  return {
    id: "proj-1",
    name: "Untitled",
    createdAt: "2026-05-27T00:00:00.000Z",
    modifiedAt: "2026-05-27T00:00:00.000Z",
    coverCaptureId: null,
    scenes: [],
    voice: "alloy",
    ttsModel: "tts-1",
    ttsProvider: "openai",
    resolution: "1080p",
    outputPath: null,
    lastRenderedAt: null,
    ...overrides
  };
}

function makeScene(overrides: Partial<SizzleScene> = {}): SizzleScene {
  return {
    id: "sc-existing",
    captureId: "cap-1",
    scriptLine: "Existing line",
    durationOverrideSec: null,
    mediaTrim: null,
    audioSource: "auto",
    transition: "crossfade",
    ...overrides
  };
}

beforeEach(() => {
  vi.resetModules();
  mocks.handlers.clear();
  mocks.store.get.mockReset();
  mocks.store.list.mockReset();
  mocks.store.update.mockReset();
  mocks.store.duplicate.mockReset();
  mocks.cleanupProjectChats.mockReset();
  mocks.forkProjectChats.mockReset();
  mocks.createSizzleWindow.mockReset();
  mocks.findSizzleWindow.mockReset();
  mocks.positionSizzleWindowForSource.mockReset();
  mocks.send.mockReset();
  // Default: store.list returns whatever store.update returned, in
  // an array. Most tests just need "some projects exist" — they can
  // override per-case.
  mocks.store.list.mockResolvedValue([]);
});

async function loadHandler(
  command: string = "sizzle:toggleScene"
): Promise<MockHandler> {
  const { registerSizzleHandlers } = await import("../sizzle-handlers");
  registerSizzleHandlers();
  const handler = mocks.handlers.get(command);
  expect(handler).toBeDefined();
  return handler!;
}

function makeFakeWindow(): {
  show: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
  restore: ReturnType<typeof vi.fn>;
  isMinimized: ReturnType<typeof vi.fn>;
  webContents: { send: ReturnType<typeof vi.fn> };
} {
  return {
    show: vi.fn(),
    focus: vi.fn(),
    restore: vi.fn(),
    isMinimized: vi.fn(() => false),
    webContents: { send: vi.fn() }
  };
}

function commandCtx(sourceWindowId?: number): Partial<CommandContext> {
  return {
    signal: new AbortController().signal,
    principal: "ipc",
    ...(sourceWindowId !== undefined ? { sourceWindowId } : {})
  };
}

describe("sizzle:open — source display placement", () => {
  test("passes source window id when creating a new Sizzle window", async () => {
    const fake = makeFakeWindow();
    mocks.findSizzleWindow.mockReturnValue(null);
    mocks.createSizzleWindow.mockReturnValue(fake);

    const handler = await loadHandler("sizzle:open");
    const result = await handler({}, commandCtx(42));

    expect(result).toMatchObject({ ok: true });
    expect(mocks.createSizzleWindow).toHaveBeenCalledWith(undefined, {
      sourceWindowId: 42
    });
    expect(fake.show).toHaveBeenCalledTimes(1);
    expect(fake.focus).toHaveBeenCalledTimes(1);
  });

  test("repositions an existing Sizzle window to the source display before focusing", async () => {
    const fake = makeFakeWindow();
    mocks.findSizzleWindow.mockReturnValue(fake);

    const handler = await loadHandler("sizzle:open");
    await handler({}, commandCtx(7));

    expect(mocks.positionSizzleWindowForSource).toHaveBeenCalledWith(fake, {
      sourceWindowId: 7
    });
    expect(mocks.createSizzleWindow).not.toHaveBeenCalled();
    expect(fake.show).toHaveBeenCalledTimes(1);
    expect(fake.focus).toHaveBeenCalledTimes(1);
  });
});

describe("sizzle:toggleScene — validation", () => {
  test("missing projectId → validation error", async () => {
    const handler = await loadHandler();
    const result = await handler({ captureId: "cap-1" });
    expect(result).toMatchObject({
      ok: false,
      error: { kind: "validation", code: "projectId_required" }
    });
  });

  test("missing captureId → validation error", async () => {
    const handler = await loadHandler();
    const result = await handler({ projectId: "proj-1" });
    expect(result).toMatchObject({
      ok: false,
      error: { kind: "validation", code: "captureId_required" }
    });
  });

  test("non-object payload → validation error", async () => {
    const handler = await loadHandler();
    const result = await handler("not an object");
    expect(result).toMatchObject({
      ok: false,
      error: { kind: "validation", code: "not_object" }
    });
  });

  test("empty-string id → validation error", async () => {
    const handler = await loadHandler();
    const result = await handler({ projectId: "", captureId: "cap-1" });
    expect(result).toMatchObject({
      ok: false,
      error: { kind: "validation", code: "projectId_required" }
    });
  });
});

describe("sizzle:toggleScene — project not found", () => {
  test("returns not_found error and doesn't mutate the store", async () => {
    mocks.store.get.mockResolvedValue(null);
    const handler = await loadHandler();
    const result = await handler({ projectId: "proj-ghost", captureId: "cap-1" });
    expect(result).toMatchObject({
      ok: false,
      error: { kind: "validation", code: "not_found" }
    });
    expect(mocks.store.update).not.toHaveBeenCalled();
    // No broadcast for a no-op (no state change).
    expect(mocks.send).not.toHaveBeenCalled();
  });
});

describe("sizzle:toggleScene — add path", () => {
  test("appends a new scene with sensible defaults when captureId isn't yet in the project", async () => {
    const project = makeProject({ scenes: [] });
    mocks.store.get.mockResolvedValue(project);
    // store.update returns the updated project — capture the patch it
    // was called with so we can assert the scene-defaults.
    mocks.store.update.mockImplementation(async (id, patch) => ({
      ...project,
      ...patch,
      scenes: patch.scenes ?? project.scenes,
      id,
      modifiedAt: new Date().toISOString()
    }));
    mocks.store.list.mockResolvedValue([project]);

    const handler = await loadHandler();
    const result = (await handler({
      projectId: "proj-1",
      captureId: "cap-new"
    })) as { ok: true; value: SizzleProject };

    expect(result.ok).toBe(true);
    expect(mocks.store.update).toHaveBeenCalledTimes(1);
    const patch = mocks.store.update.mock.calls[0]![1];
    expect(patch.scenes).toBeDefined();
    expect(patch.scenes).toHaveLength(1);
    const appendedScene = patch.scenes![0]!;
    // Pin the defaults — these are the contract the "+ Add captures"
    // flow relies on (crossfade default = visual win, audioSource auto
    // = let render-time policy decide, mediaTrim null = seed from
    // capture metadata at render time if it's a video).
    expect(appendedScene.captureId).toBe("cap-new");
    expect(appendedScene.scriptLine).toBe("");
    expect(appendedScene.durationOverrideSec).toBeNull();
    expect(appendedScene.mediaTrim).toBeNull();
    expect(appendedScene.audioSource).toBe("auto");
    expect(appendedScene.transition).toBe("crossfade");
    // Scene id is auto-generated — assert prefix only.
    expect(appendedScene.id).toMatch(/^sc_/);
  });

  test("appends to the END of the scenes array (not the head)", async () => {
    const existing = makeScene({ id: "sc-1", captureId: "cap-A" });
    const project = makeProject({ scenes: [existing] });
    mocks.store.get.mockResolvedValue(project);
    mocks.store.update.mockImplementation(async (id, patch) => ({
      ...project,
      ...patch,
      id,
      scenes: patch.scenes ?? project.scenes,
      modifiedAt: new Date().toISOString()
    }));
    mocks.store.list.mockResolvedValue([project]);

    const handler = await loadHandler();
    await handler({ projectId: "proj-1", captureId: "cap-B" });
    const patch = mocks.store.update.mock.calls[0]![1];
    expect(patch.scenes).toHaveLength(2);
    expect(patch.scenes![0]!.captureId).toBe("cap-A");
    expect(patch.scenes![1]!.captureId).toBe("cap-B");
  });

  test("broadcasts projects:changed after a successful add", async () => {
    const project = makeProject({ scenes: [] });
    mocks.store.get.mockResolvedValue(project);
    mocks.store.update.mockResolvedValue(project);
    mocks.store.list.mockResolvedValue([project]);

    const handler = await loadHandler();
    await handler({ projectId: "proj-1", captureId: "cap-new" });
    expect(mocks.send).toHaveBeenCalled();
    const [channel, payload] = mocks.send.mock.calls[0]!;
    expect(channel).toBe("events:sizzle:projects:changed");
    expect(payload).toMatchObject({ projects: expect.any(Array) });
  });
});

describe("sizzle:toggleScene — remove path", () => {
  test("removes the matching scene when captureId is already in the project", async () => {
    const scene1 = makeScene({ id: "sc-1", captureId: "cap-A" });
    const scene2 = makeScene({ id: "sc-2", captureId: "cap-B" });
    const scene3 = makeScene({ id: "sc-3", captureId: "cap-C" });
    const project = makeProject({ scenes: [scene1, scene2, scene3] });
    mocks.store.get.mockResolvedValue(project);
    mocks.store.update.mockImplementation(async (id, patch) => ({
      ...project,
      ...patch,
      id,
      scenes: patch.scenes ?? project.scenes,
      modifiedAt: new Date().toISOString()
    }));
    mocks.store.list.mockResolvedValue([project]);

    const handler = await loadHandler();
    await handler({ projectId: "proj-1", captureId: "cap-B" });

    const patch = mocks.store.update.mock.calls[0]![1];
    expect(patch.scenes).toHaveLength(2);
    expect(patch.scenes!.map((s) => s.captureId)).toEqual(["cap-A", "cap-C"]);
  });

  test("removes only the FIRST matching scene (if same capture is in the project twice)", async () => {
    // Edge case: today the "Add captures" flow + the sizzle editor's
    // add-scene flow both append, so duplicate captureIds in one
    // project's scenes array are possible (a feature, not a bug — a
    // user might want to show the same capture twice in a reel).
    // toggleScene removes the FIRST occurrence; the second remains.
    // Pin that here so a future "dedupe captureIds" refactor breaks
    // the test loudly.
    const dup1 = makeScene({ id: "sc-1", captureId: "cap-D" });
    const dup2 = makeScene({ id: "sc-2", captureId: "cap-D" });
    const project = makeProject({ scenes: [dup1, dup2] });
    mocks.store.get.mockResolvedValue(project);
    mocks.store.update.mockImplementation(async (id, patch) => ({
      ...project,
      ...patch,
      id,
      scenes: patch.scenes ?? project.scenes,
      modifiedAt: new Date().toISOString()
    }));
    mocks.store.list.mockResolvedValue([project]);

    const handler = await loadHandler();
    await handler({ projectId: "proj-1", captureId: "cap-D" });
    const patch = mocks.store.update.mock.calls[0]![1];
    expect(patch.scenes).toHaveLength(1);
    expect(patch.scenes![0]!.id).toBe("sc-2");
  });

  test("broadcasts projects:changed after a successful remove", async () => {
    const project = makeProject({ scenes: [makeScene({ captureId: "cap-1" })] });
    mocks.store.get.mockResolvedValue(project);
    mocks.store.update.mockResolvedValue(project);
    mocks.store.list.mockResolvedValue([project]);

    const handler = await loadHandler();
    await handler({ projectId: "proj-1", captureId: "cap-1" });
    expect(mocks.send).toHaveBeenCalled();
    expect(mocks.send.mock.calls[0]![0]).toBe("events:sizzle:projects:changed");
  });
});

describe("sizzle:duplicate — chat fork", () => {
  test("returns and broadcasts before the best-effort chat fork resolves", async () => {
    const project = makeProject({ id: "proj-copy", name: "Untitled Copy" });
    mocks.store.duplicate.mockResolvedValue(project);
    mocks.store.list.mockResolvedValue([project]);
    let resolveFork: () => void = () => undefined;
    mocks.forkProjectChats.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveFork = resolve;
        })
    );

    const handler = await loadHandler("sizzle:duplicate");
    const result = await Promise.race([
      handler({ id: "proj-1" }),
      new Promise((resolve) => setTimeout(() => resolve("timed-out"), 25))
    ]);

    expect(result).toMatchObject({ ok: true, value: project });
    expect(mocks.store.duplicate).toHaveBeenCalledWith("proj-1", undefined);
    expect(mocks.send).toHaveBeenCalledWith(
      "events:sizzle:projects:changed",
      { projects: [project] }
    );
    expect(mocks.forkProjectChats).toHaveBeenCalledWith("proj-1", "proj-copy");
    resolveFork();
  });
});

describe("sizzle:toggleScene — store-error propagation", () => {
  test("a store.update throw is mapped to a render error result", async () => {
    const project = makeProject({ scenes: [] });
    mocks.store.get.mockResolvedValue(project);
    mocks.store.update.mockRejectedValue(new Error("disk write failed"));

    const handler = await loadHandler();
    const result = await handler({ projectId: "proj-1", captureId: "cap-1" });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "sizzle_toggle_failed" }
    });
  });
});
