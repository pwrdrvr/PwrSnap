// The Sizzle composer's project state: the project list, the active reel,
// the captures it references, render progress, the debounced + coalesced
// patch writer, per-reel undo/redo, and live sync with external writers
// (the chat agent, another window). UI-only state (picker, chat width,
// the rail dropdown) stays in the shell.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  EVENT_CHANNELS,
  newSizzleSequenceScene,
  normalizeSizzleSequenceBeatContinuity,
  type CaptureRecord,
  type PwrSnapError,
  type SizzleProject,
  type SizzleRenderProgressEvent,
  type SizzleScene,
  type SizzleSequenceBeat
} from "@pwrsnap/shared";
import { dispatch, subscribe } from "../../lib/pwrsnap";
import type { ProjectRailModel } from "./ProjectRail";
import { IDLE_STATUS, type RenderStatus } from "./RenderStatusBar";
import {
  mergeProjectPatch,
  readInitialProjectId,
  referencedCaptureIdsForProject
} from "./sizzle-helpers";

export const RECENT_PROJECT_LIMIT = 5;
export const PROJECT_LIST_LIMIT = 100;

// Per-project debounce timers + pending-patch coalescing. Multiple
// edits to the same project within DEBOUNCE_MS get merged into one
// disk write. Critical for fast-typed text fields — the previous
// dispatch-per-keystroke pattern raced: each in-flight dispatch
// carried a snapshot built from STALE local state (since setProjects
// only ran after the dispatch returned), so only the last typed
// character survived a sustained burst of typing.
export const DEBOUNCE_MS = 350;
// Undo records on scene edits coalesced at the same window; a drag that
// emitted a patch per pointermove would fill the stack with intermediate
// frames, which is why the timeline commits once on release.
const HISTORY_COALESCE_MS = DEBOUNCE_MS;
const HISTORY_MAX = 50;

export type SizzleProjectPatch = Partial<Omit<SizzleProject, "id" | "createdAt">>;

export type SizzleSaveState =
  | { phase: "saved"; error: null }
  | { phase: "dirty"; error: null }
  | { phase: "saving"; error: null }
  | { phase: "error"; error: PwrSnapError };

export type SizzleProjectAction = "create" | "duplicate" | "delete" | "reveal";

export type SizzleActionFailure = {
  action: SizzleProjectAction;
  projectId: string | null;
  error: PwrSnapError;
};

type SizzleActionFailureEntry = {
  requestId: number;
  failure: SizzleActionFailure;
  retry: () => Promise<void>;
};

const SAVED_STATE: SizzleSaveState = { phase: "saved", error: null };

function unexpectedDispatchError(code: string, cause: unknown): PwrSnapError {
  return {
    kind: "unknown",
    code,
    message: cause instanceof Error ? cause.message : String(cause)
  };
}

function applyLocalPatchToAuthoritative(
  project: SizzleProject,
  patch: SizzleProjectPatch | null
): SizzleProject {
  if (patch === null) return project;
  return {
    ...mergeProjectPatch(project, patch),
    // Local edits never own the persistence timestamp. Keep the timestamp
    // from the authoritative snapshot while overlaying optimistic fields.
    modifiedAt: project.modifiedAt
  };
}

export function admitRecentProject(prev: string[], id: string): string[] {
  if (prev.includes(id)) return prev;
  return [id, ...prev].slice(0, RECENT_PROJECT_LIMIT);
}

