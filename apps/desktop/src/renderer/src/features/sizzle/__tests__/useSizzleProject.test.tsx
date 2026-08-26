// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import {
  EVENT_CHANNELS,
  type PwrSnapError,
  type SizzleProject,
  type SizzleScene
} from "@pwrsnap/shared";
import {
  DEBOUNCE_MS,
  useSizzleProject,
  type SizzleProjectState
} from "../useSizzleProject";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function project(patch: Partial<SizzleProject> = {}): SizzleProject {
  return {
    id: "sz_1",
    name: "Demo Reel",
    createdAt: "2026-08-23T12:00:00.000Z",
    modifiedAt: "2026-08-23T12:00:00.000Z",
    coverCaptureId: null,
    scenes: [],
    voice: "onyx",
    ttsModel: "tts-1-hd",
    ttsProvider: "openai",
    resolution: "1080p",
    outputPath: null,
    lastRenderedAt: null,
    ...patch
  };
}

const persistenceError = (
  code: string,
  message: string
): PwrSnapError => ({ kind: "persistence", code, message });

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let latest: SizzleProjectState | null = null;

function snapshot(): SizzleProjectState {
  if (latest === null) throw new Error("hook snapshot requested before render");
  return latest;
}

function Probe(): null {
  latest = useSizzleProject();
  return null;
}

type DispatchHandler = (name: string, req: unknown) => unknown;

function installApi(handler: DispatchHandler): {
  dispatch: ReturnType<typeof vi.fn>;
  emit: (channel: string, payload: unknown) => void;
} {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const dispatch = vi.fn((name: string, req: unknown) => Promise.resolve(handler(name, req)));
  (globalThis as unknown as { window: Window }).window.pwrsnapApi = {
    dispatch,
    on: (channel: string, listener: (payload: unknown) => void) => {
      const channelListeners = listeners.get(channel) ?? new Set();
      channelListeners.add(listener);
      listeners.set(channel, channelListeners);
      return () => channelListeners.delete(listener);
    },
    startCaptureDrag: () => undefined
  } as unknown as NonNullable<Window["pwrsnapApi"]>;
  return {
    dispatch,
    emit: (channel, payload) => {
      for (const listener of listeners.get(channel) ?? []) listener(payload);
    }
  };
}

async function flushMicrotasks(count = 8): Promise<void> {
  await act(async () => {
    for (let index = 0; index < count; index += 1) await Promise.resolve();
  });
}

async function mountHook(): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(createElement(Probe));
    for (let index = 0; index < 6; index += 1) await Promise.resolve();
  });
}

