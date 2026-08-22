// The scene inspector — the right-rail drawer for a selected SCENE (plan
// PR 8), sharing the clip inspector's slot and styling. What a scene has
// that a clip does not: the transition INTO the scene (type and
// duration, all eight types — the old chip was a cut↔crossfade toggle),
// the narration's synthesis state, and the structural operations: move,
// split at the playhead (resolved scenes, by the word spoken there),
// merge with the previous scene, the every-clip-its-own-scene split, and
// the §4.2 "Re-fit anchors" offer when a re-synthesis changed the
// narration's length under offset-anchored clips.

import type { ReactElement } from "react";
import {
  SIZZLE_TRANSITIONS,
  sizzleTransitionDurationSec,
  sizzleTransitionType,
  type SizzleScene,
  type SizzleTransitionType
} from "@pwrsnap/shared";
import { formatSpan, formatTimecode } from "../shared/video-range";
import { TRANSITION_DURATION_MAX_SEC, TRANSITION_DURATION_MIN_SEC } from "./ClipInspector";
import { TRANSITION_TYPE_LABELS, transitionWithType } from "./sizzle-helpers";
import type { TimelineSceneRegion } from "./timeline/timeline-model";

export type SceneInspectorProps = {
  scene: SizzleScene;
  region: TimelineSceneRegion;
  sceneCount: number;
  /** The project playhead, as seconds into THIS scene — null when it sits
   *  in another scene. */
  playheadLocalSec: number | null;
  canMergeWithPrevious: boolean;
  /** A pending re-fit offer: the resolved narration went from → to. */
  refit: { fromSec: number; toSec: number } | null;
  onEditScene: (patch: Partial<SizzleScene>) => void;
  onMoveScene: (delta: -1 | 1) => void;
  onSplitAtPlayhead: () => void;
  onMergeWithPrevious: () => void;
  onSplitIntoScenes: () => void;
  onRefit: () => void;
  onDismissRefit: () => void;
  /** Synthesize / re-synthesize the narration (previews the scene).
   *  Explicit click only — it spends TTS credits. */
  onSynthesize: () => void;
  onRemoveScene: () => void;
  onClose: () => void;
};

const EXCERPT_CHARS = 160;

