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

export function admitRecentProject(prev: string[], id: string): string[] {
  if (prev.includes(id)) return prev;
  return [id, ...prev].slice(0, RECENT_PROJECT_LIMIT);
}

export type SizzleProjectState = {
  projects: SizzleProject[];
  active: SizzleProject | null;
  activeId: string | null;
  loading: boolean;
  captures: CaptureRecord[];
  status: RenderStatus;
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
  flushPatch: (id: string) => Promise<void>;
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
  const [focusTitleForId, setFocusTitleForId] = useState<string | null>(null);
  const [recentProjectIds, setRecentProjectIds] = useState<string[]>(() => {
    const initial = readInitialProjectId();
    return initial === null ? [] : [initial];
  });

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

  const reloadProjects = useCallback(async () => {
    const r = await dispatch("sizzle:list", {});
    if (r.ok) {
      setProjects(r.value.projects);
      setLoading(false);
      if (activeId === null && r.value.projects.length > 0) {
        selectProject(r.value.projects[0]!.id);
      }
    }
  }, [activeId, selectProject]);

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

  const onCreate = useCallback(async () => {
    // Electron deliberately doesn't implement window.prompt — it
    // silently returns null. Skip the dialog: create with a default
    // name and auto-focus the editor's title input so the user can
    // rename in one keystroke.
    const r = await dispatch("sizzle:create", { name: "Untitled Sizzle" });
    if (r.ok) {
      setProjects((prev) => [r.value, ...prev]);
      selectProject(r.value.id);
      setFocusTitleForId(r.value.id);
    }
  }, [selectProject]);

  const pendingPatches = useRef<Map<string, SizzleProjectPatch>>(new Map());
  const debounceTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map()
  );

  // ── Undo / redo (per active project) ────────────────────────────────
  // Every local scene mutation funnels through onUpdate({ scenes }); we
  // snapshot the PRE-edit scenes so ⌘Z can restore them. Keyed by project
  // id, so each reel keeps its own history for the session. External chat
  // broadcasts arrive OUTSIDE onUpdate and are intentionally not recorded.
  // Rapid edits (typing) coalesce into one entry within the debounce
  // window. `applyingHistoryRef` suppresses recording while an undo/redo
  // is being applied (so it doesn't re-record or clear the redo stack).
  const projectsRef = useRef<SizzleProject[]>(projects);
  projectsRef.current = projects;
  const undoStacks = useRef<Map<string, SizzleScene[][]>>(new Map());
  const redoStacks = useRef<Map<string, SizzleScene[][]>>(new Map());
  const lastHistoryAtRef = useRef<Map<string, number>>(new Map());
  const applyingHistoryRef = useRef(false);

  const flushPatch = useCallback(async (id: string): Promise<void> => {
    const pending = pendingPatches.current.get(id);
    pendingPatches.current.delete(id);
    const timer = debounceTimers.current.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      debounceTimers.current.delete(id);
    }
    if (pending === undefined) return;
    const r = await dispatch("sizzle:update", { id, patch: pending });
    if (!r.ok) {
      // Surface persistence failures so the user knows their edit
      // didn't land. Local state already reflects the optimistic
      // value, but disk is out of sync.
      // eslint-disable-next-line no-console
      console.warn("[sizzle] update failed", r.error);
      return;
    }
    // After a successful flush, reconcile the server's modifiedAt back
    // into local state — but ONLY if there's no further pending patch
    // for this id (otherwise we'd overwrite text the user typed during
    // the flush). The scenes field is intentionally NOT echoed back:
    // local state is the source of truth for in-flight edits.
    if (pendingPatches.current.has(id)) return;
    setProjects((prev) =>
      prev.map((p) =>
        p.id === id ? { ...p, modifiedAt: r.value.modifiedAt } : p
      )
    );
  }, []);

  const onDuplicate = useCallback(
    async (id: string) => {
      await flushPatch(id);
      const r = await dispatch("sizzle:duplicate", { id });
      if (r.ok) {
        setProjects((prev) => [r.value, ...prev.filter((p) => p.id !== r.value.id)]);
        selectProject(r.value.id);
        setFocusTitleForId(r.value.id);
      }
    },
    [flushPatch, selectProject]
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
      // 3. Reset the debounce timer.
      const existing = debounceTimers.current.get(id);
      if (existing !== undefined) clearTimeout(existing);
      debounceTimers.current.set(
        id,
        setTimeout(() => {
          void flushPatch(id);
        }, DEBOUNCE_MS)
      );
    },
    [flushPatch]
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

  // Flush any pending edits on unmount so the on-disk state catches up
  // when the window closes mid-debounce.
  useEffect(() => {
    return () => {
      for (const id of pendingPatches.current.keys()) {
        void flushPatch(id);
      }
    };
  }, [flushPatch]);

  // Live-sync external project mutations (e.g. a chat agent's scene
  // edits, or another window). Without this, an external write lands in
  // the store + broadcasts, but the open editor never sees it.
  //
  // Merge, don't replace: any project with a pending DEBOUNCED local
  // patch is kept as-is so a broadcast (including the echo of our OWN
  // write, which round-trips ~350ms after the last keystroke) can't
  // clobber text the user is still typing. Projects with no in-flight
  // edit take the authoritative broadcast value.
  useEffect(() => {
    return subscribe(EVENT_CHANNELS.sizzleProjectsChanged, (payload) => {
      if (typeof payload !== "object" || payload === null) return;
      const incoming = (payload as { projects?: unknown }).projects;
      if (!Array.isArray(incoming)) return;
      const incomingProjects = incoming as SizzleProject[];
      // An external actor (the chat agent, another window) changed a
      // project's scenes out from under us — our local undo history would
      // clobber that change on ⌘Z, so drop it. Skip projects with a
      // pending local patch (we keep our copy) and the echo of our own
      // writes (scenes unchanged → not cleared).
      for (const inc of incomingProjects) {
        if (pendingPatches.current.has(inc.id)) continue;
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
      setProjects((prev) =>
        incomingProjects.map((p) =>
          pendingPatches.current.has(p.id)
            ? (prev.find((lp) => lp.id === p.id) ?? p)
            : p
        )
      );
    });
  }, []);

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

  const onDelete = useCallback(
    async (id: string) => {
      if (!window.confirm("Delete this sizzle reel?")) return;
      const r = await dispatch("sizzle:delete", { id });
      if (r.ok) {
        const fallbackId = projects.find((p) => p.id !== id)?.id ?? null;
        setProjects((prev) => prev.filter((p) => p.id !== id));
        setRecentProjectIds((prev) => prev.filter((recentId) => recentId !== id));
        if (activeId === id) {
          setActiveId(fallbackId);
          if (fallbackId !== null) {
            setRecentProjectIds((prev) => admitRecentProject(prev, fallbackId));
          }
        }
      }
    },
    [activeId, projects]
  );

  const onRender = useCallback(async () => {
    if (active === null) return;
    // Critical: drain any pending debounced edits before the render
    // reads the project off disk. Otherwise typed-but-not-yet-saved
    // script lines would be missing — the render would either fail on
    // "empty script" or synthesize stale text.
    await flushPatch(active.id);
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

  const onReveal = useCallback(async () => {
    if (active === null) return;
    await dispatch("sizzle:revealOutput", { id: active.id });
  }, [active]);

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

  return {
    projects,
    active,
    activeId,
    loading,
    captures,
    status,
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
