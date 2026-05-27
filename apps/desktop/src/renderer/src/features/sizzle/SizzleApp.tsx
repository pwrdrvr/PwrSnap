import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import {
  EVENT_CHANNELS,
  SIZZLE_VOICES,
  type CaptureRecord,
  type SizzleProject,
  type SizzleRenderProgressEvent,
  type SizzleScene,
  type SizzleVoice
} from "@pwrsnap/shared";
import { cacheUrl, captureSrcUrl, dispatch, subscribe } from "../../lib/pwrsnap";
import { PwrSnapMark, PwrSnapWordmark } from "../shared/BrandMark";
import "./sizzle.css";

type RenderStatus = {
  phase: SizzleRenderProgressEvent["phase"] | "idle";
  message: string;
  ratio: number;
  error: string | null;
};

const IDLE_STATUS: RenderStatus = {
  phase: "idle",
  message: "",
  ratio: 0,
  error: null
};

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

export function SizzleApp(): ReactElement {
  const [projects, setProjects] = useState<SizzleProject[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [captures, setCaptures] = useState<CaptureRecord[]>([]);
  const [picker, setPicker] = useState(false);
  const [status, setStatus] = useState<RenderStatus>(IDLE_STATUS);
  const [loading, setLoading] = useState(true);
  const [focusTitleForId, setFocusTitleForId] = useState<string | null>(null);

  const active = useMemo(
    () => projects.find((p) => p.id === activeId) ?? null,
    [projects, activeId]
  );

  const reloadProjects = useCallback(async () => {
    const r = await dispatch("sizzle:list", {});
    if (r.ok) {
      setProjects(r.value.projects);
      setLoading(false);
      if (activeId === null && r.value.projects.length > 0) {
        setActiveId(r.value.projects[0]!.id);
      }
    }
  }, [activeId]);

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
      setActiveId(r.value.id);
      setFocusTitleForId(r.value.id);
    }
  }, []);

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

  const onDelete = useCallback(
    async (id: string) => {
      if (!window.confirm("Delete this sizzle reel?")) return;
      const r = await dispatch("sizzle:delete", { id });
      if (r.ok) {
        setProjects((prev) => {
          const next = prev.filter((p) => p.id !== id);
          if (activeId === id) setActiveId(next[0]?.id ?? null);
          return next;
        });
      }
    },
    [activeId]
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
      setPicker(false);
    },
    [active, onUpdate]
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
      </header>
      <aside className="szl__rail">
        <button className="szl__new" onClick={onCreate} type="button">
          + New Sizzle Reel
        </button>
        <ul className="szl__list">
          {loading ? (
            <li className="szl__empty">Loading…</li>
          ) : projects.length === 0 ? (
            <li className="szl__empty">No projects yet. Create one above.</li>
          ) : (
            projects.map((p) => (
              <li key={p.id}>
                <button
                  className={
                    "szl__row" + (activeId === p.id ? " is-active" : "")
                  }
                  onClick={() => setActiveId(p.id)}
                  type="button"
                >
                  <span className="szl__row-name">{p.name}</span>
                  <span className="szl__row-meta">
                    {p.scenes.length} clip{p.scenes.length === 1 ? "" : "s"} ·{" "}
                    {p.voice}
                  </span>
                </button>
              </li>
            ))
          )}
        </ul>
      </aside>

      <main className="szl__main">
        {active === null ? (
          <EmptyState />
        ) : (
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
            onPickCapture={() => setPicker(true)}
            onRender={onRender}
            onReveal={onReveal}
            onDelete={() => onDelete(active.id)}
            status={status}
          />
        )}
      </main>

      {picker && active !== null ? (
        <CapturePicker
          captures={captures}
          onPick={onAddScene}
          onClose={() => setPicker(false)}
          existing={new Set(active.scenes.map((s) => s.captureId))}
        />
      ) : null}
    </div>
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
            // Compute the effective audio source for UI gating: same
            // logic as the main-process resolveAudioSource(), kept
            // client-side so the preview button + script placeholder
            // can update without waiting for a dispatch round-trip.
            const effectiveAudio: "voiceover" | "native" | "muted" =
              scene.audioSource !== "auto"
                ? capture?.kind === "image" && scene.audioSource === "native"
                  ? "muted"
                  : scene.audioSource
                : capture?.kind === "video" && scene.scriptLine.trim().length === 0
                  ? "native"
                  : "voiceover";
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
                    (scene.transition === "crossfade"
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
                          scene.transition === "crossfade" ? "cut" : "crossfade"
                      })
                    }
                    title="Toggle between Cut and Crossfade"
                  >
                    {scene.transition === "crossfade" ? "⌒ Crossfade ⌒" : "─ Cut ─"}
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
