import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import {
  EVENT_CHANNELS,
  SIZZLE_VOICES,
  normalizeSizzleSequenceBeatContinuity,
  resolveSizzleAudioSource,
  type CaptureRecord,
  type SizzleBeatTiming,
  type SizzleProject,
  type SizzleRenderProgressEvent,
  type SizzleScene,
  type SizzleSequenceBeat,
  type SizzleTransition,
  type SizzleTransitionType,
  type SizzleVideoFitPolicy,
  type SizzleVoice
} from "@pwrsnap/shared";
import { cacheUrl, captureSrcUrl, dispatch, subscribe } from "../../lib/pwrsnap";
import { PwrSnapMark, PwrSnapWordmark } from "../shared/BrandMark";
import { SizzleChatPanel } from "./SizzleChatPanel";
import "./sizzle.css";

type RenderStatus = {
  phase: SizzleRenderProgressEvent["phase"] | "idle";
  message: string;
  ratio: number;
  error: string | null;
};

type PickerTarget =
  | { kind: "scene" }
  | { kind: "sequenceBeat"; sceneId: string };

const IDLE_STATUS: RenderStatus = {
  phase: "idle",
  message: "",
  ratio: 0,
  error: null
};

const RECENT_PROJECT_LIMIT = 5;
const PROJECT_LIST_LIMIT = 100;

/**
 * Apply a debounced edit's patch to the local project state. Used to
 * keep the renderer's view of the project in sync with what the user
 * just typed/picked, before the dispatched write hits disk.
 *
 * `scenes` is replaced wholesale (the patch carries the full array
 * because in-place scene mutation is wrong — the parent passes a new
 * array on every edit). Every other field is a shallow assign.
 */
/**
 * `M:SS` for durations ≥ 1 minute, else `NNs`. Mirrors
 * `formatDurationLabel` in Library.tsx (not exported there); kept
 * inline so the sizzle feature doesn't reach across feature
 * boundaries for a 6-line helper.
 */
function formatDur(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0s";
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  if (mins === 0) return `${secs}s`;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

function transitionType(transition: SizzleTransition): SizzleTransitionType {
  return typeof transition === "string" ? transition : transition.type;
}

function transitionFromType(type: SizzleTransitionType): SizzleTransition {
  if (type === "cut" || type === "crossfade") return type;
  return { type, durationSec: type === "none" ? 0 : 0.18 };
}

function formatProjectDate(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "Unknown date";
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric"
  });
}

function isDifferentProjectDate(a: string, b: string): boolean {
  const left = new Date(a);
  const right = new Date(b);
  if (!Number.isFinite(left.getTime()) || !Number.isFinite(right.getTime())) {
    return a !== b;
  }
  return Math.abs(right.getTime() - left.getTime()) > 1000;
}

function admitRecentProject(prev: string[], id: string): string[] {
  if (prev.includes(id)) return prev;
  return [id, ...prev].slice(0, RECENT_PROJECT_LIMIT);
}

function mergeProjectPatch(
  p: SizzleProject,
  patch: Partial<Omit<SizzleProject, "id" | "createdAt">>
): SizzleProject {
  return {
    ...p,
    ...patch,
    scenes: patch.scenes ?? p.scenes,
    modifiedAt: new Date().toISOString()
  };
}

/** The project a freshly-opened composer window should focus, passed by
 *  `sizzle:open` via the URL hash (`#stage=sizzle&projectId=…`). Null when
 *  opened without a target. */