afterEach(async () => {
  if (root !== null) {
    await act(async () => {
      root!.unmount();
      await Promise.resolve();
    });
  }
  root = null;
  container?.remove();
  container = null;
  latest = null;
  window.location.hash = "";
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useSizzleProject persistence state", () => {
  test("initial list failure exposes the typed error, ends loading, and retry recovers", async () => {
    const first = project();
    const second = project({ id: "sz_2", name: "Second Reel" });
    let listCalls = 0;
    installApi((name) => {
      if (name === "sizzle:list") {
        listCalls += 1;
        return listCalls === 1
          ? {
              ok: false,
              error: persistenceError(
                "sizzle_list_failed",
                "project file unavailable"
              )
            }
          : { ok: true, value: { projects: [first, second] } };
      }
      if (name === "library:list" || name === "library:listByIds") {
        return { ok: true, value: { rows: [] } };
      }
      return { ok: true, value: undefined };
    });

    await mountHook();

    expect(snapshot().loading).toBe(false);
    expect(snapshot().loadError).toEqual(
      persistenceError("sizzle_list_failed", "project file unavailable")
    );
    expect(snapshot().projects).toEqual([]);

    await act(async () => {
      await snapshot().retryLoad();
    });

    expect(snapshot().loading).toBe(false);
    expect(snapshot().loadError).toBeNull();
    expect(snapshot().projects.map(({ id }) => id)).toEqual(["sz_1", "sz_2"]);
    expect(snapshot().active?.id).toBe("sz_1");
    expect(listCalls).toBe(2);

    act(() => snapshot().selectProject("sz_2"));
    await flushMicrotasks();
    expect(snapshot().active?.id).toBe("sz_2");
    expect(listCalls).toBe(2);
  });

  test("a failed save is requeued and coalesced with a newer edit before retry", async () => {
    vi.useFakeTimers();
    const initial = project();
    const updates: Array<{
      req: { id: string; patch: Record<string, unknown> };
      result: Deferred<unknown>;
    }> = [];
    const { dispatch } = installApi((name, req) => {
      if (name === "sizzle:list") return { ok: true, value: { projects: [initial] } };
      if (name === "library:list" || name === "library:listByIds") {
        return { ok: true, value: { rows: [] } };
      }
      if (name === "sizzle:update") {
        const result = deferred<unknown>();
        updates.push({ req: req as { id: string; patch: Record<string, unknown> }, result });
        return result.promise;
      }
      return { ok: true, value: undefined };
    });
    await mountHook();

    act(() => {
      snapshot().onUpdate("sz_1", { name: "Draft A", voice: "alloy" });
    });
    expect(snapshot().saveState.phase).toBe("dirty");

    let firstFlush!: Promise<boolean>;
    act(() => {
      firstFlush = snapshot().flushPatch("sz_1");
    });
    await flushMicrotasks();
    expect(updates).toHaveLength(1);
    expect(snapshot().saveState.phase).toBe("saving");

    act(() => {
      snapshot().onUpdate("sz_1", { name: "Draft B", resolution: "720p" });
    });
    expect(snapshot().active).toMatchObject({
      name: "Draft B",
      voice: "alloy",
      resolution: "720p"
    });
    expect(updates).toHaveLength(1);

    let firstSaved: boolean | undefined;
    await act(async () => {
      updates[0]!.result.resolve({
        ok: false,
        error: persistenceError("sizzle_update_failed", "disk is read-only")
      });
      firstSaved = await firstFlush;
    });
    expect(firstSaved).toBe(false);
    expect(snapshot().saveState).toEqual({
      phase: "error",
      error: persistenceError("sizzle_update_failed", "disk is read-only")
    });
    expect(updates).toHaveLength(1);

    let retry!: Promise<boolean>;
    act(() => {
      retry = snapshot().retrySave("sz_1");
    });
    await flushMicrotasks();
    expect(updates).toHaveLength(2);
    expect(updates[1]!.req).toEqual({
      id: "sz_1",
      patch: { name: "Draft B", voice: "alloy", resolution: "720p" }
    });
    expect(snapshot().saveState.phase).toBe("saving");

    let recovered: boolean | undefined;
    await act(async () => {
      updates[1]!.result.resolve({
        ok: true,
        value: {
          ...initial,
          name: "Draft B",
          voice: "alloy",
          resolution: "720p",
          modifiedAt: "2026-08-23T12:01:00.000Z"
        }
      });
      recovered = await retry;
    });
    expect(recovered).toBe(true);
    expect(snapshot().saveState).toEqual({ phase: "saved", error: null });

    await act(async () => {
      vi.advanceTimersByTime(DEBOUNCE_MS + 1);
      await Promise.resolve();
    });
    expect(updates).toHaveLength(2);
    expect(dispatch.mock.calls.filter(([name]) => name === "sizzle:update")).toHaveLength(2);
  });

  test("a late failure from the previous reel stays scoped to that reel", async () => {
    vi.useFakeTimers();
    const first = project();
    const second = project({ id: "sz_2", name: "Second Reel" });
    const update = deferred<unknown>();
    const { dispatch } = installApi((name) => {
      if (name === "sizzle:list") return { ok: true, value: { projects: [first, second] } };
      if (name === "library:list" || name === "library:listByIds") {
        return { ok: true, value: { rows: [] } };
      }
      if (name === "sizzle:update") return update.promise;
      return { ok: true, value: undefined };
    });
    await mountHook();

    act(() => {
      snapshot().onUpdate("sz_1", { name: "Unsaved first reel" });
      snapshot().selectProject("sz_2");
    });
    await flushMicrotasks();
    expect(dispatch.mock.calls.filter(([name]) => name === "sizzle:update")).toHaveLength(1);
    expect(snapshot().active?.id).toBe("sz_2");
    expect(snapshot().saveState).toEqual({ phase: "saved", error: null });

    await act(async () => {
      update.resolve({
        ok: false,
        error: persistenceError("sizzle_update_failed", "first reel write failed")
      });
      await Promise.resolve();
    });
    expect(snapshot().active?.id).toBe("sz_2");
    expect(snapshot().saveState).toEqual({ phase: "saved", error: null });
    expect(snapshot().saveStates["sz_1"]).toEqual({
      phase: "error",
      error: persistenceError("sizzle_update_failed", "first reel write failed")
    });

    await act(async () => {
      vi.advanceTimersByTime(DEBOUNCE_MS + 1);
      await Promise.resolve();
    });
    expect(dispatch.mock.calls.filter(([name]) => name === "sizzle:update")).toHaveLength(1);
  });

  test("an external scenes update merges through a concurrent local title edit", async () => {
    const initial = project();
    const externalScene: SizzleScene = {
      id: "sc_external",
      captureId: "cap_external",
      scriptLine: "Added by the chat agent",
      durationOverrideSec: null,
      mediaTrim: null,
      audioSource: "auto",
      transition: "crossfade"
    };
    let stored = initial;
    const { emit } = installApi((name, req) => {
      if (name === "sizzle:list") return { ok: true, value: { projects: [initial] } };
      if (name === "library:list" || name === "library:listByIds") {
        return { ok: true, value: { rows: [] } };
      }
      if (name === "sizzle:update") {
        const patch = (req as { patch: Partial<SizzleProject> }).patch;
        stored = {
          ...stored,
          ...patch,
          modifiedAt: "2026-08-23T12:02:00.000Z"
        };
        return { ok: true, value: stored };
      }
      return { ok: true, value: undefined };
    });
    await mountHook();

    act(() => snapshot().onUpdate("sz_1", { name: "Local title" }));
    stored = {
      ...initial,
      scenes: [externalScene],
      modifiedAt: "2026-08-23T12:01:00.000Z"
    };
    act(() => {
      emit(EVENT_CHANNELS.sizzleProjectsChanged, { projects: [stored] });
    });
    expect(snapshot().active).toMatchObject({ name: "Local title" });
    expect(snapshot().active?.scenes).toEqual([externalScene]);

    let saved = false;
    await act(async () => {
      saved = await snapshot().flushPatch("sz_1");
    });
    expect(saved).toBe(true);
    expect(snapshot().saveState).toEqual({ phase: "saved", error: null });
    expect(snapshot().active).toMatchObject({ name: "Local title" });
    expect(snapshot().active?.scenes).toEqual([externalScene]);
  });

  test("a conflicting external scenes broadcast invalidates stale local undo history", async () => {
    const makeScene = (id: string, scriptLine: string): SizzleScene => ({
      id,
      captureId: `cap_${id}`,
      scriptLine,
      durationOverrideSec: null,
      mediaTrim: null,
      audioSource: "auto",
      transition: "crossfade"
    });
    const initialScene = makeScene("initial", "Initial scene");
    const localScene = makeScene("local", "Local scene edit");
    const externalScene = makeScene("external", "External scene edit");
    const initial = project({ scenes: [initialScene] });
    const { emit } = installApi((name) => {
      if (name === "sizzle:list") return { ok: true, value: { projects: [initial] } };
      if (name === "library:list" || name === "library:listByIds") {
        return { ok: true, value: { rows: [] } };
      }
      if (name === "sizzle:update") return { ok: true, value: initial };
      return { ok: true, value: undefined };
    });
    await mountHook();

    act(() => snapshot().onUpdate("sz_1", { scenes: [localScene] }));
    act(() => {
      emit(EVENT_CHANNELS.sizzleProjectsChanged, {
        projects: [
          {
            ...initial,
            scenes: [externalScene],
            modifiedAt: "2026-08-23T12:01:00.000Z"
          }
        ]
      });
    });
    expect(snapshot().active?.scenes).toEqual([localScene]);

    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true })
      );
    });
    expect(snapshot().active?.scenes).toEqual([localScene]);
  });

  test("double create dispatches once and dedupes the committed broadcast echo", async () => {
    const fresh = project({ id: "sz_new", name: "Untitled Sizzle" });
    const created = deferred<unknown>();
    const { dispatch, emit } = installApi((name) => {
      if (name === "sizzle:list") return { ok: true, value: { projects: [] } };
      if (name === "library:list" || name === "library:listByIds") {
        return { ok: true, value: { rows: [] } };
      }
      if (name === "sizzle:create") return created.promise;
      return { ok: true, value: undefined };
    });
    await mountHook();

    let firstCreate!: Promise<void>;
    act(() => {
      firstCreate = snapshot().onCreate();
      void snapshot().onCreate();
    });
    await flushMicrotasks();
    expect(dispatch.mock.calls.filter(([name]) => name === "sizzle:create")).toHaveLength(1);

    await act(async () => {
      emit(EVENT_CHANNELS.sizzleProjectsChanged, { projects: [fresh] });
      created.resolve({ ok: true, value: fresh });
      await firstCreate;
    });
    expect(snapshot().projects.filter(({ id }) => id === "sz_new")).toHaveLength(1);
    expect(snapshot().active?.id).toBe("sz_new");
  });

  test("double duplicate shares the save boundary and dispatches one copy", async () => {
    const initial = project();
    const copy = project({ id: "sz_copy", name: "Demo Reel Copy" });
    const duplicated = deferred<unknown>();
    const { dispatch } = installApi((name) => {
      if (name === "sizzle:list") return { ok: true, value: { projects: [initial] } };
      if (name === "library:list" || name === "library:listByIds") {
        return { ok: true, value: { rows: [] } };
      }
      if (name === "sizzle:duplicate") return duplicated.promise;
      return { ok: true, value: undefined };
    });
    await mountHook();

    let firstDuplicate!: Promise<void>;
    act(() => {
      firstDuplicate = snapshot().onDuplicate("sz_1");
      void snapshot().onDuplicate("sz_1");
    });
    await flushMicrotasks();
    expect(dispatch.mock.calls.filter(([name]) => name === "sizzle:duplicate")).toHaveLength(1);

    await act(async () => {
      duplicated.resolve({ ok: true, value: copy });
      await firstDuplicate;
    });
    expect(snapshot().active?.id).toBe("sz_copy");
    expect(snapshot().projects.filter(({ id }) => id === "sz_copy")).toHaveLength(1);
  });

  test("a failed delete after an in-flight save restores Saved instead of getting stuck", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const initial = project();
    const update = deferred<unknown>();
    const deleteError = persistenceError("sizzle_delete_failed", "project file is locked");
    const { dispatch } = installApi((name) => {
      if (name === "sizzle:list") return { ok: true, value: { projects: [initial] } };
      if (name === "library:list" || name === "library:listByIds") {
        return { ok: true, value: { rows: [] } };
      }
      if (name === "sizzle:update") return update.promise;
      if (name === "sizzle:delete") return { ok: false, error: deleteError };
      return { ok: true, value: undefined };
    });
    await mountHook();

    act(() => snapshot().onUpdate("sz_1", { name: "Saved before delete" }));
    let saving!: Promise<boolean>;
    act(() => {
      saving = snapshot().flushPatch("sz_1");
    });
    await flushMicrotasks();
    let deleting!: Promise<void>;
    act(() => {
      deleting = snapshot().onDelete("sz_1");
    });
    expect(dispatch.mock.calls.filter(([name]) => name === "sizzle:delete")).toHaveLength(0);

    await act(async () => {
      update.resolve({
        ok: true,
        value: { ...initial, name: "Saved before delete" }
      });
      await saving;
      await deleting;
    });
    expect(dispatch.mock.calls.filter(([name]) => name === "sizzle:delete")).toHaveLength(1);
    expect(snapshot().saveState).toEqual({ phase: "saved", error: null });
    expect(snapshot().actionFailure).toEqual({
      action: "delete",
      projectId: "sz_1",
      error: deleteError
    });
  });

  test("an older reveal success cannot clear a newer duplicate failure", async () => {
    const initial = project({ outputPath: "/tmp/render.mp4" });
    const revealed = deferred<unknown>();
    const duplicateError = persistenceError(
      "sizzle_duplicate_failed",
      "copy could not be written"
    );
    installApi((name) => {
      if (name === "sizzle:list") return { ok: true, value: { projects: [initial] } };
      if (name === "library:list" || name === "library:listByIds") {
        return { ok: true, value: { rows: [] } };
      }
      if (name === "sizzle:revealOutput") return revealed.promise;
      if (name === "sizzle:duplicate") return { ok: false, error: duplicateError };
      return { ok: true, value: undefined };
    });
    await mountHook();

    let reveal!: Promise<void>;
    act(() => {
      reveal = snapshot().onReveal();
      void snapshot().onDuplicate("sz_1");
    });
    await flushMicrotasks();
    expect(snapshot().actionFailure).toEqual({
      action: "duplicate",
      projectId: "sz_1",
      error: duplicateError
    });

    await act(async () => {
      revealed.resolve({ ok: true, value: undefined });
      await reveal;
    });
    expect(snapshot().actionFailure).toEqual({
      action: "duplicate",
      projectId: "sz_1",
      error: duplicateError
    });
  });

  test("concurrent action failures remain actionable in completion order", async () => {
    const initial = project({ outputPath: "/tmp/render.mp4" });
    const revealed = deferred<unknown>();
    const duplicateError = persistenceError(
      "sizzle_duplicate_failed",
      "copy could not be written"
    );
    const revealError = persistenceError(
      "sizzle_reveal_failed",
      "rendered output is unavailable"
    );
    installApi((name) => {
      if (name === "sizzle:list") return { ok: true, value: { projects: [initial] } };
      if (name === "library:list" || name === "library:listByIds") {
        return { ok: true, value: { rows: [] } };
      }
      if (name === "sizzle:revealOutput") return revealed.promise;
      if (name === "sizzle:duplicate") return { ok: false, error: duplicateError };
      return { ok: true, value: undefined };
    });
    await mountHook();

    let reveal!: Promise<void>;
    act(() => {
      reveal = snapshot().onReveal();
      void snapshot().onDuplicate("sz_1");
    });
    await flushMicrotasks();
    expect(snapshot().actionFailure?.action).toBe("duplicate");

    await act(async () => {
      revealed.resolve({ ok: false, error: revealError });
      await reveal;
    });
    expect(snapshot().actionFailure?.action).toBe("duplicate");

    act(() => snapshot().dismissActionFailure());
    expect(snapshot().actionFailure).toEqual({
      action: "reveal",
      projectId: "sz_1",
      error: revealError
    });
  });

  test("delete cancels a queued edit so no update can arrive after the delete", async () => {
    vi.useFakeTimers();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const first = project();
    const second = project({ id: "sz_2", name: "Second Reel" });
    const { dispatch } = installApi((name) => {
      if (name === "sizzle:list") return { ok: true, value: { projects: [first, second] } };
      if (name === "library:list" || name === "library:listByIds") {
        return { ok: true, value: { rows: [] } };
      }
      if (name === "sizzle:delete") return { ok: true, value: undefined };
      if (name === "sizzle:update") return { ok: true, value: first };
      return { ok: true, value: undefined };
    });
    await mountHook();

    act(() => snapshot().onUpdate("sz_1", { name: "Discard with delete" }));
    await act(async () => {
      await snapshot().onDelete("sz_1");
    });
    expect(dispatch.mock.calls.filter(([name]) => name === "sizzle:delete")).toEqual([
      ["sizzle:delete", { id: "sz_1" }]
    ]);
    expect(dispatch.mock.calls.filter(([name]) => name === "sizzle:update")).toHaveLength(0);
    expect(snapshot().active?.id).toBe("sz_2");

    await act(async () => {
      vi.advanceTimersByTime(DEBOUNCE_MS + 1);
      await Promise.resolve();
    });
    expect(dispatch.mock.calls.filter(([name]) => name === "sizzle:update")).toHaveLength(0);
  });

  test("window close waits for an in-flight save before allowing the native close", async () => {
    vi.useFakeTimers();
    const initial = project();
    const update = deferred<unknown>();
    const confirm = vi.spyOn(window, "confirm");
    const { dispatch, emit } = installApi((name) => {
      if (name === "sizzle:list") return { ok: true, value: { projects: [initial] } };
      if (name === "library:list" || name === "library:listByIds") {
        return { ok: true, value: { rows: [] } };
      }
      if (name === "sizzle:update") return update.promise;
      if (name === "sizzle:closeResponse") return { ok: true, value: undefined };
      return { ok: true, value: undefined };
    });
    await mountHook();

    act(() => snapshot().onUpdate("sz_1", { name: "First write" }));
    act(() => {
      void snapshot().flushPatch("sz_1");
    });
    await flushMicrotasks();
    expect(dispatch.mock.calls.filter(([name]) => name === "sizzle:update")).toHaveLength(1);

    act(() => {
      emit(EVENT_CHANNELS.sizzleCloseRequested, { requestId: 11 });
    });
    await flushMicrotasks();
    expect(
      dispatch.mock.calls.filter(([name]) => name === "sizzle:closeResponse")
    ).toHaveLength(0);

    await act(async () => {
      update.resolve({ ok: true, value: { ...initial, name: "First write" } });
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    });
    expect(dispatch.mock.calls.filter(([name]) => name === "sizzle:closeResponse")).toEqual([
      ["sizzle:closeResponse", { requestId: 11, action: "close" }]
    ]);
    expect(confirm).not.toHaveBeenCalled();
  });

  test("repeated close failures stay blocked until the user explicitly discards", async () => {
    vi.useFakeTimers();
    const initial = project();
    const error = persistenceError("sizzle_update_failed", "project file is read-only");
    const confirm = vi
      .spyOn(window, "confirm")
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    const { dispatch, emit } = installApi((name) => {
      if (name === "sizzle:list") return { ok: true, value: { projects: [initial] } };
      if (name === "library:list" || name === "library:listByIds") {
        return { ok: true, value: { rows: [] } };
      }
      if (name === "sizzle:update") return { ok: false, error };
      if (name === "sizzle:closeResponse") return { ok: true, value: undefined };
      return { ok: true, value: undefined };
    });
    await mountHook();

    act(() => snapshot().onUpdate("sz_1", { name: "Unsaved close" }));
    act(() => emit(EVENT_CHANNELS.sizzleCloseRequested, { requestId: 21 }));
    await flushMicrotasks(12);

    expect(dispatch.mock.calls.filter(([name]) => name === "sizzle:update")).toHaveLength(1);
    expect(dispatch.mock.calls.filter(([name]) => name === "sizzle:closeResponse")).toEqual([
      ["sizzle:closeResponse", { requestId: 21, action: "cancel" }]
    ]);
    expect(snapshot().saveState).toEqual({ phase: "error", error });

    act(() => emit(EVENT_CHANNELS.sizzleCloseRequested, { requestId: 22 }));
    await flushMicrotasks(12);

    expect(dispatch.mock.calls.filter(([name]) => name === "sizzle:update")).toHaveLength(2);
    expect(dispatch.mock.calls.filter(([name]) => name === "sizzle:closeResponse")).toEqual([
      ["sizzle:closeResponse", { requestId: 21, action: "cancel" }],
      ["sizzle:closeResponse", { requestId: 22, action: "close" }]
    ]);
    expect(confirm).toHaveBeenCalledTimes(2);
  });
});
