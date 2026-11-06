import { useEffect, useState, type ReactElement } from "react";
import { sizzleTimelineFrames, type SizzleProject } from "@pwrsnap/shared";
import { dispatch, sizzleOutputUrl } from "../../lib/pwrsnap";
import {
  RenderStatusBar,
  isRendering,
  type RenderStatus,
} from "./RenderStatusBar";

/** Agent-authored timelines use the export renderer for frame inspection.
 * This keeps previews faithful without maintaining a second animation engine. */
export function TimelineEditor({
  project,
  status,
  onRender,
  onReveal,
}: {
  readonly project: SizzleProject;
  readonly status: RenderStatus;
  readonly onRender: () => void;
  readonly onReveal: () => void;
}): ReactElement {
  const timeline = project.timeline!;
  const [frame, setFrame] = useState(0);
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const total = sizzleTimelineFrames(timeline);
  useEffect(() => {
    let active = true;
    const timer = setTimeout(() => {
      void dispatch("sizzle:timelineFrame", {
        id: project.id,
        frame: Math.min(frame, total - 1),
      })
        .then((result) => {
          if (!active) return;
          if (result.ok) {
            setPreview(`data:image/png;base64,${result.value.pngBase64}`);
            setError(null);
          } else setError(result.error.message);
        })
        .catch(() => {
          if (active) setError("Could not load this frame");
        });
    }, 200);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [project.id, project.modifiedAt, frame, total]);
  return (
    <section className="szl__editor">
      <header className="szl__editor-head">
        <h2>{project.name}</h2>
        <p className="szl__editor-meta">
          {timeline.scenes.length} scenes · {(total / timeline.fps).toFixed(2)}{" "}
          s · {timeline.width} × {timeline.height} · {timeline.fps} fps
        </p>
      </header>
      <div className="szl__timeline-preview">
        {project.outputPath && project.lastRenderedAt ? (
          <video
            key={project.lastRenderedAt}
            src={sizzleOutputUrl(project.id, project.lastRenderedAt)}
            controls
            playsInline
            preload="metadata"
          />
        ) : preview ? (
          <img src={preview} alt={`Reel frame ${Math.min(frame, total - 1)}`} />
        ) : (
          <p>Loading preview…</p>
        )}
        <label>
          Inspect frame {Math.min(frame, total - 1)}
          <input
            type="range"
            min={0}
            max={total - 1}
            value={Math.min(frame, total - 1)}
            onChange={(event) => setFrame(Number(event.target.value))}
          />
        </label>
        {project.outputPath && preview ? (
          <img
            src={preview}
            alt={`Inspected frame ${Math.min(frame, total - 1)}`}
          />
        ) : null}
        {error ? <p role="alert">{error}</p> : null}
        <div className="szl__editor-meta">
          {timeline.scenes.map((scene) => (
            <span key={scene.id}>
              {scene.id} · {scene.durationFrames} frames &nbsp;{" "}
            </span>
          ))}
        </div>
      </div>
      <footer className="szl__timeline-actions">
        <RenderStatusBar
          status={status}
          idleText="Inspect a frame or render the reel."
        />
        <button
          type="button"
          className="szl__btn szl__btn--primary"
          disabled={isRendering(status)}
          onClick={onRender}
        >
          Render reel
        </button>
        <button
          type="button"
          className="szl__btn"
          disabled={!project.outputPath}
          onClick={onReveal}
        >
          Show movie
        </button>
      </footer>
    </section>
  );
}