function readInitialProjectId(): string | null {
  const hash = window.location.hash.replace(/^#/, "");
  return new URLSearchParams(hash).get("projectId");
}

export function SizzleApp(): ReactElement {
  const [projects, setProjects] = useState<SizzleProject[]>([]);
  // Seed from the hash so a window opened to a specific reel lands on it,
  // not on projects[0]. reloadProjects only defaults to projects[0] when
  // activeId is still null, so this never gets clobbered.
  const [activeId, setActiveId] = useState<string | null>(() => readInitialProjectId());
  const [captures, setCaptures] = useState<CaptureRecord[]>([]);
  const [picker, setPicker] = useState<PickerTarget | null>(null);
  const [status, setStatus] = useState<RenderStatus>(IDLE_STATUS);
  const [loading, setLoading] = useState(true);
  const [focusTitleForId, setFocusTitleForId] = useState<string | null>(null);
  const [recentProjectIds, setRecentProjectIds] = useState<string[]>(() => {
    const initial = readInitialProjectId();
    return initial === null ? [] : [initial];
  });
  // Chat lives in a right sidebar alongside the editor (not a full-pane
  // swap) so the scene list stays visible + updates live as the agent
  // edits. Shown by default — chat is the primary way to compose a reel.
  const [showChat, setShowChat] = useState(true);

  const active = useMemo(
    () => projects.find((p) => p.id === activeId) ?? null,
    [projects, activeId]
  );

  const projectRail = useMemo(() => {
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
  }, [activeId, projects, recentProjectIds]);

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

  // Per-project debounce timers + pending-patch coalescing. Multiple
  // edits to the same project within DEBOUNCE_MS get merged into one
  // disk write. Critical for fast-typed text fields — the previous
  // dispatch-per-keystroke pattern raced: each in-flight dispatch
  // carried a snapshot built from STALE local state (since setProjects
  // only ran after the dispatch returned), so only the last typed
  // character survived a sustained burst of typing.
  const DEBOUNCE_MS = 350;
  const pendingPatches = useRef<
    Map<string, Partial<Omit<SizzleProject, "id" | "createdAt">>>
  >(new Map());
  const debounceTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map()
  );

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

  const onUpdate = useCallback(
    (id: string, patch: Partial<Omit<SizzleProject, "id" | "createdAt">>) => {
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
      const scene: SizzleScene = {
        id: `sc_${Date.now().toString(36)}`,
        captureId,
        scriptLine,
        durationOverrideSec: null,
        mediaTrim,
        audioSource: "auto",
        transition: "crossfade"
      };
      await onUpdate(active.id, { scenes: [...active.scenes, scene] });
      setPicker(null);
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
        const last = beats.at(-1);
        const startSec =
          last?.timing.kind === "offset" && last.timing.endSec !== null
            ? last.timing.endSec
            : beats.length;
        const beat: SizzleSequenceBeat = {
          id: `bt_${Date.now().toString(36)}`,
          captureId,
          timing: { kind: "offset", startSec, endSec: null },
          mediaTrim,
          transition: "cut",
          videoFit: "smart-fit"
        };
        return { ...scene, beats: normalizeSizzleSequenceBeatContinuity([...beats, beat]) };
      });
      await onUpdate(active.id, { scenes: nextScenes });
      setPicker(null);
    },
    [active, captures, onUpdate]
  );

  return (
    <div className="szl">
      <header className="szl__titlebar">
        <div className="szl__title-brand">
          <span className="szl__title-mark">
            <PwrSnapMark size={18} />
          </span>
          <PwrSnapWordmark />
        </div>
        <span className="szl__title-crumb">
          Sizzle Reels
          {active !== null ? (
            <>
              <span className="szl__title-sep">›</span>
              <span className="szl__title-here">{active.name}</span>
            </>
          ) : null}
        </span>
        {active !== null ? (
          <>
            <span className="szl__spacer" />
            <button
              type="button"
              className={"szl__chat-toggle" + (showChat ? " is-active" : "")}
              aria-pressed={showChat}
              onClick={() => setShowChat((v) => !v)}
              title={showChat ? "Hide agent chat" : "Show agent chat"}
            >
              {showChat ? "Hide chat" : "Chat with agent"}
            </button>
          </>
        ) : null}
      </header>
      <aside className="szl__rail">
        <button className="szl__new" onClick={onCreate} type="button">
          + New Sizzle Reel
        </button>
        <section className="szl__section" aria-label="Recent projects">
          <div className="szl__section-head">
            <span>Recents</span>
          </div>
          <ul className="szl__list szl__list--recents" data-testid="sizzle-recents-list">
            {loading ? (
              <li className="szl__empty">Loading...</li>
            ) : projectRail.recents.length === 0 ? (
              <li className="szl__empty">No recent projects.</li>
            ) : (
              projectRail.recents.map((p) => (
                <ProjectRow
                  key={p.id}
                  project={p}
                  active={activeId === p.id}
                  onSelect={() => selectProject(p.id)}
                />
              ))
            )}
          </ul>
        </section>
        <section className="szl__section szl__section--projects" aria-label="Projects">
          <div className="szl__section-head">
            <span>Projects</span>
            {projectRail.totalProjectCount > projectRail.recents.length ? (
              <span className="szl__section-count">
                {projectRail.list.length} of{" "}
                {projectRail.totalProjectCount - projectRail.recents.length}
              </span>
            ) : null}
          </div>
          <ul className="szl__list szl__list--projects" data-testid="sizzle-projects-list">
            {loading ? null : projects.length === 0 ? (
              <li className="szl__empty">No projects yet. Create one above.</li>
            ) : projectRail.list.length === 0 ? (
              <li className="szl__empty">All visible projects are in Recents.</li>
            ) : (
              projectRail.list.map((p) => (
                <ProjectRow
                  key={p.id}
                  project={p}
                  active={activeId === p.id}
                  onSelect={() => selectProject(p.id)}
                />
              ))
            )}
          </ul>
        </section>
      </aside>

      <main className="szl__main">
        {active === null ? (
          <EmptyState />
        ) : (
          <div className="szl__workspace">
            <Editor
              project={active}
              captures={captures}
              autoFocusTitle={focusTitleForId === active.id}
              onTitleFocused={() => setFocusTitleForId(null)}
              onRename={(name) => onUpdate(active.id, { name })}
              onVoice={(voice) => onUpdate(active.id, { voice })}
              onProvider={(ttsProvider) => onUpdate(active.id, { ttsProvider })}
              onResolution={(resolution) =>
                onUpdate(active.id, { resolution })
              }
              onScenes={(scenes) => onUpdate(active.id, { scenes })}
              onFlushPending={() => flushPatch(active.id)}
              onPickCapture={() => setPicker({ kind: "scene" })}
              onPickSequenceBeat={(sceneId) => setPicker({ kind: "sequenceBeat", sceneId })}
              onRender={onRender}
              onReveal={onReveal}
              onDelete={() => onDelete(active.id)}
              status={status}
            />
            {showChat ? (
              <aside className="szl__chat">
                <SizzleChatPanel key={active.id} projectId={active.id} />
              </aside>
            ) : null}
          </div>
        )}
      </main>

      {picker !== null && active !== null ? (
        <CapturePicker
          captures={captures}
          onPick={(captureId) =>
            picker.kind === "scene"
              ? void onAddScene(captureId)
              : void onAddSequenceBeat(picker.sceneId, captureId)
          }
          onClose={() => setPicker(null)}
          existing={
            new Set(
              picker.kind === "scene"
                ? active.scenes.map((s) => s.captureId)
                : active.scenes
                    .find((s) => s.id === picker.sceneId)
                    ?.beats?.map((beat) => beat.captureId) ?? []
            )
          }
        />
      ) : null}
    </div>
  );
}

function ProjectRow({
  project,
  active,
  onSelect
}: {
  project: SizzleProject;
  active: boolean;
  onSelect: () => void;
}): ReactElement {
  const clipLabel = `${project.scenes.length} clip${project.scenes.length === 1 ? "" : "s"}`;
  const updatedLabel = isDifferentProjectDate(project.createdAt, project.modifiedAt)
    ? `Updated ${formatProjectDate(project.modifiedAt)}`
    : null;
  return (
    <li>
      <button
        className={"szl__row" + (active ? " is-active" : "")}
        onClick={onSelect}
        type="button"
      >
        <span className="szl__row-name">{project.name}</span>
        <span className="szl__row-meta">
          Created {formatProjectDate(project.createdAt)} · {clipLabel}
        </span>
        {updatedLabel !== null ? (
          <span className="szl__row-meta szl__row-meta--sub">{updatedLabel}</span>
        ) : null}
      </button>
    </li>
  );
}

