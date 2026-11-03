// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import {
  EVENT_CHANNELS,
  newSizzleSequenceScene,
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
  reject: (reason: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
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

// Deferred metadata and optional save/delete replies let each test choose
// completion order without wall-clock sleeps or the real capture library.
function installSceneApi(
  initial: SizzleProject[] = [project()],
  override: DispatchHandler = () => undefined
) {
  const stored = new Map(initial.map((value) => [value.id, value]));
  const lookups = new Map<string, Deferred<unknown>>();
  const updates: Array<{ id: string; patch: Partial<SizzleProject> }> = [];
  const api = installApi((name, req) => {
    if (name === "sizzle:update") {
      updates.push(req as (typeof updates)[number]);
    }
    const overridden = override(name, req);
    if (overridden !== undefined) return overridden;
    if (name === "sizzle:list") return { ok: true, value: { projects: [...stored.values()] } };
    if (name === "library:list" || name === "library:listByIds") {
      return { ok: true, value: { rows: [] } };
    }
    if (name === "codex:enrichment") {
      const lookup = deferred<unknown>();
      lookups.set((req as { captureId: string }).captureId, lookup);
      return lookup.promise;
    }
    if (name === "sizzle:update") {
      const { id, patch } = req as (typeof updates)[number];
      const saved = { ...stored.get(id)!, ...patch };
      stored.set(id, saved);
      return { ok: true, value: saved };
    }
    if (name === "sizzle:delete") {
      stored.delete((req as { id: string }).id);
    }
    return { ok: true, value: undefined };
  });
  return { ...api, stored, lookups, updates };
}

function sceneCaptureIds(value: SizzleProject | null): string[] {
  return value?.scenes.map((scene) => scene.captureId) ?? [];
}

function historyKey(shiftKey = false): void {
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true, shiftKey }));
}