export type SizzleProjectState = {
  projects: SizzleProject[];
  active: SizzleProject | null;
  activeId: string | null;
  loading: boolean;
  loadError: PwrSnapError | null;
  retryLoad: () => Promise<void>;
  captures: CaptureRecord[];
  status: RenderStatus;
  saveState: SizzleSaveState;
  saveStates: Readonly<Record<string, SizzleSaveState>>;
  retrySave: (id: string) => Promise<boolean>;
  actionFailure: SizzleActionFailure | null;
  retryAction: () => Promise<void>;
  dismissActionFailure: () => void;
  projectRail: ProjectRailModel;
  /** The reel whose title input should grab focus (just created / duplicated). */
  focusTitleForId: string | null;
  setFocusTitleForId: (id: string | null) => void;
  selectProject: (id: string) => void;
  onCreate: () => Promise<void>;
  onDuplicate: (id: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onRender: () => Promise<void>;
  onReveal: () => Promise<void>;
  onUpdate: (id: string, patch: SizzleProjectPatch) => void;
  flushPatch: (id: string) => Promise<boolean>;
  /** Append a new sequence scene built from one capture (the picker's "scene" target). */
  onAddScene: (captureId: string) => Promise<void>;
  /** Append a clip to an existing sequence scene (the picker's "sequenceBeat" target). */
  onAddSequenceBeat: (sceneId: string, captureId: string) => Promise<void>;
};

export function useSizzleProject(): SizzleProjectState {
  const [projects, setProjects] = useState<SizzleProject[]>([]);
  // Seed from the hash so a window opened to a specific reel lands on it,
  // not on projects[0]. reloadProjects only defaults to projects[0] when
  // activeId is still null, so this never gets clobbered.
  const [activeId, setActiveId] = useState<string | null>(() => readInitialProjectId());
  const [captures, setCaptures] = useState<CaptureRecord[]>([]);
  const requestedCaptureIdsRef = useRef<Set<string>>(new Set());
  const [status, setStatus] = useState<RenderStatus>(IDLE_STATUS);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<PwrSnapError | null>(null);
  const [saveStates, setSaveStates] = useState<Record<string, SizzleSaveState>>({});
  const [actionFailure, setActionFailure] = useState<SizzleActionFailure | null>(null);
  const [focusTitleForId, setFocusTitleForId] = useState<string | null>(null);
  const [recentProjectIds, setRecentProjectIds] = useState<string[]>(() => {
    const initial = readInitialProjectId();
    return initial === null ? [] : [initial];
  });

  const mountedRef = useRef(true);
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  const projectsRef = useRef<SizzleProject[]>(projects);
  projectsRef.current = projects;
  const saveStatesRef = useRef(saveStates);
  saveStatesRef.current = saveStates;

  const pendingPatches = useRef<Map<string, SizzleProjectPatch>>(new Map());
  const debounceTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map()
  );
  // One drain promise per project is the client-side serialization lane.
  // A drain owns at most one update dispatch at a time and takes another
  // coalesced snapshot only after the prior write succeeds.
  const drainPromises = useRef<Map<string, Promise<boolean>>>(new Map());
  const inFlightPatches = useRef<Map<string, SizzleProjectPatch>>(new Map());
  const pausedProjectIds = useRef<Set<string>>(new Set());
  const failedProjectIds = useRef<Set<string>>(new Set());
  const authoritativeProjectsRef = useRef<Map<string, SizzleProject>>(new Map());
  const authoritativeRevisionRef = useRef<Map<string, number>>(new Map());
  const authoritativeRevisionCounterRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const setProjectSaveState = useCallback(
    (id: string, state: SizzleSaveState): void => {
      if (!mountedRef.current) return;
      setSaveStates((prev) => (prev[id] === state ? prev : { ...prev, [id]: state }));
    },
    []
  );

  const hasLocalWork = useCallback(
    (id: string): boolean =>
      pendingPatches.current.has(id) ||
      inFlightPatches.current.has(id) ||
      failedProjectIds.current.has(id) ||
      saveStatesRef.current[id]?.phase === "error",
    []
  );

  const localWorkPatch = useCallback((id: string): SizzleProjectPatch | null => {
    const inFlight = inFlightPatches.current.get(id);
    const pending = pendingPatches.current.get(id);
    if (inFlight === undefined && pending === undefined) return null;
    return { ...(inFlight ?? {}), ...(pending ?? {}) };
  }, []);

  const active = useMemo(
    () => projects.find((p) => p.id === activeId) ?? null,
    [projects, activeId]
  );

  const projectRail = useMemo<ProjectRailModel>(() => {
    const byId = new Map(projects.map((p) => [p.id, p]));
    const recents = recentProjectIds
      .map((id) => byId.get(id) ?? null)
      .filter((p): p is SizzleProject => p !== null)
      .slice(0, RECENT_PROJECT_LIMIT);
    const recentSet = new Set(recents.map((p) => p.id));
    const list = projects
      .filter((p) => !recentSet.has(p.id))
      .slice(0, PROJECT_LIST_LIMIT);
    return { recents, list, totalProjectCount: projects.length };
  }, [projects, recentProjectIds]);

  const selectProject = useCallback((id: string): void => {
    setActiveId(id);
    setRecentProjectIds((prev) => admitRecentProject(prev, id));
  }, []);

  const loadRequestRef = useRef(0);
  const reloadProjects = useCallback(async (): Promise<void> => {
    const request = ++loadRequestRef.current;
    if (mountedRef.current) {
      setLoading(true);
      setLoadError(null);
    }
    try {
      const r = await dispatch("sizzle:list", {});
      if (!mountedRef.current || request !== loadRequestRef.current) return;
      setLoading(false);
      if (!r.ok) {
        setLoadError(r.error);
        return;
      }
      setLoadError(null);
      for (const project of r.value.projects) {
        authoritativeProjectsRef.current.set(project.id, project);
      }
      setProjects((prev) => {
        const incomingIds = new Set(r.value.projects.map((project) => project.id));
        return [
          ...r.value.projects.map((project) =>
            applyLocalPatchToAuthoritative(project, localWorkPatch(project.id))
          ),
          // A stale list reply must not erase a local project that still
          // has an update in flight. Its authoritative broadcast/list
          // snapshot will reconcile it after the lane becomes clean.
          ...prev.filter(
            (project) => !incomingIds.has(project.id) && hasLocalWork(project.id)
          )
        ];
      });
      if (activeIdRef.current === null && r.value.projects.length > 0) {
        selectProject(r.value.projects[0]!.id);
      }
    } catch (cause) {
      if (!mountedRef.current || request !== loadRequestRef.current) return;
      setLoading(false);
      setLoadError(unexpectedDispatchError("sizzle_list_failed", cause));
    }
  }, [hasLocalWork, localWorkPatch, selectProject]);

  useEffect(() => {
    void reloadProjects();
  }, [reloadProjects]);

  useEffect(() => {
    void dispatch("library:list", { limit: 200 }).then((r) => {
      if (r.ok) setCaptures(r.value.rows);
    });
  }, []);

  useEffect(() => {
    if (active === null) return;
    const loadedIds = new Set(captures.map((capture) => capture.id));
    const missing = referencedCaptureIdsForProject(active).filter(
      (id) => !loadedIds.has(id) && !requestedCaptureIdsRef.current.has(id)
    );
    if (missing.length === 0) return;
    for (const id of missing) requestedCaptureIdsRef.current.add(id);
    let cancelled = false;
    void dispatch("library:listByIds", { ids: missing }).then((r) => {
      if (cancelled || !r.ok || r.value.rows.length === 0) return;
      setCaptures((prev) => {
        const byId = new Map(prev.map((capture) => [capture.id, capture]));
        for (const capture of r.value.rows) byId.set(capture.id, capture);
        return [...byId.values()];
      });
    });
    return () => {
      cancelled = true;
    };
  }, [active, captures]);

  useEffect(() => {
    return subscribe(EVENT_CHANNELS.sizzleRenderProgress, (payload) => {
      const evt = payload as SizzleRenderProgressEvent;
      if (evt.projectId !== activeId) return;
      setStatus({
        phase: evt.phase,
        message: evt.message,
        ratio: evt.ratio,
        error: evt.error?.message ?? null
      });
      if (evt.phase === "done") {
        void reloadProjects();
      }
    });
  }, [activeId, reloadProjects]);

  const currentActionFailureRef = useRef<SizzleActionFailureEntry | null>(null);
  const queuedActionFailuresRef = useRef<SizzleActionFailureEntry[]>([]);
  const nextActionRequestRef = useRef(0);
  const beginActionRequest = useCallback((): number => {
    nextActionRequestRef.current += 1;
    return nextActionRequestRef.current;
  }, []);
  const showActionFailure = useCallback(
    (
      requestId: number,
      action: SizzleProjectAction,
      projectId: string | null,
      error: PwrSnapError,
      retry: () => Promise<void>
    ): void => {
      const entry: SizzleActionFailureEntry = {
        requestId,
        failure: { action, projectId, error },
        retry
      };
      if (currentActionFailureRef.current === null) {
        currentActionFailureRef.current = entry;
        if (mountedRef.current) setActionFailure(entry.failure);
        return;
      }
      // Concurrent actions can fail in either completion order. Keep every
      // failure actionable; the notice advances through this FIFO as the
      // user retries or dismisses each one.
      queuedActionFailuresRef.current.push(entry);
    },
    []
  );
  const exposeNextActionFailure = useCallback((): void => {
    const next = queuedActionFailuresRef.current.shift() ?? null;
    currentActionFailureRef.current = next;
    if (mountedRef.current) setActionFailure(next?.failure ?? null);
  }, []);
  const clearActionFailure = useCallback(
    (
      requestId: number,
      action: SizzleProjectAction,
      projectId: string | null
    ): void => {
      const matches = (entry: SizzleActionFailureEntry): boolean =>
        entry.requestId === requestId ||
        (entry.failure.action === action && entry.failure.projectId === projectId);
      queuedActionFailuresRef.current = queuedActionFailuresRef.current.filter(
        (entry) => !matches(entry)
      );
      const current = currentActionFailureRef.current;
      if (current !== null && matches(current)) exposeNextActionFailure();
    },
    [exposeNextActionFailure]
  );
  const dismissActionFailure = useCallback((): void => {
    exposeNextActionFailure();
  }, [exposeNextActionFailure]);
  const retryAction = useCallback(async (): Promise<void> => {
    const current = currentActionFailureRef.current;
    if (current === null) return;
    exposeNextActionFailure();
    await current.retry();
  }, [exposeNextActionFailure]);

  const creatingProjectRef = useRef(false);
  const onCreate = useCallback(async function createProject(): Promise<void> {
    if (creatingProjectRef.current) return;
    creatingProjectRef.current = true;
    const requestId = beginActionRequest();
    // Electron deliberately doesn't implement window.prompt — it
    // silently returns null. Skip the dialog: create with a default
    // name and auto-focus the editor's title input so the user can
    // rename in one keystroke.
    try {
      const r = await dispatch("sizzle:create", { name: "Untitled Sizzle" });
      if (!r.ok) {
        showActionFailure(requestId, "create", null, r.error, createProject);
        return;
      }
      clearActionFailure(requestId, "create", null);
      if (!mountedRef.current) return;
      // The main handler broadcasts the committed list before the invoke
      // response resolves, so the new project may already be present.
      setProjects((prev) => [r.value, ...prev.filter((p) => p.id !== r.value.id)]);
      setProjectSaveState(r.value.id, SAVED_STATE);
      selectProject(r.value.id);
      setFocusTitleForId(r.value.id);
    } catch (cause) {
      showActionFailure(
        requestId,
        "create",
        null,
        unexpectedDispatchError("sizzle_create_failed", cause),
        createProject
      );
    } finally {
      creatingProjectRef.current = false;
    }
  }, [
    beginActionRequest,
    clearActionFailure,
    selectProject,
    setProjectSaveState,
    showActionFailure
  ]);

  // ── Undo / redo (per active project) ────────────────────────────────
  // Every local scene mutation funnels through onUpdate({ scenes }); we
  // snapshot the PRE-edit scenes so ⌘Z can restore them. Keyed by project
  // id, so each reel keeps its own history for the session. External chat
  // broadcasts arrive OUTSIDE onUpdate and are intentionally not recorded.
  // Rapid edits (typing) coalesce into one entry within the debounce
  // window. `applyingHistoryRef` suppresses recording while an undo/redo
  // is being applied (so it doesn't re-record or clear the redo stack).
  const undoStacks = useRef<Map<string, SizzleScene[][]>>(new Map());
  const redoStacks = useRef<Map<string, SizzleScene[][]>>(new Map());
  const lastHistoryAtRef = useRef<Map<string, number>>(new Map());
  const applyingHistoryRef = useRef(false);

  const clearDebounceTimer = useCallback((id: string): void => {
    const timer = debounceTimers.current.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      debounceTimers.current.delete(id);
    }
  }, []);

  const flushPatchRef = useRef<(id: string) => Promise<boolean>>(async () => true);
  const flushPatch = useCallback(
    (id: string): Promise<boolean> => {
      clearDebounceTimer(id);
      const existing = drainPromises.current.get(id);
      if (existing !== undefined) return existing;
      if (pausedProjectIds.current.has(id)) return Promise.resolve(false);
      // A failed snapshot stays retained until the visible Retry save
      // action explicitly clears this gate. Render/preview/duplicate must
      // not silently turn into an automatic retry of a known-bad write.
      if (failedProjectIds.current.has(id)) return Promise.resolve(false);

      // Queue the worker into a microtask so the shared promise is visible
      // before the first IPC dispatch starts. A synchronous project-change
      // broadcast from that dispatch must see the project as in flight.
      let tracked!: Promise<boolean>;
      const drain = async (): Promise<boolean> => {
        while (!pausedProjectIds.current.has(id)) {
          clearDebounceTimer(id);
          const patch = pendingPatches.current.get(id);
          if (patch === undefined) {
            if (!failedProjectIds.current.has(id)) {
              setProjectSaveState(id, SAVED_STATE);
            }
            return true;
          }
          pendingPatches.current.delete(id);
          inFlightPatches.current.set(id, patch);
          setProjectSaveState(id, { phase: "saving", error: null });
          const authoritativeRevisionBeforeDispatch =
            authoritativeRevisionRef.current.get(id) ?? 0;

          let error: PwrSnapError | null = null;
          let savedProject: SizzleProject | null = null;
          try {
            const r = await dispatch("sizzle:update", { id, patch });
            if (r.ok) savedProject = r.value;
            else error = r.error;
          } catch (cause) {
            error = unexpectedDispatchError("sizzle_update_failed", cause);
          }
          inFlightPatches.current.delete(id);

          if (error !== null) {
            // Put the failed snapshot BACK underneath anything edited while
            // it was in flight. Later values win field-by-field, including
            // a wholesale newer scenes array.
            const newer = pendingPatches.current.get(id) ?? {};
            pendingPatches.current.set(id, { ...patch, ...newer });
            clearDebounceTimer(id);
            failedProjectIds.current.add(id);
            setProjectSaveState(id, { phase: "error", error });
            return false;
          }

          failedProjectIds.current.delete(id);
          if (mountedRef.current && savedProject !== null) {
            // The handler broadcasts before its invoke response. If an
            // authoritative snapshot arrived during this write, it includes
            // our patch and any serialized external edits; otherwise the
            // response itself is authoritative (as in the unit-test bridge).
            const authoritativeRevisionAfterDispatch =
              authoritativeRevisionRef.current.get(id) ?? 0;
            const base =
              authoritativeRevisionAfterDispatch > authoritativeRevisionBeforeDispatch
                ? (authoritativeProjectsRef.current.get(id) ?? savedProject)
                : applyLocalPatchToAuthoritative(savedProject, patch);
            const newer = pendingPatches.current.get(id) ?? null;
            const reconciled = applyLocalPatchToAuthoritative(base, newer);
            setProjects((prev) =>
              prev.map((project) =>
                project.id === id ? reconciled : project
              )
            );
          }
          // Loop immediately when an edit arrived during this write. That
          // makes flushPatch a real persistence barrier for preview/render/
          // duplicate without ever running two updates concurrently.
        }
        if (
          !pendingPatches.current.has(id) &&
          !failedProjectIds.current.has(id)
        ) {
          setProjectSaveState(id, SAVED_STATE);
        }
        return true;
      };

      tracked = Promise.resolve()
        .then(drain)
        .finally(() => {
          if (drainPromises.current.get(id) === tracked) {
            drainPromises.current.delete(id);
          }
          inFlightPatches.current.delete(id);
          // onUpdate normally cannot interleave between the drain's final
          // empty check and this promise finalizer. Re-check anyway so a
          // React/effect boundary at exactly that edge can never strand a
          // patch merely because it observed the old lane as in flight.
          if (
            pendingPatches.current.has(id) &&
            !pausedProjectIds.current.has(id) &&
            !failedProjectIds.current.has(id)
          ) {
            void flushPatchRef.current(id);
          }
        });
      drainPromises.current.set(id, tracked);
      return tracked;
    },
    [clearDebounceTimer, setProjectSaveState]
  );
  flushPatchRef.current = flushPatch;

  const retrySave = useCallback((id: string): Promise<boolean> => {
    failedProjectIds.current.delete(id);
    return flushPatchRef.current(id);
  }, []);

  const closeRequestInFlightRef = useRef(false);
  useEffect(() => {
    return subscribe(EVENT_CHANNELS.sizzleCloseRequested, (payload) => {
      if (
        closeRequestInFlightRef.current ||
        typeof payload !== "object" ||
        payload === null ||
        !Number.isSafeInteger((payload as { requestId?: unknown }).requestId)
      ) {
        return;
      }
      const requestId = (payload as { requestId: number }).requestId;
      closeRequestInFlightRef.current = true;

      void (async () => {
        let saved = true;
        while (saved) {
          const ids = new Set([
            ...pendingPatches.current.keys(),
            ...inFlightPatches.current.keys(),
            ...failedProjectIds.current.keys()
          ]);
          if (ids.size === 0) break;
          for (const id of ids) {
            // Closing is an explicit persistence boundary, so retry a retained
            // failed patch once while the native close remains blocked.
            failedProjectIds.current.delete(id);
            if (!(await flushPatchRef.current(id))) saved = false;
          }
        }

        const action =
          saved ||
          window.confirm(
            "PwrSnap could not save all Sizzle changes. Close and discard the unsaved changes?"
          )
            ? "close"
            : "cancel";
        try {
          const response = await dispatch("sizzle:closeResponse", { requestId, action });
          if (!response.ok || action === "cancel") {
            closeRequestInFlightRef.current = false;
          }
        } catch {
          closeRequestInFlightRef.current = false;
        }
      })();
    });
  }, []);

  const duplicatingProjectIds = useRef<Set<string>>(new Set());
  const onDuplicate = useCallback(
    async function duplicateProject(id: string): Promise<void> {
      if (duplicatingProjectIds.current.has(id)) return;
      duplicatingProjectIds.current.add(id);
      let requestId: number | null = null;
      try {
        if (!(await flushPatch(id))) return;
        requestId = beginActionRequest();
        const r = await dispatch("sizzle:duplicate", { id });
        if (!r.ok) {
          showActionFailure(requestId, "duplicate", id, r.error, () => duplicateProject(id));
          return;
        }
        clearActionFailure(requestId, "duplicate", id);
        if (!mountedRef.current) return;
        setProjects((prev) => [r.value, ...prev.filter((p) => p.id !== r.value.id)]);
        setProjectSaveState(r.value.id, SAVED_STATE);
        selectProject(r.value.id);
        setFocusTitleForId(r.value.id);
      } catch (cause) {
        requestId ??= beginActionRequest();
        showActionFailure(
          requestId,
          "duplicate",
          id,
          unexpectedDispatchError("sizzle_duplicate_failed", cause),
          () => duplicateProject(id)
        );
      } finally {
        duplicatingProjectIds.current.delete(id);
      }
    },
    [
      beginActionRequest,
      clearActionFailure,
      flushPatch,
      selectProject,
      setProjectSaveState,
      showActionFailure
    ]
  );

  const onUpdate = useCallback(
    (id: string, patch: SizzleProjectPatch) => {
      // 0. Record undo history for scene edits (not name/voice patches, and
      //    not while applying an undo/redo). Rapid edits coalesce: only the
      //    pre-burst snapshot is kept.
      if (patch.scenes !== undefined && !applyingHistoryRef.current) {
        const prevScenes = projectsRef.current.find((p) => p.id === id)?.scenes;
        if (prevScenes !== undefined) {
          const now = Date.now();
          const stack = undoStacks.current.get(id) ?? [];
          const lastAt = lastHistoryAtRef.current.get(id) ?? 0;
          if (stack.length === 0 || now - lastAt > HISTORY_COALESCE_MS) {
            stack.push(prevScenes);
            while (stack.length > HISTORY_MAX) stack.shift();
            undoStacks.current.set(id, stack);
          }
          lastHistoryAtRef.current.set(id, now);
          redoStacks.current.set(id, []); // a fresh edit invalidates redo
        }
      }
      // 1. Optimistic local update — text fields reflect immediately,
      //    next keystroke sees the latest value.
      setProjects((prev) =>
        prev.map((p) => (p.id === id ? mergeProjectPatch(p, patch) : p))
      );
      // 2. Coalesce into the pending patch bag (later writes win
      //    per-field; scenes patches replace wholesale).
      const prev = pendingPatches.current.get(id) ?? {};
      pendingPatches.current.set(id, { ...prev, ...patch });
      // 3. Truthful state + debounce. An edit during a write remains
      //    "saving" (the drain will pick it up next); an edit after a
      //    failure remains "error" until the user explicitly retries.
      setSaveStates((states) => {
        const current = states[id] ?? SAVED_STATE;
        if (current.phase === "saving" || current.phase === "error") return states;
        return { ...states, [id]: { phase: "dirty", error: null } };
      });
      const existing = debounceTimers.current.get(id);
      if (existing !== undefined) clearTimeout(existing);
      if (
        pausedProjectIds.current.has(id) ||
        failedProjectIds.current.has(id) ||
        drainPromises.current.has(id)
      ) {
        debounceTimers.current.delete(id);
        return;
      }
      debounceTimers.current.set(
        id,
        setTimeout(() => {
          void flushPatchRef.current(id);
        }, DEBOUNCE_MS)
      );
    },
    []
  );

  const applyHistoryScenes = useCallback(
    (id: string, scenes: SizzleScene[]): void => {
      applyingHistoryRef.current = true;
      onUpdate(id, { scenes });
      applyingHistoryRef.current = false;
    },
    [onUpdate]
  );
  const undoSceneEdit = useCallback((): void => {
    const id = activeId;
    if (id === null) return;
    const stack = undoStacks.current.get(id);
    if (stack === undefined || stack.length === 0) return;
    const prevScenes = stack.pop();
    if (prevScenes === undefined) return;
    const current = projectsRef.current.find((p) => p.id === id)?.scenes;
    if (current !== undefined) {
      const redo = redoStacks.current.get(id) ?? [];
      redo.push(current);
      redoStacks.current.set(id, redo);
    }
    lastHistoryAtRef.current.set(id, 0); // next user edit starts a fresh entry
    applyHistoryScenes(id, prevScenes);
  }, [activeId, applyHistoryScenes]);
  const redoSceneEdit = useCallback((): void => {
    const id = activeId;
    if (id === null) return;
    const stack = redoStacks.current.get(id);
    if (stack === undefined || stack.length === 0) return;
    const nextScenes = stack.pop();
    if (nextScenes === undefined) return;
    const current = projectsRef.current.find((p) => p.id === id)?.scenes;
    if (current !== undefined) {
      const undo = undoStacks.current.get(id) ?? [];
      undo.push(current);
      undoStacks.current.set(id, undo);
    }
    lastHistoryAtRef.current.set(id, 0);
    applyHistoryScenes(id, nextScenes);
  }, [activeId, applyHistoryScenes]);

  // ⌘Z / ⌘⇧Z (⌘Y) for scene-list edits. Text fields keep their own native
  // per-character undo, so we only intercept when focus is NOT in one.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const key = e.key.toLowerCase();
      const isUndo = key === "z" && !e.shiftKey;
      const isRedo = (key === "z" && e.shiftKey) || key === "y";
      if (!isUndo && !isRedo) return;
      const ae = document.activeElement as HTMLElement | null;
      const tag = ae?.tagName;
      if (tag === "TEXTAREA" || tag === "INPUT" || ae?.isContentEditable === true) return;
      e.preventDefault();
      if (isRedo) redoSceneEdit();
      else undoSceneEdit();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undoSceneEdit, redoSceneEdit]);

  // Switching reels is an immediate UI operation, but it is also a save
  // boundary for the reel we just left. The per-project drain lane makes
  // this safe to fire-and-forget: an existing write is reused, never
  // duplicated, and a failed lane remains available through Retry.
  const previousActiveIdRef = useRef<string | null>(activeId);
  useEffect(() => {
    const previousId = previousActiveIdRef.current;
    previousActiveIdRef.current = activeId;
    if (
      previousId !== null &&
      previousId !== activeId &&
      pendingPatches.current.has(previousId) &&
      !failedProjectIds.current.has(previousId)
    ) {
      void flushPatchRef.current(previousId);
    }
  }, [activeId]);

  // Native window close is handled by the main↔renderer barrier above.
  // Unmount itself cannot await IPC because Electron may terminate the
  // renderer immediately, so cleanup only cancels timers.
  useEffect(() => {
    return () => {
      for (const timer of debounceTimers.current.values()) clearTimeout(timer);
      debounceTimers.current.clear();
    };
  }, []);

  // Live-sync external project mutations (e.g. a chat agent's scene
  // edits, or another window). Without this, an external write lands in
  // the store + broadcasts, but the open editor never sees it.
  //
  // Merge, don't replace: authoritative external fields must arrive even
  // while this window has local work, but the exact in-flight + pending
  // fields stay optimistic on top. That keeps a chat-agent scenes update
  // while the user types a title without letting our own write echo clobber
  // the title.
  useEffect(() => {
    return subscribe(EVENT_CHANNELS.sizzleProjectsChanged, (payload) => {
      if (typeof payload !== "object" || payload === null) return;
      const incoming = (payload as { projects?: unknown }).projects;
      if (!Array.isArray(incoming)) return;
      const incomingProjects = incoming as SizzleProject[];
      const incomingIds = new Set(incomingProjects.map((project) => project.id));
      const changedAuthoritativeSceneIds = new Set<string>();
      for (const project of incomingProjects) {
        const previous = authoritativeProjectsRef.current.get(project.id);
        if (
          previous !== undefined &&
          JSON.stringify(previous.scenes) !== JSON.stringify(project.scenes)
        ) {
          changedAuthoritativeSceneIds.add(project.id);
        }
        authoritativeProjectsRef.current.set(project.id, project);
        // A broadcast carries the whole library. Do not count an unrelated
        // reel's mutation as a new revision for this id; only a changed
        // project can supersede this lane's update response.
        if (
          hasLocalWork(project.id) &&
          (previous === undefined || JSON.stringify(previous) !== JSON.stringify(project))
        ) {
          authoritativeRevisionCounterRef.current += 1;
          authoritativeRevisionRef.current.set(
            project.id,
            authoritativeRevisionCounterRef.current
          );
        }
      }
      for (const projectId of authoritativeProjectsRef.current.keys()) {
        if (!incomingIds.has(projectId)) {
          authoritativeProjectsRef.current.delete(projectId);
          authoritativeRevisionRef.current.delete(projectId);
        }
      }
      // An external actor (the chat agent, another window) changed a
      // project's scenes out from under us — our local undo history would
      // clobber that change on ⌘Z. An own-write echo matches the exact local
      // scenes patch and keeps its history; a genuinely different incoming
      // scene list invalidates it even while a local scene write is active.
      for (const inc of incomingProjects) {
        if (!changedAuthoritativeSceneIds.has(inc.id)) continue;
        const localScenes = localWorkPatch(inc.id)?.scenes;
        if (
          localScenes !== undefined &&
          JSON.stringify(localScenes) === JSON.stringify(inc.scenes)
        ) {
          continue;
        }
        const local = projectsRef.current.find((lp) => lp.id === inc.id);
        if (
          local !== undefined &&
          JSON.stringify(local.scenes) !== JSON.stringify(inc.scenes)
        ) {
          undoStacks.current.delete(inc.id);
          redoStacks.current.delete(inc.id);
          lastHistoryAtRef.current.delete(inc.id);
        }
      }
      // A valid live snapshot is also a successful load recovery. Invalidate
      // any older list request so its late reply cannot replace this one.
      loadRequestRef.current += 1;
      setLoading(false);
      setLoadError(null);
      setProjects((prev) => {
        return [
          ...incomingProjects.map((project) =>
            applyLocalPatchToAuthoritative(project, localWorkPatch(project.id))
          ),
          ...prev.filter(
            (project) => !incomingIds.has(project.id) && hasLocalWork(project.id)
          )
        ];
      });
    });
  }, [hasLocalWork, localWorkPatch]);

  // Navigate when the user clicks a Sizzle Reel in the Library while this
  // composer window is already open (a new window instead gets the target
  // via the hash — see readInitialProjectId). Without this the click
  // focuses the window but the reel selection never changes.
  useEffect(() => {
    return subscribe(EVENT_CHANNELS.sizzleNav, (payload) => {
      if (typeof payload !== "object" || payload === null) return;
      const projectId = (payload as { projectId?: unknown }).projectId;
      if (typeof projectId === "string" && projectId.length > 0) {
        selectProject(projectId);
      }
    });
  }, [selectProject]);

  const resumePendingSave = useCallback(
    (id: string): void => {
      if (failedProjectIds.current.has(id)) return;
      if (!pendingPatches.current.has(id)) {
        setProjectSaveState(id, SAVED_STATE);
        return;
      }
      setProjectSaveState(id, { phase: "dirty", error: null });
      clearDebounceTimer(id);
      debounceTimers.current.set(
        id,
        setTimeout(() => {
          void flushPatchRef.current(id);
        }, DEBOUNCE_MS)
      );
    },
    [clearDebounceTimer, setProjectSaveState]
  );

  const deletingProjectIds = useRef<Set<string>>(new Set());
  const onDelete = useCallback(
    async function deleteProject(id: string, askForConfirmation = true): Promise<void> {
      if (askForConfirmation && !window.confirm("Delete this sizzle reel?")) return;
      if (deletingProjectIds.current.has(id)) return;
      deletingProjectIds.current.add(id);
      const requestId = beginActionRequest();
      pausedProjectIds.current.add(id);
      clearDebounceTimer(id);
      // Never let an update validate late and reach the store after delete.
      // We retain queued (not-yet-started) changes in case deletion fails.
      const activeDrain = drainPromises.current.get(id);
      if (activeDrain !== undefined) await activeDrain;
      try {
        const r = await dispatch("sizzle:delete", { id });
        if (!r.ok) {
          pausedProjectIds.current.delete(id);
          resumePendingSave(id);
          showActionFailure(
            requestId,
            "delete",
            id,
            r.error,
            () => deleteProject(id, false)
          );
          return;
        }
        clearActionFailure(requestId, "delete", id);
        if (!mountedRef.current) return;
        const fallbackId = projectsRef.current.find((project) => project.id !== id)?.id ?? null;
        pendingPatches.current.delete(id);
        failedProjectIds.current.delete(id);
        pausedProjectIds.current.delete(id);
        authoritativeProjectsRef.current.delete(id);
        authoritativeRevisionRef.current.delete(id);
        undoStacks.current.delete(id);
        redoStacks.current.delete(id);
        lastHistoryAtRef.current.delete(id);
        setSaveStates((states) => {
          if (states[id] === undefined) return states;
          const next = { ...states };
          delete next[id];
          return next;
        });
        setProjects((prev) => prev.filter((p) => p.id !== id));
        setRecentProjectIds((prev) => prev.filter((recentId) => recentId !== id));
        if (activeIdRef.current === id) {
          setActiveId(fallbackId);
          if (fallbackId !== null) {
            setRecentProjectIds((prev) => admitRecentProject(prev, fallbackId));
          }
        }
      } catch (cause) {
        pausedProjectIds.current.delete(id);
        resumePendingSave(id);
        showActionFailure(
          requestId,
          "delete",
          id,
          unexpectedDispatchError("sizzle_delete_failed", cause),
          () => deleteProject(id, false)
        );
      } finally {
        deletingProjectIds.current.delete(id);
      }
    },
    [
      beginActionRequest,
      clearDebounceTimer,
      clearActionFailure,
      resumePendingSave,
      showActionFailure
    ]
  );

  const onRender = useCallback(async () => {
    if (active === null) return;
    // Critical: drain any pending debounced edits before the render
    // reads the project off disk. Otherwise typed-but-not-yet-saved
    // script lines would be missing — the render would either fail on
    // "empty script" or synthesize stale text.
    if (!(await flushPatch(active.id))) return;
    setStatus({ phase: "tts", message: "Starting…", ratio: 0, error: null });
    const r = await dispatch("sizzle:render", { id: active.id });
    if (!r.ok) {
      setStatus({
        phase: "failed",
        message: r.error.message,
        ratio: 0,
        error: r.error.message
      });
    }
  }, [active, flushPatch]);

  const revealingProjectIds = useRef<Set<string>>(new Set());
  const revealProject = useCallback(
    async function revealProjectById(id: string): Promise<void> {
      if (revealingProjectIds.current.has(id)) return;
      revealingProjectIds.current.add(id);
      const requestId = beginActionRequest();
      try {
        const r = await dispatch("sizzle:revealOutput", { id });
        if (!r.ok) {
          showActionFailure(
            requestId,
            "reveal",
            id,
            r.error,
            () => revealProjectById(id)
          );
          return;
        }
        clearActionFailure(requestId, "reveal", id);
      } catch (cause) {
        showActionFailure(
          requestId,
          "reveal",
          id,
          unexpectedDispatchError("sizzle_reveal_failed", cause),
          () => revealProjectById(id)
        );
      } finally {
        revealingProjectIds.current.delete(id);
      }
    },
    [beginActionRequest, clearActionFailure, showActionFailure]
  );

  const onReveal = useCallback(async (): Promise<void> => {
    if (active === null) return;
    await revealProject(active.id);
  }, [active, revealProject]);

  const onAddScene = useCallback(
    async (captureId: string) => {
      if (active === null) return;
      // Pre-fill the script line from the capture's existing Codex
      // enrichment (accepted description first, then suggested). Every
      // image capture gets a Codex-generated description at capture
      // time — this means new scenes ship with real narratable content
      // out of the box instead of an empty box that synthesizes to
      // a "." click on render.
      let scriptLine = "";
      const enr = await dispatch("codex:enrichment", { captureId });
      if (enr.ok && enr.value !== null) {
        scriptLine =
          enr.value.acceptedDescription ??
          enr.value.suggestedDescription ??
          enr.value.acceptedTitle ??
          enr.value.suggestedTitle ??
          "";
        scriptLine = scriptLine.trim();
      }
      // Seed video scenes with a trim range from the capture's
      // `video.defaultRange` so the editor's trim control opens to
      // sensible bounds instead of [0, 0].
      const captureRecord = captures.find((c) => c.id === captureId) ?? null;
      const captureVideo =
        captureRecord?.kind === "video" ? captureRecord.video ?? null : null;
      const mediaTrim =
        captureVideo !== null
          ? {
              startSec: captureVideo.defaultRange.start,
              endSec: captureVideo.defaultRange.end
            }
          : null;
      // A new scene is a sequence scene from the start — one voiceover
      // over N clips (this capture is clip 1; "+ Clip" adds more). The
      // legacy one-capture "simple" scene is no longer created by the UI.
      const scene: SizzleScene = newSizzleSequenceScene([captureId], {
        narration: scriptLine
      });
      if (mediaTrim !== null && scene.beats !== undefined && scene.beats[0] !== undefined) {
        scene.beats = [{ ...scene.beats[0], mediaTrim }, ...scene.beats.slice(1)];
      }
      onUpdate(active.id, { scenes: [...active.scenes, scene] });
    },
    [active, captures, onUpdate]
  );

  const onAddSequenceBeat = useCallback(
    async (sceneId: string, captureId: string) => {
      if (active === null) return;
      const captureRecord = captures.find((c) => c.id === captureId) ?? null;
      const captureVideo =
        captureRecord?.kind === "video" ? captureRecord.video ?? null : null;
      const mediaTrim =
        captureVideo !== null
          ? {
              startSec: captureVideo.defaultRange.start,
              endSec: captureVideo.defaultRange.end
            }
          : null;
      const nextScenes = active.scenes.map((scene) => {
        if (scene.id !== sceneId || scene.kind !== "sequence") return scene;
        const beats = scene.beats ?? [];
        // New beats default to `auto` — they slot in evenly between the
        // anchored beats and need no manual timing (R4).
        const beat: SizzleSequenceBeat = {
          id: `bt_${Date.now().toString(36)}`,
          captureId,
          timing: { kind: "auto" },
          mediaTrim,
          transition: "cut",
          videoFit: "smart-fit"
        };
        return { ...scene, beats: normalizeSizzleSequenceBeatContinuity([...beats, beat]) };
      });
      onUpdate(active.id, { scenes: nextScenes });
    },
    [active, captures, onUpdate]
  );

  const saveState = activeId === null ? SAVED_STATE : (saveStates[activeId] ?? SAVED_STATE);

  return {
    projects,
    active,
    activeId,
    loading,
    loadError,
    retryLoad: reloadProjects,
    captures,
    status,
    saveState,
    saveStates,
    retrySave,
    actionFailure,
    retryAction,
    dismissActionFailure,
    projectRail,
    focusTitleForId,
    setFocusTitleForId,
    selectProject,
    onCreate,
    onDuplicate,
    onDelete,
    onRender,
    onReveal,
    onUpdate,
    flushPatch,
    onAddScene,
    onAddSequenceBeat
  };
}