function EmptyState(): ReactElement {
  return (
    <div className="szl__empty-pane">
      <div className="szl__empty-mark">▶</div>
      <h2>Sizzle Reels</h2>
      <p>
        Pick a project on the left or create a new one to start composing a
        narrated reel from your captures.
      </p>
      <p className="szl__hint">
        Tip: Add your OpenAI API key in Settings → AI Providers to enable text-to-speech voiceover.
      </p>
    </div>
  );
}

type EditorProps = {
  project: SizzleProject;
  captures: CaptureRecord[];
  status: RenderStatus;
  autoFocusTitle: boolean;
  onTitleFocused: () => void;
  onRename: (name: string) => void;
  onVoice: (voice: SizzleVoice) => void;
  onProvider: (provider: "openai" | "xai") => void;
  onResolution: (resolution: "1080p" | "720p") => void;
  onScenes: (scenes: SizzleScene[]) => void;
  onFlushPending: () => Promise<void>;
  onPickCapture: () => void;
  onPickSequenceBeat: (sceneId: string) => void;
  onRender: () => void;
  onReveal: () => void;
  onDelete: () => void;
};

function Editor(props: EditorProps): ReactElement {
  const {
    project,
    captures,
    status,
    autoFocusTitle,
    onTitleFocused,
    onRename,
    onVoice,
    onProvider,
    onResolution,
    onScenes,
    onFlushPending,
    onPickCapture,
    onPickSequenceBeat,
    onRender,
    onReveal,
    onDelete
  } = props;

  const titleRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (!autoFocusTitle) return;
    const el = titleRef.current;
    if (el === null) return;
    el.focus();
    el.select();
    onTitleFocused();
  }, [autoFocusTitle, onTitleFocused]);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  // Cache of (sceneId → measured voiceover audio duration in seconds)
  // populated as the user clicks ▶ to preview each scene. Used to
  // surface a "voiceover is longer than trim — last frame will hold"
  // hint on video scenes so the user understands the render math
  // before hitting Render.
  const [previewDurations, setPreviewDurations] = useState<
    Record<string, number>
  >({});
  // Hold the currently-mounted object URL so we can revoke it before
  // assigning a new src. A data: URL would leak ~33% memory per
  // preview AND keep the prior buffer pinned in memory; object URLs
  // can be revoked deterministically. Without revoke, repeated
  // previews would steadily grow the renderer's heap.
  const audioObjectUrlRef = useRef<string | null>(null);
  const revokeAudioObjectUrl = (): void => {
    const url = audioObjectUrlRef.current;
    if (url !== null) {
      URL.revokeObjectURL(url);
      audioObjectUrlRef.current = null;
    }
  };
  useEffect(() => {
    return () => revokeAudioObjectUrl();
  }, []);
  const [previewingSceneId, setPreviewingSceneId] = useState<string | null>(null);
  const [previewLoadingSceneId, setPreviewLoadingSceneId] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  // Per-scene preview-request generation counter. Each click of ▶
  // bumps it; the response only applies if it's still current.
  // Editing a scene's script also bumps it so an in-flight response
  // for the OLD text can't auto-play after the user moved on.
  //
  // Key safety properties:
  //   • Only one preview play-back per scene can be "current" at a
  //     time. Older in-flight responses are silently discarded.
  //   • TTS audio files are content-addressed (sha256 of provider +
  //     model + voice + text), so a late-arriving response for the
  //     OLD text writes to its OWN file. It can never overwrite the
  //     cache file for the NEW text. The discard prevents stale
  //     PLAYBACK; the file system layout prevents stale OVERWRITES.
  const previewGenerationRef = useRef<Map<string, number>>(new Map());
  const bumpPreviewGeneration = (sceneId: string): number => {
    const next = (previewGenerationRef.current.get(sceneId) ?? 0) + 1;
    previewGenerationRef.current.set(sceneId, next);
    return next;
  };
  const isPreviewCurrent = (sceneId: string, gen: number): boolean => {
    return previewGenerationRef.current.get(sceneId) === gen;
  };

  const onPreviewScene = async (sceneId: string): Promise<void> => {
    // Toggle: if this scene is already playing, stop it. Bump the
    // generation so any in-flight load gets discarded.
    if (previewingSceneId === sceneId && audioRef.current !== null) {
      audioRef.current.pause();
      bumpPreviewGeneration(sceneId);
      setPreviewingSceneId(null);
      setPreviewLoadingSceneId(null);
      return;
    }
    const gen = bumpPreviewGeneration(sceneId);
    setPreviewError(null);
    setPreviewLoadingSceneId(sceneId);
    // Flush pending text edits so the preview synthesizes what's on
    // screen, not what was last flushed to disk.
    await onFlushPending();
    if (!isPreviewCurrent(sceneId, gen)) return;
    const result = await dispatch("sizzle:previewSceneAudio", {
      projectId: project.id,
      sceneId
    });
    if (!isPreviewCurrent(sceneId, gen)) return;
    setPreviewLoadingSceneId(null);
    if (!result.ok) {
      setPreviewError(result.error.message);
      return;
    }
    // Cache the measured audio duration so the editor can surface
    // an inline "voiceover is X.Xs vs Y.Ys trim" hint on the video
    // scene's row without forcing the user to render to find out.
    setPreviewDurations((prev) => ({
      ...prev,
      [sceneId]: result.value.durationSec
    }));
    const el = audioRef.current;
    if (el === null) return;
    // Decode the base64 into a Blob, hand the audio element an
    // object URL, and revoke the previous one. This keeps a single
    // buffer alive at a time instead of accumulating data URLs.
    const binary = atob(result.value.audioBase64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const blob = new Blob([bytes], { type: result.value.mimeType });
    revokeAudioObjectUrl();
    const objectUrl = URL.createObjectURL(blob);
    audioObjectUrlRef.current = objectUrl;
    el.src = objectUrl;
    setPreviewingSceneId(sceneId);
    try {
      await el.play();
    } catch (cause) {
      setPreviewError(cause instanceof Error ? cause.message : String(cause));
      setPreviewingSceneId(null);
    }
  };

  // Watch the local copy of every scene's scriptLine. When any of
  // them changes, bump that scene's preview generation so a still-
  // in-flight response for the old text gets discarded instead of
  // playing audio that doesn't match the textbox.
  const lastScriptByScene = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    for (const scene of project.scenes) {
      const prev = lastScriptByScene.current.get(scene.id);
      if (prev !== undefined && prev !== scene.scriptLine) {
        bumpPreviewGeneration(scene.id);
        // If this scene was actively playing stale audio, stop it.
        if (previewingSceneId === scene.id && audioRef.current !== null) {
          audioRef.current.pause();
          setPreviewingSceneId(null);
        }
      }
      lastScriptByScene.current.set(scene.id, scene.scriptLine);
    }
  }, [project.scenes, previewingSceneId]);

  const captureMap = useMemo(() => {
    const m = new Map<string, CaptureRecord>();
    for (const c of captures) m.set(c.id, c);
    return m;
  }, [captures]);

  const removeScene = (id: string): void => {
    onScenes(project.scenes.filter((s) => s.id !== id));
  };

  const moveScene = (idx: number, delta: number): void => {
    const next = [...project.scenes];
    const target = idx + delta;
    if (target < 0 || target >= next.length) return;
    [next[idx], next[target]] = [next[target]!, next[idx]!];
    onScenes(next);
  };

  const editScene = (id: string, patch: Partial<SizzleScene>): void => {
    onScenes(
      project.scenes.map((s) => (s.id === id ? { ...s, ...patch } : s))
    );
  };

  const editSequenceBeat = (
    sceneId: string,
    beatId: string,
    patch: Partial<SizzleSequenceBeat>
  ): void => {
    onScenes(
      project.scenes.map((s) => {
        if (s.id !== sceneId || s.kind !== "sequence" || s.beats === undefined) return s;
        return {
          ...s,
          beats: normalizeSizzleSequenceBeatContinuity(s.beats.map((beat) =>
            beat.id === beatId ? { ...beat, ...patch } : beat
          ))
        };
      })
    );
  };

  const nextBeatStartSec = (beats: SizzleSequenceBeat[]): number => {
    const last = beats.at(-1);
    if (last?.timing.kind === "offset" && last.timing.endSec !== null) {
      return last.timing.endSec;
    }
    return beats.length;
  };

  const beatFromScene = (scene: SizzleScene, startSec: number): SizzleSequenceBeat => ({
    id: `bt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    captureId: scene.captureId,
    timing: { kind: "offset", startSec, endSec: null },
    mediaTrim: scene.mediaTrim,
    transition: "cut",
    videoFit: "smart-fit"
  });

  const convertToSequence = (sceneId: string): void => {
    onScenes(
      project.scenes.map((scene) => {
        if (scene.id !== sceneId || scene.kind === "sequence") return scene;
        return {
          ...scene,
          kind: "sequence",
          narration: scene.scriptLine,
          scriptLine: scene.scriptLine,
          audioSource: "voiceover",
          beats: normalizeSizzleSequenceBeatContinuity([beatFromScene(scene, 0)])
        };
      })
    );
  };

  const appendNextSceneAsBeat = (sceneId: string): void => {
    const idx = project.scenes.findIndex((scene) => scene.id === sceneId);
    const scene = project.scenes[idx];
    const nextScene = project.scenes[idx + 1];
    if (idx < 0 || scene?.kind !== "sequence" || nextScene === undefined || nextScene.kind === "sequence") return;
    const beats = scene.beats ?? [];
    const beat = beatFromScene(nextScene, nextBeatStartSec(beats));
    const narration = [scene.narration ?? scene.scriptLine, nextScene.scriptLine]
      .map((s) => s.trim())
      .filter(Boolean)
      .join(" ");
    const next = [...project.scenes];
    next[idx] = {
      ...scene,
      scriptLine: narration,
      narration,
      beats: normalizeSizzleSequenceBeatContinuity([...beats, beat])
    };
    next.splice(idx + 1, 1);
    onScenes(next);
  };

  const moveSequenceBeat = (sceneId: string, beatIdx: number, delta: number): void => {
    onScenes(
      project.scenes.map((scene) => {
        if (scene.id !== sceneId || scene.kind !== "sequence" || scene.beats === undefined) return scene;
        const target = beatIdx + delta;
        if (target < 0 || target >= scene.beats.length) return scene;
        const beats = [...scene.beats];
        [beats[beatIdx], beats[target]] = [beats[target]!, beats[beatIdx]!];
        return { ...scene, beats: normalizeSizzleSequenceBeatContinuity(beats) };
      })
    );
  };

  const removeSequenceBeat = (sceneId: string, beatId: string): void => {
    onScenes(
      project.scenes.map((scene) => {
        if (scene.id !== sceneId || scene.kind !== "sequence" || scene.beats === undefined) return scene;
        if (scene.beats.length <= 1) return scene;
        return {
          ...scene,
          beats: normalizeSizzleSequenceBeatContinuity(
            scene.beats.filter((beat) => beat.id !== beatId)
          )
        };
      })
    );
  };

  const totalScenes = project.scenes.length;
  const rendering =
    status.phase !== "idle" &&
    status.phase !== "done" &&
    status.phase !== "failed";

  return (
    <div className="szl__editor">
      <header className="szl__editor-head">
        <input
          ref={titleRef}
          className="szl__editor-title"
          value={project.name}
          onChange={(e) => onRename(e.target.value)}
        />
        <div className="szl__editor-meta">
          {totalScenes} scene{totalScenes === 1 ? "" : "s"}
          {project.lastRenderedAt
            ? ` · rendered ${new Date(project.lastRenderedAt).toLocaleString()}`
            : ""}
        </div>
        <span className="szl__spacer" />
        <button className="szl__btn-danger" onClick={onDelete} type="button">
          Delete
        </button>
      </header>

      <div className="szl__controls">
        <label className="szl__field">
          <span>Voice</span>
          <select
            value={project.voice}
            onChange={(e) => onVoice(e.target.value as SizzleVoice)}
          >
            {SIZZLE_VOICES.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label className="szl__field">
          <span>Provider</span>
          <select
            value={project.ttsProvider}
            onChange={(e) => onProvider(e.target.value as "openai" | "xai")}
          >
            <option value="openai">OpenAI</option>
            <option value="xai">xAI (coming soon)</option>
          </select>
        </label>
        <label className="szl__field">
          <span>Resolution</span>
          <select
            value={project.resolution}
            onChange={(e) =>
              onResolution(e.target.value as "1080p" | "720p")
            }
          >
            <option value="1080p">1920 × 1080</option>
            <option value="720p">1280 × 720</option>
          </select>
        </label>
        <span className="szl__spacer" />
        <button className="szl__btn" onClick={onPickCapture} type="button">
          + Add scene
        </button>
      </div>

      <ul className="szl__scenes">
        {project.scenes.length === 0 ? (
          <li className="szl__scene-empty">
            No scenes yet. Click <strong>Add scene</strong> to pick captures
            from your Library.
          </li>
        ) : (
          project.scenes.flatMap((scene, idx) => {
            const capture = captureMap.get(scene.captureId) ?? null;
            const isVideo = capture?.kind === "video";
            const thumb =
              capture?.edits_version !== undefined
                ? cacheUrl(scene.captureId, 320, "webp", capture.edits_version)
                : cacheUrl(scene.captureId, 320, "webp");
            // Compute the effective audio source for UI gating via
            // the SAME `resolveSizzleAudioSource` the main-process
            // render handler uses. Default to image-kind for the
            // (transient) case where the capture record isn't loaded
            // yet — that's the most permissive direction (image
            // scenes fall through to "voiceover" without needing a
            // video stream, so the preview button stays clickable).
            const effectiveAudio = resolveSizzleAudioSource(
              scene.audioSource,
              capture?.kind ?? "image",
              scene.scriptLine
            );
            const previewDisabled =
              previewLoadingSceneId === scene.id ||
              effectiveAudio === "muted" ||
              (effectiveAudio === "voiceover" && scene.scriptLine.trim().length === 0);
            const previewTitle = previewDisabled
              ? effectiveAudio === "muted"
                ? "This scene is muted"
                : "Write a script line to preview"
              : previewingSceneId === scene.id
                ? "Stop preview"
                : effectiveAudio === "native"
                  ? "Preview native video audio"
                  : "Preview voiceover";

            const elements: ReactElement[] = [];

            // Transition chip between scenes (skip before the first).
            if (idx > 0) {
              elements.push(
                <li
                  key={`tr-${scene.id}`}
                  className={
                    "szl__transition" +
                    (transitionType(scene.transition) === "crossfade"
                      ? " szl__transition--crossfade"
                      : " szl__transition--cut")
                  }
                >
                  <button
                    type="button"
                    className="szl__transition-chip"
                    onClick={() =>
                      editScene(scene.id, {
                        transition:
                          transitionType(scene.transition) === "crossfade" ? "cut" : "crossfade"
                      })
                    }
                    title="Toggle between Cut and Crossfade"
                  >
                    {transitionType(scene.transition) === "crossfade" ? "⌒ Crossfade ⌒" : "─ Cut ─"}
                  </button>
                </li>
              );
            }

            elements.push(
              <li key={scene.id} className="szl__scene">
                <span className="szl__scene-num">{idx + 1}</span>
                <div className="szl__scene-thumb">
                  {capture ? (
                    <>
                      {isVideo ? (
                        <video
                          src={captureSrcUrl(scene.captureId)}
                          preload="metadata"
                          muted
                          playsInline
                        />
                      ) : (
                        <img src={thumb} alt="" />
                      )}
                      {isVideo ? (
                        <>
                          <span className="szl__scene-thumb-play" aria-hidden="true">▶</span>
                          <span className="szl__scene-thumb-duration">
                            {formatDur(capture.video?.durationSec ?? 0)}
                          </span>
                        </>
                      ) : null}
                    </>
                  ) : (
                    <span className="szl__scene-missing">missing</span>
                  )}
                </div>
                <div className="szl__scene-body">
                  {scene.kind === "sequence" ? (
                    <>
                      <textarea
                        className="szl__scene-script"
                        placeholder="Narration for this sequence"
                        value={scene.narration ?? scene.scriptLine}
                        onChange={(e) =>
                          editScene(scene.id, {
                            scriptLine: e.target.value,
                            narration: e.target.value
                          })
                        }
                      />
                      <div className="szl__scene-row">
                        <span className="szl__scene-app">
                          Sequence · one narration block
                        </span>
                        <span className="szl__spacer" />
                        <button
                          className="szl__scene-action"
                          onClick={() => onPickSequenceBeat(scene.id)}
                          type="button"
                        >
                          + Beat
                        </button>
                        <button
                          className="szl__scene-action"
                          onClick={() => appendNextSceneAsBeat(scene.id)}
                          disabled={
                            project.scenes[idx + 1] === undefined ||
                            project.scenes[idx + 1]?.kind === "sequence"
                          }
                          type="button"
                        >
                          Add next scene
                        </button>
                      </div>
                      <div className="szl__sequence-beats">
                        {(scene.beats ?? []).map((beat, beatIdx) => {
                          const beatCapture = captureMap.get(beat.captureId) ?? null;
                          const beatThumb =
                            beatCapture?.edits_version !== undefined
                              ? cacheUrl(beat.captureId, 160, "webp", beatCapture.edits_version)
                              : cacheUrl(beat.captureId, 160, "webp");
                          const timingKind = beat.timing.kind;
                          const isFirstBeat = beatIdx === 0;
                          const isFinalBeat = beatIdx === (scene.beats?.length ?? 0) - 1;
                          return (
                            <div className="szl__sequence-beat" key={beat.id}>
                              <span className="szl__sequence-beat-num">{beatIdx + 1}</span>
                              <span className="szl__sequence-beat-thumb">
                                {beatCapture !== null ? (
                                  beatCapture.kind === "video" ? (
                                    <video src={captureSrcUrl(beat.captureId)} muted playsInline preload="metadata" />
                                  ) : (
                                    <img src={beatThumb} alt="" />
                                  )
                                ) : (
                                  <span>missing</span>
                                )}
                              </span>
                              <span className="szl__sequence-beat-title">
                                {beatCapture?.source_app_name ?? beat.captureId}
                              </span>
                              <select
                                value={timingKind}
                                disabled={isFirstBeat}
                                onChange={(e) => {
                                  const kind = e.target.value as SizzleBeatTiming["kind"];
                                  editSequenceBeat(scene.id, beat.id, {
                                    timing:
                                      kind === "offset"
                                        ? { kind: "offset", startSec: 0, endSec: null }
                                        : { kind: "phrase", phrase: "", occurrence: null, offsetSec: 0, durationSec: null }
                                  });
                                }}
                                title={isFirstBeat ? "The first beat always starts at 0" : "Beat start timing"}
                              >
                                <option value="offset">Offset</option>
                                <option value="phrase">Phrase</option>
                              </select>
                              {beat.timing.kind === "offset" ? (
                                <>
                                  <label className="szl__sequence-time-field">
                                    <span>Start</span>
                                    <input
                                      className="szl__sequence-time"
                                      type="number"
                                      min={0}
                                      step={0.1}
                                      value={beat.timing.startSec}
                                      disabled={isFirstBeat}
                                      onChange={(e) => {
                                        const v = Number(e.target.value);
                                        if (!Number.isFinite(v)) return;
                                        editSequenceBeat(scene.id, beat.id, {
                                          timing: {
                                            kind: "offset",
                                            startSec: Math.max(0, v),
                                            endSec: beat.timing.kind === "offset" ? beat.timing.endSec : null
                                          }
                                        });
                                      }}
                                      title={isFirstBeat ? "The first beat always starts at 0" : "Beat start seconds"}
                                    />
                                  </label>
                                  <label className="szl__sequence-time-field">
                                    <span>End</span>
                                    <input
                                      className="szl__sequence-time"
                                      type="number"
                                      min={0}
                                      step={0.1}
                                      placeholder="auto"
                                      value={isFinalBeat ? beat.timing.endSec ?? "" : ""}
                                      disabled={!isFinalBeat}
                                      onChange={(e) => {
                                        if (!isFinalBeat) return;
                                        const raw = e.target.value.trim();
                                        const v = raw === "" ? null : Number(raw);
                                        if (v !== null && !Number.isFinite(v)) return;
                                        editSequenceBeat(scene.id, beat.id, {
                                          timing: {
                                            kind: "offset",
                                            startSec: beat.timing.kind === "offset" ? beat.timing.startSec : 0,
                                            endSec: v
                                          }
                                        });
                                      }}
                                      title={isFinalBeat ? "Optional final beat end seconds" : "Non-final beats end automatically at the next beat anchor"}
                                    />
                                  </label>
                                </>
                              ) : (
                                <>
                                  <input
                                    className="szl__sequence-phrase"
                                    value={beat.timing.phrase}
                                    placeholder="spoken phrase"
                                    onChange={(e) =>
                                      editSequenceBeat(scene.id, beat.id, {
                                        timing: {
                                          kind: "phrase",
                                          phrase: e.target.value,
                                          occurrence: beat.timing.kind === "phrase" ? beat.timing.occurrence : null,
                                          offsetSec: beat.timing.kind === "phrase" ? beat.timing.offsetSec : 0,
                                          durationSec: beat.timing.kind === "phrase" ? beat.timing.durationSec : null
                                        }
                                      })
                                    }
                                  />
                                  <input
                                    className="szl__sequence-time"
                                    type="number"
                                    step={0.1}
                                    value={beat.timing.offsetSec}
                                    onChange={(e) => {
                                      const v = Number(e.target.value);
                                      if (!Number.isFinite(v)) return;
                                      editSequenceBeat(scene.id, beat.id, {
                                        timing: {
                                          kind: "phrase",
                                          phrase: beat.timing.kind === "phrase" ? beat.timing.phrase : "",
                                          occurrence: beat.timing.kind === "phrase" ? beat.timing.occurrence : null,
                                          offsetSec: v,
                                          durationSec: beat.timing.kind === "phrase" ? beat.timing.durationSec : null
                                        }
                                      });
                                    }}
                                    title="Phrase offset seconds"
                                  />
                                </>
                              )}
                              <select
                                value={beat.videoFit}
                                onChange={(e) =>
                                  editSequenceBeat(scene.id, beat.id, {
                                    videoFit: e.target.value as SizzleVideoFitPolicy
                                  })
                                }
                              >
                                <option value="smart-fit">Smart</option>
                                <option value="loop">Loop</option>
                                <option value="ping-pong">Ping-pong</option>
                                <option value="speed-to-fit">Speed</option>
                                <option value="freeze-end">Freeze</option>
                                <option value="trim">Trim</option>
                              </select>
                              <select
                                value={transitionType(beat.transition)}
                                onChange={(e) =>
                                  editSequenceBeat(scene.id, beat.id, {
                                    transition: transitionFromType(e.target.value as SizzleTransitionType)
                                  })
                                }
                              >
                                <option value="cut">Cut</option>
                                <option value="crossfade">Fade</option>
                                <option value="dip-black">Dip black</option>
                                <option value="dip-white">Dip white</option>
                                <option value="push-left">Push left</option>
                                <option value="slide-left">Slide left</option>
                                <option value="zoom-cut">Zoom</option>
                              </select>
                              <button
                                className="szl__scene-mini"
                                onClick={() => moveSequenceBeat(scene.id, beatIdx, -1)}
                                disabled={beatIdx === 0}
                                type="button"
                                title="Move beat up"
                              >
                                ↑
                              </button>
                              <button
                                className="szl__scene-mini"
                                onClick={() => moveSequenceBeat(scene.id, beatIdx, 1)}
                                disabled={beatIdx === (scene.beats?.length ?? 0) - 1}
                                type="button"
                                title="Move beat down"
                              >
                                ↓
                              </button>
                              <button
                                className="szl__scene-mini szl__scene-mini--danger"
                                onClick={() => removeSequenceBeat(scene.id, beat.id)}
                                disabled={(scene.beats?.length ?? 0) <= 1}
                                type="button"
                                title="Remove beat"
                              >
                                ✕
                              </button>
                            </div>
                          );
                        })}
                      </div>
                      <div className="szl__scene-hint">
                        Sequence scene: one text block across {scene.beats?.length ?? 0} asset beat{(scene.beats?.length ?? 0) === 1 ? "" : "s"}. Beats start at offset seconds or phrase anchors; non-final beats end automatically at the next beat.
                      </div>
                      <div className="szl__scene-row">
                        <span className="szl__scene-app">sequence</span>
                        <span className="szl__spacer" />
                        <button
                          className="szl__scene-mini szl__scene-mini--play"
                          onClick={() => void onPreviewScene(scene.id)}
                          disabled={previewLoadingSceneId === scene.id || scene.scriptLine.trim().length === 0}
                          type="button"
                          title={scene.scriptLine.trim().length === 0 ? "Write narration to preview" : "Preview sequence narration"}
                        >
                          {previewLoadingSceneId === scene.id
                            ? "…"
                            : previewingSceneId === scene.id
                              ? "■"
                              : "▶"}
                        </button>
                        <button className="szl__scene-mini" onClick={() => moveScene(idx, -1)} disabled={idx === 0} type="button" title="Move up">↑</button>
                        <button className="szl__scene-mini" onClick={() => moveScene(idx, 1)} disabled={idx === project.scenes.length - 1} type="button" title="Move down">↓</button>
                        <button className="szl__scene-mini szl__scene-mini--danger" onClick={() => removeScene(scene.id)} type="button" title="Remove scene">✕</button>
                      </div>
                    </>
                  ) : (
                    <>
                  <textarea
                    className="szl__scene-script"
                    placeholder={
                      isVideo
                        ? "Optional — leave blank to play the video's native audio"
                        : "What does the narrator say over this scene?"
                    }
                    value={scene.scriptLine}
                    onChange={(e) =>
                      editScene(scene.id, { scriptLine: e.target.value })
                    }
                  />

                  {isVideo && capture?.video !== null && capture?.video !== undefined ? (
                    <div className="szl__scene-row">
                      <label className="szl__scene-dur">
                        <span>Trim start</span>
                        <input
                          type="number"
                          min={0}
                          max={capture.video.durationSec}
                          step={0.1}
                          value={
                            scene.mediaTrim?.startSec ??
                            capture.video.defaultRange.start
                          }
                          onChange={(e) => {
                            const v = Number(e.target.value);
                            if (!Number.isFinite(v) || v < 0) return;
                            const currentEnd =
                              scene.mediaTrim?.endSec ??
                              capture.video?.defaultRange.end ??
                              capture.video?.durationSec ??
                              v + 1;
                            editScene(scene.id, {
                              mediaTrim: {
                                startSec: v,
                                endSec: Math.max(v + 0.1, currentEnd)
                              }
                            });
                          }}
                        />
                        <span className="szl__scene-dur-unit">s</span>
                      </label>
                      <label className="szl__scene-dur">
                        <span>Trim end</span>
                        <input
                          type="number"
                          min={0}
                          max={capture.video.durationSec}
                          step={0.1}
                          value={
                            scene.mediaTrim?.endSec ??
                            capture.video.defaultRange.end
                          }
                          onChange={(e) => {
                            const v = Number(e.target.value);
                            if (!Number.isFinite(v)) return;
                            const currentStart =
                              scene.mediaTrim?.startSec ??
                              capture.video?.defaultRange.start ??
                              0;
                            editScene(scene.id, {
                              mediaTrim: {
                                startSec: Math.min(currentStart, v - 0.1),
                                endSec: v
                              }
                            });
                          }}
                        />
                        <span className="szl__scene-dur-unit">s</span>
                      </label>
                      <label className="szl__scene-dur">
                        <span>Audio</span>
                        <select
                          value={scene.audioSource}
                          onChange={(e) =>
                            editScene(scene.id, {
                              audioSource: e.target.value as
                                | "auto"
                                | "native"
                                | "voiceover"
                                | "muted"
                            })
                          }
                        >
                          <option value="auto">Auto ({effectiveAudio})</option>
                          <option value="native">Native</option>
                          <option value="voiceover">Voiceover</option>
                          <option value="muted">Muted</option>
                        </select>
                      </label>
                    </div>
                  ) : null}

                  {(() => {
                    // Inline mismatch hint for video scenes whose
                    // voiceover overruns the clip — surfaces the
                    // composer's "last frame holds while voiceover
                    // finishes" behavior so the user understands
                    // what'll happen before clicking Render. Only
                    // shows once the user has previewed (so we have
                    // a measured TTS duration to compare against).
                    if (!isVideo || effectiveAudio !== "voiceover") return null;
                    const audioDur = previewDurations[scene.id];
                    if (audioDur === undefined) return null;
                    const trimDur =
                      (scene.mediaTrim?.endSec ??
                        capture?.video?.defaultRange.end ??
                        0) -
                      (scene.mediaTrim?.startSec ??
                        capture?.video?.defaultRange.start ??
                        0);
                    if (audioDur + 0.35 <= trimDur + 0.1) return null;
                    const padSec = audioDur + 0.35 - trimDur;
                    return (
                      <div className="szl__scene-hint">
                        Voiceover is {audioDur.toFixed(1)}s — longer than the {trimDur.toFixed(1)}s trim.
                        Render will hold the last frame for {padSec.toFixed(1)}s.
                      </div>
                    );
                  })()}

                  <div className="szl__scene-row">
                    {!isVideo ? (
                      <label className="szl__scene-dur">
                        <span>Duration</span>
                        <input
                          type="number"
                          min={1}
                          max={30}
                          step={0.5}
                          placeholder="auto"
                          value={scene.durationOverrideSec ?? ""}
                          onChange={(e) => {
                            const v = e.target.value.trim();
                            editScene(scene.id, {
                              durationOverrideSec:
                                v === "" ? null : Number(v)
                            });
                          }}
                        />
                        <span className="szl__scene-dur-unit">s</span>
                      </label>
                    ) : null}
                    <span className="szl__scene-app">
                      {capture?.source_app_name ?? "unknown app"}
                    </span>
                    <span className="szl__spacer" />
                    <button
                      className="szl__scene-action"
                      onClick={() => convertToSequence(scene.id)}
                      type="button"
                    >
                      Sequence
                    </button>
                    <button
                      className="szl__scene-mini szl__scene-mini--play"
                      onClick={() => void onPreviewScene(scene.id)}
                      disabled={previewDisabled}
                      type="button"
                      title={previewTitle}
                    >
                      {previewLoadingSceneId === scene.id
                        ? "…"
                        : previewingSceneId === scene.id
                          ? "■"
                          : "▶"}
                    </button>
                    <button
                      className="szl__scene-mini"
                      onClick={() => moveScene(idx, -1)}
                      disabled={idx === 0}
                      type="button"
                      title="Move up"
                    >
                      ↑
                    </button>
                    <button
                      className="szl__scene-mini"
                      onClick={() => moveScene(idx, 1)}
                      disabled={idx === project.scenes.length - 1}
                      type="button"
                      title="Move down"
                    >
                      ↓
                    </button>
                    <button
                      className="szl__scene-mini szl__scene-mini--danger"
                      onClick={() => removeScene(scene.id)}
                      type="button"
                      title="Remove scene"
                    >
                      ✕
                    </button>
                  </div>
                    </>
                  )}
                </div>
              </li>
            );
            return elements;
          })
        )}
      </ul>

      {previewError !== null ? (
        <div className="szl__preview-error">{previewError}</div>
      ) : null}
      <audio
        ref={audioRef}
        onEnded={() => setPreviewingSceneId(null)}
        onPause={() => {
          // Treat any pause (including end-of-track) as "no longer playing"
          // so the button flips back to ▶.
          setPreviewingSceneId(null);
        }}
        style={{ display: "none" }}
      />

      <footer className="szl__footer">
        <RenderStatusBar status={status} />
        <span className="szl__spacer" />
        {project.outputPath !== null ? (
          <button
            className="szl__btn"
            type="button"
            onClick={onReveal}
            title={project.outputPath}
          >
            Reveal in Finder
          </button>
        ) : null}
        <button
          className="szl__btn-primary"
          onClick={onRender}
          type="button"
          disabled={rendering || project.scenes.length === 0}
        >
          {rendering ? `Rendering… ${Math.round(status.ratio * 100)}%` : "Render"}
        </button>
      </footer>
    </div>
  );
}

function RenderStatusBar({ status }: { status: RenderStatus }): ReactElement {
  if (status.phase === "idle") {
    return (
      <span className="szl__status szl__status--idle">
        Add a scene, write a script line, then render.
      </span>
    );
  }
  if (status.phase === "failed") {
    return (
      <span className="szl__status szl__status--err">
        Render failed: {status.error ?? status.message}
      </span>
    );
  }
  if (status.phase === "done") {
    return (
      <span className="szl__status szl__status--ok">Render complete.</span>
    );
  }
  return (
    <span className="szl__status">
      <span className="szl__status-bar">
        <span
          className="szl__status-bar-fill"
          style={{ width: `${Math.round(status.ratio * 100)}%` }}
        />
      </span>
      <span>{status.message}</span>
    </span>
  );
}

type CapturePickerProps = {
  captures: CaptureRecord[];
  existing: Set<string>;
  onPick: (captureId: string) => void;
  onClose: () => void;
};

function CapturePicker({
  captures,
  existing,
  onPick,
  onClose
}: CapturePickerProps): ReactElement {
  const overlayRef = useRef<HTMLDivElement | null>(null);
  return (
    <div
      ref={overlayRef}
      className="szl__modal-overlay"
      onClick={(e) => {
        if (e.target === overlayRef.current) onClose();
      }}
    >
      <div className="szl__modal">
        <header>
          <h3>Add scene from Library</h3>
          <button
            className="szl__scene-mini"
            type="button"
            onClick={onClose}
            title="Close"
          >
            ✕
          </button>
        </header>
        {captures.length === 0 ? (
          <p className="szl__hint">No captures available.</p>
        ) : (
          <div className="szl__picker-grid">
            {captures
              .filter((c) => c.deleted_at === null)
              .map((c) => {
                const isVideo = c.kind === "video";
                const durSec = isVideo ? c.video?.durationSec ?? 0 : 0;
                return (
                  <button
                    key={c.id}
                    type="button"
                    className={
                      "szl__picker-cell" + (existing.has(c.id) ? " is-used" : "")
                    }
                    onClick={() => onPick(c.id)}
                    title={c.source_app_name ?? ""}
                  >
                    <span className="szl__picker-thumb-wrap">
                      {isVideo ? (
                        // `pwrsnap-cache://` doesn't render image
                        // thumbnails for video captures — it's an
                        // image-render pipeline. Use the source video
                        // directly with `preload="metadata"` so we get
                        // just the first frame as a poster without
                        // decoding the whole clip. Same pattern as
                        // VideoCellThumb in Library.tsx.
                        <video
                          src={captureSrcUrl(c.id)}
                          preload="metadata"
                          muted
                          playsInline
                        />
                      ) : (
                        <img
                          src={cacheUrl(c.id, 240, "webp", c.edits_version)}
                          alt=""
                          // loading=lazy + decoding=async + the cell's
                          // content-visibility:auto skip the cache-protocol
                          // fetch for offscreen cells.
                          loading="lazy"
                          decoding="async"
                        />
                      )}
                      {isVideo ? (
                        <>
                          <span className="szl__picker-play" aria-hidden="true">▶</span>
                          <span className="szl__picker-duration">
                            {formatDur(durSec)}
                          </span>
                        </>
                      ) : null}
                    </span>
                    <span className="szl__picker-label">
                      {c.source_app_name ?? "—"}
                    </span>
                  </button>
                );
              })}
          </div>
        )}
      </div>
    </div>
  );
}