describe("useSizzleProject scene operations", () => {
  test("without a destination project, scene operations admit no metadata or save work", async () => {
    const { dispatch, updates } = installSceneApi([]);
    await mountHook();

    await act(async () => {
      await snapshot().onAddScene("cap_a");
      await snapshot().onAddSequenceBeat("missing", "cap_b");
    });

    expect(dispatch.mock.calls.filter(([name]) => name === "codex:enrichment")).toEqual([]);
    expect(updates).toEqual([]);
    expect(snapshot().saveStates).toEqual({});
  });

  test.each([
    ["cap_a", "cap_b"],
    ["cap_b", "cap_a"]
  ])("concurrent additions retain both scenes when %s resolves before %s", async (first, second) => {
    vi.useFakeTimers();
    const { lookups, updates, stored } = installSceneApi();
    await mountHook();
    const adding = new Map<string, Promise<void>>();
    act(() => {
      adding.set("cap_a", snapshot().onAddScene("cap_a"));
      adding.set("cap_b", snapshot().onAddScene("cap_b"));
    });
    expect(snapshot().saveState.phase).toBe("saved");
    expect(lookups.size).toBe(2);

    for (const captureId of [first, second]) {
      await act(async () => {
        lookups.get(captureId)!.resolve({
          ok: true,
          value: { acceptedDescription: `  Narration for ${captureId}  ` }
        });
        await adding.get(captureId);
      });
      expect(sceneCaptureIds(snapshot().active)).toEqual(
        captureId === first ? [first] : [first, second]
      );
    }
    const added = snapshot().active!.scenes;
    expect(added.map((scene) => scene.narration)).toEqual([
      `Narration for ${first}`, `Narration for ${second}`
    ]);
    expect(new Set(added.map((scene) => scene.id)).size).toBe(2);
    expect(snapshot().saveState.phase).toBe("dirty");
    expect(updates).toHaveLength(0);

    // Additions within the existing history window remain one undo step.
    act(() => historyKey());
    expect(snapshot().active?.scenes).toEqual([]);
    act(() => historyKey(true));
    expect(snapshot().active?.scenes).toEqual(added);
    await act(async () => { expect(await snapshot().flushPatch("sz_1")).toBe(true); });
    expect(updates).toHaveLength(1);
    expect(stored.get("sz_1")?.scenes).toEqual(added);
    expect(snapshot().saveState.phase).toBe("saved");
  });

  test("metadata completions in the same React batch append to the latest scene list", async () => {
    vi.useFakeTimers();
    const { lookups } = installSceneApi();
    await mountHook();
    let additions!: Promise<void[]>;
    act(() => {
      additions = Promise.all([snapshot().onAddScene("cap_a"), snapshot().onAddScene("cap_b")]);
    });
    await act(async () => {
      lookups.get("cap_a")!.resolve({ ok: true, value: null });
      lookups.get("cap_b")!.resolve({ ok: true, value: null });
      await additions;
    });
    expect(sceneCaptureIds(snapshot().active)).toEqual(["cap_a", "cap_b"]);
  });

  test("a pending addition preserves local scene edits, deletions, ordering, and undo", async () => {
    vi.useFakeTimers();
    const scenes = ["cap_a", "cap_b", "cap_c"].map((id) => newSizzleSequenceScene([id]));
    const { lookups } = installSceneApi([project({ scenes })]);
    await mountHook();
    let adding!: Promise<void>;
    act(() => { adding = snapshot().onAddScene("cap_new"); });
    const edited = [{ ...scenes[2]!, narration: "Edited locally", scriptLine: "Edited locally" }, scenes[0]!];
    act(() => snapshot().onUpdate("sz_1", { scenes: edited, name: "Local title" }));
    await act(async () => { vi.advanceTimersByTime(DEBOUNCE_MS + 1); });

    await act(async () => {
      lookups.get("cap_new")!.resolve({ ok: true, value: null });
      await adding;
    });
    expect(snapshot().active?.scenes.slice(0, -1)).toEqual(edited);
    expect(sceneCaptureIds(snapshot().active)).toEqual(["cap_c", "cap_a", "cap_new"]);
    expect(snapshot().active?.name).toBe("Local title");
    act(() => historyKey());
    expect(snapshot().active?.scenes).toEqual(edited);
    act(() => historyKey(true));
    expect(sceneCaptureIds(snapshot().active)).toEqual(["cap_c", "cap_a", "cap_new"]);
  });

  test("an agent broadcast before metadata completion becomes the addition's undo baseline", async () => {
    vi.useFakeTimers();
    const { emit, lookups, stored } = installSceneApi();
    await mountHook();
    let adding!: Promise<void>;
    act(() => { adding = snapshot().onAddScene("cap_new"); });
    const external = project({ scenes: [newSizzleSequenceScene(["cap_agent"])] });
    stored.set(external.id, external);
    await act(async () => {
      // No render boundary between the authoritative event and completion.
      emit(EVENT_CHANNELS.sizzleProjectsChanged, { projects: [external] });
      lookups.get("cap_new")!.resolve({ ok: true, value: null });
      await adding;
    });
    expect(sceneCaptureIds(snapshot().active)).toEqual(["cap_agent", "cap_new"]);
    act(() => historyKey());
    expect(snapshot().active?.scenes).toEqual(external.scenes);
    await act(async () => { await snapshot().flushPatch("sz_1"); });
    expect(stored.get("sz_1")?.scenes).toEqual(external.scenes);
  });

  test("switching projects keeps pending additions and their history on the original destination", async () => {
    vi.useFakeTimers();
    const { lookups, stored, updates } = installSceneApi([project(), project({ id: "sz_2" })]);
    await mountHook();
    let adding!: Promise<void>;
    act(() => { adding = snapshot().onAddScene("cap_a"); });
    act(() => snapshot().selectProject("sz_2"));
    await act(async () => {
      lookups.get("cap_a")!.resolve({ ok: true, value: null });
      await adding;
    });
    expect(snapshot().active?.id).toBe("sz_2");
    expect(snapshot().active?.scenes).toEqual([]);
    expect(sceneCaptureIds(snapshot().projects.find((p) => p.id === "sz_1")!)).toEqual(["cap_a"]);
    act(() => historyKey());
    expect(sceneCaptureIds(snapshot().projects.find((p) => p.id === "sz_1")!)).toEqual(["cap_a"]);
    await act(async () => { vi.advanceTimersByTime(DEBOUNCE_MS + 1); });
    expect(updates.map(({ id }) => id)).toEqual(["sz_1"]);
    expect(sceneCaptureIds(stored.get("sz_1")!)).toEqual(["cap_a"]);
    act(() => snapshot().selectProject("sz_1"));
    act(() => historyKey());
    expect(snapshot().active?.scenes).toEqual([]);
  });

  test.each(["metadata-first", "delete-first"])("successful deletion cancels pending scene work: %s", async (order) => {
    vi.useFakeTimers();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const deletion = deferred<unknown>();
    const { lookups, updates } = installSceneApi(
      [project(), project({ id: "sz_2" })],
      (name) => name === "sizzle:delete" ? deletion.promise : undefined
    );
    await mountHook();
    let adding!: Promise<void>;
    let deleting!: Promise<void>;
    act(() => {
      adding = snapshot().onAddScene("cap_a");
      deleting = snapshot().onDelete("sz_1");
    });
    const finishMetadata = async () => {
      lookups.get("cap_a")!.resolve({ ok: true, value: null });
      await adding;
    };
    const finishDelete = async () => {
      deletion.resolve({ ok: true, value: undefined });
      await deleting;
    };
    await act(async () => {
      if (order === "metadata-first") { await finishMetadata(); await finishDelete(); }
      else { await finishDelete(); await finishMetadata(); }
    });
    await act(async () => { vi.advanceTimersByTime(DEBOUNCE_MS + 1); });
    expect(snapshot().projects.map(({ id }) => id)).toEqual(["sz_2"]);
    expect(snapshot().saveStates["sz_1"]).toBeUndefined();
    expect(updates).toHaveLength(0);
  });

  test("an external deletion before metadata completion cannot create an orphan save", async () => {
    vi.useFakeTimers();
    const { emit, lookups, updates } = installSceneApi();
    await mountHook();
    let adding!: Promise<void>;
    act(() => { adding = snapshot().onAddScene("cap_a"); });
    await act(async () => {
      emit(EVENT_CHANNELS.sizzleProjectsChanged, { projects: [] });
      lookups.get("cap_a")!.resolve({ ok: true, value: null });
      await adding;
    });
    await act(async () => { vi.advanceTimersByTime(DEBOUNCE_MS + 1); });
    expect(snapshot().projects).toEqual([]);
    expect(snapshot().saveStates).toEqual({});
    expect(updates).toHaveLength(0);
  });

  test("a failed deletion resumes the paused save containing a completed addition", async () => {
    vi.useFakeTimers();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const deletion = deferred<unknown>();
    const { lookups, updates, stored } = installSceneApi(
      [project()], (name) => name === "sizzle:delete" ? deletion.promise : undefined
    );
    await mountHook();
    let adding!: Promise<void>;
    let deleting!: Promise<void>;
    act(() => {
      adding = snapshot().onAddScene("cap_a");
      deleting = snapshot().onDelete("sz_1");
    });
    await act(async () => {
      lookups.get("cap_a")!.resolve({ ok: true, value: null });
      await adding;
      vi.advanceTimersByTime(DEBOUNCE_MS + 1);
    });
    expect(updates).toHaveLength(0);
    await act(async () => {
      deletion.resolve({ ok: false, error: persistenceError("delete_failed", "locked") });
      await deleting;
    });
    expect(snapshot().actionFailure?.action).toBe("delete");
    await act(async () => { vi.advanceTimersByTime(DEBOUNCE_MS + 1); });
    expect(updates).toHaveLength(1);
    expect(sceneCaptureIds(stored.get("sz_1")!)).toEqual(["cap_a"]);
    expect(snapshot().saveState.phase).toBe("saved");
  });

  test.each(["result-error", "transport-rejection"])("metadata failure still adds an editable scene: %s", async (mode) => {
    vi.useFakeTimers();
    const { lookups } = installSceneApi();
    await mountHook();
    let adding!: Promise<void>;
    act(() => { adding = snapshot().onAddScene("cap_a"); });
    let failure: unknown;
    await act(async () => {
      if (mode === "result-error") {
        lookups.get("cap_a")!.resolve({ ok: false, error: persistenceError("lookup_failed", "unavailable") });
      } else {
        lookups.get("cap_a")!.reject(new Error("bridge disconnected"));
      }
      try { await adding; } catch (cause) { failure = cause; }
    });
    expect(failure).toBeUndefined();
    expect(snapshot().active?.scenes[0]).toMatchObject({ captureId: "cap_a", narration: "", scriptLine: "" });
    expect(snapshot().saveState.phase).toBe("dirty");
    act(() => historyKey());
    expect(snapshot().active?.scenes).toEqual([]);
  });

  test("metadata completion after unmount creates no save timer or dispatch", async () => {
    vi.useFakeTimers();
    const { lookups, updates } = installSceneApi();
    await mountHook();
    let adding!: Promise<void>;
    act(() => { adding = snapshot().onAddScene("cap_a"); });
    await act(async () => { root!.unmount(); });
    root = null;
    await act(async () => {
      lookups.get("cap_a")!.resolve({ ok: true, value: null });
      await adding;
      vi.advanceTimersByTime(DEBOUNCE_MS + 1);
    });
    expect(updates).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("same-turn clip additions keep current edits and unique beat identities", async () => {
    vi.useFakeTimers();
    const scene = newSizzleSequenceScene(["cap_initial"]);
    const { stored } = installSceneApi([project({ scenes: [scene] })]);
    await mountHook();
    await act(async () => {
      snapshot().onUpdate("sz_1", { scenes: [{ ...scene, narration: "Local edit" }] });
      await Promise.all([
        snapshot().onAddSequenceBeat(scene.id, "cap_a"),
        snapshot().onAddSequenceBeat(scene.id, "cap_b")
      ]);
    });
    const updated = snapshot().active!.scenes[0]!;
    expect(updated.narration).toBe("Local edit");
    expect(updated.beats?.map((beat) => beat.captureId)).toEqual(["cap_initial", "cap_a", "cap_b"]);
    expect(new Set(updated.beats?.map((beat) => beat.id)).size).toBe(3);
    await act(async () => { await snapshot().flushPatch("sz_1"); });
    expect(stored.get("sz_1")?.scenes).toEqual([updated]);
  });

  test("a stale clip callback cannot restore a removed scene or dirty a missing target", async () => {
    vi.useFakeTimers();
    const scene = newSizzleSequenceScene(["cap_initial"]);
    const { updates } = installSceneApi([project({ scenes: [scene] })]);
    await mountHook();
    const addBeat = snapshot().onAddSequenceBeat;
    act(() => snapshot().onUpdate("sz_1", { scenes: [] }));
    await act(async () => { await snapshot().flushPatch("sz_1"); });
    await act(async () => {
      await addBeat(scene.id, "cap_a");
      await snapshot().onAddSequenceBeat("missing", "cap_b");
    });
    expect(snapshot().active?.scenes).toEqual([]);
    expect(snapshot().saveState.phase).toBe("saved");
    await act(async () => { vi.advanceTimersByTime(DEBOUNCE_MS + 1); });
    expect(updates).toHaveLength(1);
  });

  test("additions join the serialized save lane and survive a failed write until explicit retry", async () => {
    vi.useFakeTimers();
    const saves: Array<Deferred<unknown>> = [];
    const { lookups, emit, updates } = installSceneApi([project()], (name) => {
      if (name !== "sizzle:update") return undefined;
      const save = deferred<unknown>();
      saves.push(save);
      return save.promise;
    });
    await mountHook();
    let addA!: Promise<void>;
    let addB!: Promise<void>;
    act(() => {
      addA = snapshot().onAddScene("cap_a");
      addB = snapshot().onAddScene("cap_b");
    });
    await act(async () => {
      lookups.get("cap_a")!.resolve({ ok: true, value: null });
      await addA;
    });
    let saving!: Promise<boolean>;
    act(() => { saving = snapshot().flushPatch("sz_1"); });
    await flushMicrotasks();
    await act(async () => {
      lookups.get("cap_b")!.resolve({ ok: true, value: null });
      await addB;
      vi.advanceTimersByTime(DEBOUNCE_MS + 1);
    });
    expect(saves).toHaveLength(1);
    expect(snapshot().saveState.phase).toBe("saving");
    expect(sceneCaptureIds(snapshot().active)).toEqual(["cap_a", "cap_b"]);
    await act(async () => {
      const committed = project(updates[0]!.patch);
      emit(EVENT_CHANNELS.sizzleProjectsChanged, { projects: [committed] });
      saves[0]!.resolve({ ok: true, value: committed });
    });
    expect(saves).toHaveLength(2);
    expect(updates[1]!.patch.scenes?.map((scene) => scene.captureId)).toEqual(["cap_a", "cap_b"]);
    await act(async () => {
      saves[1]!.resolve({ ok: false, error: persistenceError("save_failed", "locked") });
      expect(await saving).toBe(false);
    });
    expect(snapshot().saveState.phase).toBe("error");
    await act(async () => { vi.advanceTimersByTime(DEBOUNCE_MS + 1); });
    expect(saves).toHaveLength(2);
    let retry!: Promise<boolean>;
    act(() => { retry = snapshot().retrySave("sz_1"); });
    await flushMicrotasks();
    expect(updates[2]!.patch.scenes?.map((scene) => scene.captureId)).toEqual(["cap_a", "cap_b"]);
    await act(async () => {
      saves[2]!.resolve({ ok: true, value: project(updates[2]!.patch) });
      expect(await retry).toBe(true);
    });
    expect(sceneCaptureIds(snapshot().active)).toEqual(["cap_a", "cap_b"]);
    expect(snapshot().saveState.phase).toBe("saved");
  });
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

  test("a video added as a clip carries no trim of its own — it follows the Library edit", async () => {
    // The capture is trimmed to 2–8 s in the Library. Copying that onto
    // the clip would freeze it: a later Library re-trim (or a longer
    // recording's 60 s window check) would never reach the reel.
    const seq: SizzleScene = {
      id: "sc_seq",
      kind: "sequence",
      captureId: "cap_img",
      scriptLine: "narration",
      narration: "narration",
      durationOverrideSec: null,
      mediaTrim: null,
      audioSource: "voiceover",
      transition: "crossfade",
      beats: [{ id: "bt_0", captureId: "cap_img", timing: { kind: "auto" }, mediaTrim: null, transition: "cut", videoFit: "smart-fit" }]
    };
    const video = {
      id: "cap_v",
      kind: "video",
      video: { durationSec: 10, defaultRange: { start: 2, end: 8 }, segments: [{ start: 2, end: 8 }] }
    };
    const { dispatch } = installApi((name) => {
      if (name === "sizzle:list") return { ok: true, value: { projects: [project({ scenes: [seq] })] } };
      if (name === "library:list" || name === "library:listByIds") return { ok: true, value: { rows: [video] } };
      if (name === "codex:enrichment") return { ok: true, value: null };
      if (name === "sizzle:update") return { ok: true, value: project() };
      return { ok: true, value: undefined };
    });
    await mountHook();

    await act(async () => {
      await snapshot().onAddSequenceBeat("sc_seq", "cap_v");
    });
    await act(async () => {
      await snapshot().onAddScene("cap_v");
    });
    const scenes = snapshot().active!.scenes;
    expect(scenes[0]!.beats!.map((b) => [b.captureId, b.mediaTrim])).toEqual([
      ["cap_img", null],
      ["cap_v", null]
    ]);
    expect(scenes[1]!.beats![0]!.mediaTrim).toBeNull();
    expect(dispatch).toHaveBeenCalledWith("codex:enrichment", { captureId: "cap_v" });
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
