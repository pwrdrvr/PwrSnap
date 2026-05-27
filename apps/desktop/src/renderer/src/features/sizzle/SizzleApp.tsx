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
import { cacheUrl, dispatch, subscribe } from "../../lib/pwrsnap";
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

  const onUpdate = useCallback(
    async (id: string, patch: Partial<Omit<SizzleProject, "id" | "createdAt">>) => {
      const r = await dispatch("sizzle:update", { id, patch });
      if (r.ok) {
        setProjects((prev) => prev.map((p) => (p.id === id ? r.value : p)));
      }
    },
    []
  );

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
  }, [active]);

  const onReveal = useCallback(async () => {
    if (active === null) return;
    await dispatch("sizzle:revealOutput", { id: active.id });
  }, [active]);

  const onAddScene = useCallback(
    async (captureId: string) => {
      if (active === null) return;
      const scene: SizzleScene = {
        id: `sc_${Date.now().toString(36)}`,
        captureId,
        scriptLine: "",
        durationOverrideSec: null
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
          project.scenes.map((scene, idx) => {
            const capture = captureMap.get(scene.captureId) ?? null;
            const thumb =
              capture?.edits_version !== undefined
                ? cacheUrl(scene.captureId, 320, "webp", capture.edits_version)
                : cacheUrl(scene.captureId, 320, "webp");
            return (
              <li key={scene.id} className="szl__scene">
                <span className="szl__scene-num">{idx + 1}</span>
                <div className="szl__scene-thumb">
                  {capture ? (
                    <img src={thumb} alt="" />
                  ) : (
                    <span className="szl__scene-missing">missing</span>
                  )}
                </div>
                <div className="szl__scene-body">
                  <textarea
                    className="szl__scene-script"
                    placeholder="What does the narrator say over this scene?"
                    value={scene.scriptLine}
                    onChange={(e) =>
                      editScene(scene.id, { scriptLine: e.target.value })
                    }
                  />
                  <div className="szl__scene-row">
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
                    <span className="szl__scene-app">
                      {capture?.source_app_name ?? "unknown app"}
                    </span>
                    <span className="szl__spacer" />
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
          })
        )}
      </ul>

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
              .filter((c) => c.kind === "image" && c.deleted_at === null)
              .map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className={
                    "szl__picker-cell" + (existing.has(c.id) ? " is-used" : "")
                  }
                  onClick={() => onPick(c.id)}
                  title={c.source_app_name ?? ""}
                >
                  <img
                    src={cacheUrl(c.id, 240, "webp", c.edits_version)}
                    alt=""
                  />
                  <span className="szl__picker-label">
                    {c.source_app_name ?? "—"}
                  </span>
                </button>
              ))}
          </div>
        )}
      </div>
    </div>
  );
}
