import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import type { CaptureRecord, SizzleProject } from "@pwrsnap/shared";
import { cacheUrl, captureSrcUrl, dispatch } from "../../lib/pwrsnap";

type LibraryProjectViewProps = {
  project: SizzleProject | null;
  onClose: () => void;
};

/**
 * Library main-pane takeover for in-library Sizzle Reels project mode.
 * Mounted by Library.tsx when `view.kind === "project"`. Renders the
 * project's scenes as an ordered grid; a toolbar at the top of the
 * pane exposes "Add captures" + "Open editor" + "Close" actions.
 *
 * Lives in its own file so the existing 2400-line Library.tsx grid
 * layer doesn't have to learn about projects — the project query is
 * a separate `library:listByIds` call and the cell renderer is
 * project-mode-specific (with order badges + a +/✓ overlay in adding
 * mode).
 *
 * Out of scope this round (followups):
 *   - Drag-to-reorder scenes (the toolbar's Open Editor delegates).
 *   - Multi-select for batch actions.
 *   - Inline scene-edit (still goes through the sizzle window).
 */
export function LibraryProjectView({
  project,
  onClose
}: LibraryProjectViewProps): ReactElement {
  const [adding, setAdding] = useState(false);
  const [projectCaptures, setProjectCaptures] = useState<CaptureRecord[]>([]);
  const [libraryCaptures, setLibraryCaptures] = useState<CaptureRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [toggling, setToggling] = useState<string | null>(null);

  // Fetch the project's scene captures in scene order via
  // library:listByIds. Refetches whenever the scene list changes
  // (e.g. the user toggles a capture in adding mode).
  const sceneCaptureIds = useMemo(
    () => (project ? project.scenes.map((s) => s.captureId) : []),
    [project]
  );
  useEffect(() => {
    if (sceneCaptureIds.length === 0) {
      setProjectCaptures([]);
      setLoading(false);
      return;
    }
    let active = true;
    setLoading(true);
    void dispatch("library:listByIds", { ids: sceneCaptureIds }).then((r) => {
      if (!active) return;
      if (r.ok) setProjectCaptures(r.value.rows);
      setLoading(false);
    });
    return () => {
      active = false;
    };
  }, [sceneCaptureIds]);

  // In adding mode we fetch the full library so the user can pick
  // from anywhere. Limit to the head page (200 captures) — matches
  // the existing sizzle picker pattern.
  useEffect(() => {
    if (!adding) return;
    let active = true;
    void dispatch("library:list", { limit: 200 }).then((r) => {
      if (!active) return;
      if (r.ok) setLibraryCaptures(r.value.rows);
    });
    return () => {
      active = false;
    };
  }, [adding]);

  const captureIdsInProject = useMemo(
    () => new Set(project?.scenes.map((s) => s.captureId) ?? []),
    [project]
  );

  const onToggle = useCallback(
    async (captureId: string) => {
      if (project === null) return;
      setToggling(captureId);
      try {
        await dispatch("sizzle:toggleScene", {
          projectId: project.id,
          captureId
        });
        // useSizzleProjects subscribes to events:sizzle:projects:changed,
        // so the next render gets the updated project from the parent.
      } finally {
        setToggling(null);
      }
    },
    [project]
  );

  if (project === null) {
    return (
      <div className="psl-proj">
        <div className="psl-proj__empty">
          <p>Project not found. It may have been deleted.</p>
          <button className="psl-proj__btn" onClick={onClose} type="button">
            Back to Library
          </button>
        </div>
      </div>
    );
  }

  const visibleCaptures = adding ? libraryCaptures : projectCaptures;

  return (
    <div className="psl-proj">
      <header className="psl-proj__head">
        <button
          className="psl-proj__close"
          onClick={onClose}
          type="button"
          title="Back to Library"
        >
          ←
        </button>
        <div className="psl-proj__title">
          <div className="psl-proj__name">{project.name}</div>
          <div className="psl-proj__meta">
            {project.scenes.length} scene{project.scenes.length === 1 ? "" : "s"}
            {project.lastRenderedAt
              ? ` · rendered ${new Date(project.lastRenderedAt).toLocaleDateString()}`
              : " · never rendered"}
          </div>
        </div>
        <span className="psl-proj__spacer" />
        {adding ? (
          <button
            className="psl-proj__btn psl-proj__btn--primary"
            onClick={() => setAdding(false)}
            type="button"
          >
            Done adding
          </button>
        ) : (
          <>
            <button
              className="psl-proj__btn"
              onClick={() => setAdding(true)}
              type="button"
              title="Pick captures to add to this Sizzle Reel"
            >
              + Add captures
            </button>
            <button
              className="psl-proj__btn psl-proj__btn--primary"
              onClick={() => {
                void dispatch("sizzle:open", { projectId: project.id });
              }}
              type="button"
              title="Open this Sizzle Reel in the editor"
            >
              Open editor
            </button>
          </>
        )}
      </header>

      {adding ? (
        <div className="psl-proj__hint">
          Adding mode: click any capture to add or remove it from this Sizzle
          Reel. Click <strong>Done adding</strong> to return.
        </div>
      ) : null}

      {loading ? (
        <div className="psl-proj__empty">Loading scenes…</div>
      ) : visibleCaptures.length === 0 ? (
        <div className="psl-proj__empty">
          {adding
            ? "No captures available."
            : "No scenes yet. Click + Add captures to pick from your Library."}
        </div>
      ) : (
        <div className="psl-proj__grid">
          {visibleCaptures.map((c, idx) => {
            const inProject = captureIdsInProject.has(c.id);
            // In project view (non-adding) the cell order is the
            // scene index; in adding mode there's no scene order on
            // arbitrary library captures, so badge only shows for
            // captures that ARE in the project (echoing their scene
            // index from the project list).
            let badge: number | null = null;
            if (!adding) badge = idx + 1;
            else if (inProject) {
              const sceneIdx = project.scenes.findIndex(
                (s) => s.captureId === c.id
              );
              badge = sceneIdx >= 0 ? sceneIdx + 1 : null;
            }
            return (
              <button
                key={c.id}
                type="button"
                className={
                  "psl-proj__cell" + (inProject ? " is-used" : "") +
                  (toggling === c.id ? " is-toggling" : "")
                }
                onClick={() => {
                  if (adding) void onToggle(c.id);
                }}
                title={
                  adding
                    ? inProject
                      ? "Remove from project"
                      : "Add to project"
                    : c.source_app_name ?? ""
                }
              >
                <span className="psl-proj__cell-thumb">
                  {c.kind === "video" ? (
                    // Video captures don't have image thumbnails via
                    // pwrsnap-cache://; render the source clip with
                    // preload="metadata" so we get the first frame as
                    // a poster. Same trick VideoCellThumb uses in
                    // Library.tsx.
                    <video
                      src={captureSrcUrl(c.id)}
                      preload="metadata"
                      muted
                      playsInline
                    />
                  ) : (
                    <img
                      src={cacheUrl(c.id, 320, "webp", c.edits_version)}
                      alt=""
                      loading="lazy"
                      decoding="async"
                    />
                  )}
                  {badge !== null ? (
                    <span className="psl-proj__cell-order">
                      {badge.toString().padStart(2, "0")}
                    </span>
                  ) : null}
                  {c.kind === "video" ? (
                    <span className="psl-proj__cell-kind" aria-hidden="true">▶</span>
                  ) : null}
                  {adding ? (
                    <span
                      className={
                        "psl-proj__cell-toggle" +
                        (inProject ? " is-on" : "")
                      }
                      aria-hidden="true"
                    >
                      {inProject ? "✓" : "+"}
                    </span>
                  ) : null}
                </span>
                <span className="psl-proj__cell-label">
                  {c.source_app_name ?? "—"}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