export function SceneInspector(props: SceneInspectorProps): ReactElement {
  const {
    scene,
    region,
    sceneCount,
    playheadLocalSec,
    canMergeWithPrevious,
    refit,
    onEditScene,
    onMoveScene,
    onSplitAtPlayhead,
    onMergeWithPrevious,
    onSplitIntoScenes,
    onRefit,
    onDismissRefit,
    onSynthesize,
    onRemoveScene,
    onClose
  } = props;
  const index = region.index;
  const isFirst = index === 0;
  const isLast = index === sceneCount - 1;
  const clipCount = region.clips.length;
  const tilde = region.exact ? "" : "~";
  const narration = (scene.narration ?? scene.scriptLine).trim();
  const wordCount = narration.length === 0 ? 0 : narration.split(/\s+/).length;
  const excerpt = narration.length > EXCERPT_CHARS ? `${narration.slice(0, EXCERPT_CHARS).trimEnd()}…` : narration;
  const transitionType = sizzleTransitionType(scene.transition);
  const transitionSec = sizzleTransitionDurationSec(scene.transition);
  const hardCut = transitionType === "cut" || transitionType === "none";
  const isSequence = scene.kind === "sequence";
  const canSplitAtPlayhead =
    isSequence &&
    region.exact &&
    clipCount >= 2 &&
    playheadLocalSec !== null &&
    playheadLocalSec > 0 &&
    playheadLocalSec < region.durationSec;
  const splitTitle = !isSequence
    ? "Convert the scene to clips first"
    : !region.exact
      ? "Synthesize the narration first — the split follows the spoken words, which are not known yet"
      : clipCount < 2
        ? "A scene needs two clips to split"
        : playheadLocalSec === null
          ? "Scrub the playhead into this scene to choose where to split"
          : `Split the script and clips at ${formatTimecode(playheadLocalSec)} into this scene`;

  return (
    <section className="szl__insp" aria-label={`Scene ${index + 1} inspector`} data-testid="sizzle-scene-inspector">
      <header className="szl__insp-head">
        <span className="szl__insp-eyebrow">
          Scene {index + 1} of {sceneCount}
        </span>
        <span className="szl__insp-name">
          {clipCount} clip{clipCount === 1 ? "" : "s"} · {tilde}
          {formatSpan(region.durationSec)}
        </span>
        <button
          type="button"
          className="szl__insp-close"
          onClick={onClose}
          aria-label="Close inspector"
          title="Close inspector (click bare track or press Esc)"
          data-testid="sizzle-scene-inspector-close"
        >
          ✕
        </button>
      </header>

      <div className="szl__insp-body">
        {/* ── Narration ── */}
        <div className="szl__insp-field">
          <span className="szl__insp-label">Narration</span>
          <p className="szl__insp-excerpt" data-testid="sizzle-scene-inspector-excerpt">
            {excerpt.length > 0 ? excerpt : <em>No narration yet — write it on the scene card.</em>}
          </p>
          <div className="szl__insp-row">
            <span className="szl__insp-hint" data-testid="sizzle-scene-inspector-status">
              {region.exact
                ? `Synthesized · ${formatTimecode(region.durationSec)}`
                : `~${formatTimecode(region.durationSec)} estimated from ${wordCount} word${wordCount === 1 ? "" : "s"}`}
            </span>
            <span className="szl__spacer" />
            {isSequence ? (
              <button
                type="button"
                className="szl__scene-mini szl__insp-action"
                onClick={onSynthesize}
                disabled={narration.length === 0}
                title={
                  region.exact
                    ? "Synthesize the narration again (uses your TTS provider)"
                    : "Synthesize the narration for exact timing and anchorable words (uses your TTS provider)"
                }
                data-testid="sizzle-scene-inspector-synthesize"
              >
                {region.exact ? "Re-synthesize" : "Synthesize narration"}
              </button>
            ) : null}
          </div>
        </div>

        {/* ── Transition into this scene ── */}
        <div className="szl__insp-field">
          <span className="szl__insp-label">Transition into this scene</span>
          {isFirst ? (
            <p className="szl__insp-hint">The first scene opens the reel — nothing precedes it.</p>
          ) : (
            <div className="szl__insp-row">
              <select
                value={transitionType}
                onChange={(e) =>
                  onEditScene({
                    transition: transitionWithType(scene.transition, e.target.value as SizzleTransitionType)
                  })
                }
                aria-label="Scene transition type"
                data-testid="sizzle-scene-inspector-transition"
              >
                {SIZZLE_TRANSITIONS.map((type) => (
                  <option key={type} value={type}>
                    {TRANSITION_TYPE_LABELS[type]}
                  </option>
                ))}
              </select>
              <label className="szl__insp-num">
                <span>Duration</span>
                <input
                  type="number"
                  min={TRANSITION_DURATION_MIN_SEC}
                  max={TRANSITION_DURATION_MAX_SEC}
                  step={0.05}
                  value={hardCut ? "" : transitionSec}
                  disabled={hardCut}
                  placeholder={hardCut ? "—" : undefined}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    if (!Number.isFinite(v) || v <= 0) return;
                    onEditScene({
                      transition: {
                        type: transitionType,
                        durationSec: Math.min(TRANSITION_DURATION_MAX_SEC, Math.max(TRANSITION_DURATION_MIN_SEC, v))
                      }
                    });
                  }}
                  title={hardCut ? "A cut has no duration" : "How long the transition takes, in seconds"}
                  data-testid="sizzle-scene-inspector-transition-duration"
                />
                <i>s</i>
              </label>
            </div>
          )}
        </div>

        {/* ── Re-fit offer (plan §4.2) ── */}
        {refit !== null ? (
          <div className="szl__insp-offer" role="status" data-testid="sizzle-scene-inspector-refit">
            <span>
              The narration went from <b>{formatSpan(refit.fromSec)}</b> to <b>{formatSpan(refit.toSec)}</b>. Offset anchors
              keep their absolute seconds — they were not rescaled.
            </span>
            <span className="szl__insp-row">
              <button
                type="button"
                className="szl__scene-mini szl__insp-action"
                onClick={onRefit}
                title={`Scale every offset anchor by ${(refit.toSec / refit.fromSec).toFixed(3)}`}
                data-testid="sizzle-scene-inspector-refit-apply"
              >
                Re-fit anchors
              </button>
              <button
                type="button"
                className="szl__scene-mini szl__insp-action"
                onClick={onDismissRefit}
                data-testid="sizzle-scene-inspector-refit-dismiss"
              >
                Keep as is
              </button>
            </span>
          </div>
        ) : null}

        {/* ── Structure ── */}
        <div className="szl__insp-field">
          <span className="szl__insp-label">Structure</span>
          <div className="szl__insp-row">
            <button
              type="button"
              className="szl__scene-mini szl__insp-action"
              onClick={onSplitAtPlayhead}
              disabled={!canSplitAtPlayhead}
              title={splitTitle}
              data-testid="sizzle-scene-inspector-split-at-playhead"
            >
              Split at playhead
            </button>
            <button
              type="button"
              className="szl__scene-mini szl__insp-action"
              onClick={onMergeWithPrevious}
              disabled={!canMergeWithPrevious}
              title={
                canMergeWithPrevious
                  ? "Join this scene's narration and clips onto the previous scene"
                  : isFirst
                    ? "Nothing before the first scene"
                    : "The previous scene must be a clips scene to merge into"
              }
              data-testid="sizzle-scene-inspector-merge"
            >
              Merge with previous
            </button>
            <button
              type="button"
              className="szl__scene-mini szl__insp-action"
              onClick={onSplitIntoScenes}
              disabled={!isSequence || clipCount < 2}
              title="Give every clip its own scene (its own voiceover segment)"
              data-testid="sizzle-scene-inspector-split-into-scenes"
            >
              Split into scenes
            </button>
          </div>
        </div>
      </div>

      <footer className="szl__insp-foot">
        <button
          type="button"
          className="szl__scene-mini"
          onClick={() => onMoveScene(-1)}
          disabled={isFirst}
          title="Move scene earlier"
          data-testid="sizzle-scene-inspector-move-earlier"
        >
          ◀
        </button>
        <button
          type="button"
          className="szl__scene-mini"
          onClick={() => onMoveScene(1)}
          disabled={isLast}
          title="Move scene later"
          data-testid="sizzle-scene-inspector-move-later"
        >
          ▶
        </button>
        <span className="szl__spacer" />
        <button
          type="button"
          className="szl__scene-mini szl__scene-mini--danger szl__insp-remove"
          onClick={onRemoveScene}
          title="Remove scene"
          data-testid="sizzle-scene-inspector-remove"
        >
          Remove scene
        </button>
      </footer>
    </section>
  );
}
