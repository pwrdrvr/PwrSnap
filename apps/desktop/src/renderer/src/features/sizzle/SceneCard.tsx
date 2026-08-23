// The per-scene cards in the editor's scene list: the sequence scene
// (narration textarea, preview stage) and the legacy one-capture
// "simple" scene, plus the transition chip between scenes. The clips
// themselves are on the timeline; a selected clip's timing / transition /
// fit live in the clip inspector (`ClipInspector.tsx`) — the pre-timeline
// form rows that used to sit here were retired with it (plan PR 6).

import type { ReactElement } from "react";
import {
  SIZZLE_TRANSITIONS,
  type CaptureRecord,
  type SizzleAudioSource,
  type SizzleScene,
  type SizzleTransitionType
} from "@pwrsnap/shared";
import { cacheUrl, captureSrcUrl } from "../../lib/pwrsnap";
import {
  formatDur,
  sceneTransitionWithType,
  transitionType,
  TRANSITION_TYPE_LABELS
} from "./sizzle-helpers";

// ── Scene → scene transition chip ──────────────────────────────────────

export function SceneTransitionChip({
  scene,
  idx,
  onEditScene
}: {
  scene: SizzleScene;
  idx: number;
  onEditScene: (patch: Partial<SizzleScene>) => void;
}): ReactElement {
  // The chip is a <select> over every transition type the composer
  // renders — not a cut↔crossfade toggle — so the six fade-like types
  // are reachable at scene level too.
  const sceneTransition = transitionType(scene.transition);
  const isHardCut = sceneTransition === "cut" || sceneTransition === "none";
  return (
    <li
      className={
        "szl__transition" +
        (isHardCut ? " szl__transition--cut" : " szl__transition--fade")
      }
    >
      <label
        className="szl__transition-chip"
        title={`Transition into scene ${idx + 1}`}
      >
        <span aria-hidden="true">{isHardCut ? "─" : "⌒"}</span>
        <select
          aria-label={`Transition into scene ${idx + 1}`}
          value={sceneTransition}
          onChange={(e) =>
            onEditScene({
              // Same writer the scene inspector uses: switching the TYPE must
              // not silently discard a duration the user set on the pill.
              transition: sceneTransitionWithType(scene.transition, e.target.value as SizzleTransitionType)
            })
          }
          data-testid={`sizzle-scene-transition-${idx}`}
        >
          {SIZZLE_TRANSITIONS.map((type) => (
            <option key={type} value={type}>
              {TRANSITION_TYPE_LABELS[type]}
            </option>
          ))}
        </select>
        <span aria-hidden="true">{isHardCut ? "─" : "⌒"}</span>
      </label>
    </li>
  );
}

// ── Sequence scene ─────────────────────────────────────────────────────

export type SequenceSceneCardProps = {
  scene: SizzleScene;
  idx: number;
  sceneCount: number;
  captureMap: Map<string, CaptureRecord>;
  onEditScene: (patch: Partial<SizzleScene>) => void;
  onPickSequenceBeat: () => void;
  /** Seek the ONE reel player to this scene and play. There is no
   *  per-scene stage any more — the reel player and the timeline show
   *  everything this card used to duplicate. */
  onPlayFrom: () => void;
  onSplitIntoScenes: () => void;
  onMoveScene: (delta: number) => void;
  onRemoveScene: () => void;
};

export function SequenceSceneCard(props: SequenceSceneCardProps): ReactElement {
  const {
    scene,
    idx,
    sceneCount,
    captureMap,
    onEditScene,
    onPickSequenceBeat,
    onPlayFrom,
    onSplitIntoScenes,
    onMoveScene,
    onRemoveScene
  } = props;
  const beats = scene.beats ?? [];
  return (
    <li className="szl__scene szl__scene--sequence">
      <span className="szl__scene-num">{idx + 1}</span>
      <div className="szl__scene-body">
        <textarea
          className="szl__scene-script"
          placeholder="What does the narrator say over this scene?"
          value={scene.narration ?? scene.scriptLine}
          onChange={(e) =>
            onEditScene({
              scriptLine: e.target.value,
              narration: e.target.value
            })
          }
        />
        <div className="szl__scene-row">
          <span className="szl__scene-app">
            Scene · one voiceover · {beats.length} clip{beats.length === 1 ? "" : "s"}
          </span>
          <span className="szl__spacer" />
          {beats.length > 1 ? (
            <button
              className="szl__scene-action"
              onClick={onSplitIntoScenes}
              type="button"
              title="Give every clip its own scene (its own voiceover segment). This scene keeps the narration; the new scenes start empty."
              data-testid={`sizzle-split-scene-${scene.id}`}
            >
              Split into scenes
            </button>
          ) : null}
          <button
            className="szl__scene-action"
            onClick={onPickSequenceBeat}
            type="button"
          >
            + Clip
          </button>
        </div>
        {/* No stage here: the reel player above is the ONE player, and the
            timeline carries this scene's clips, waveform and words. */}
        <div className="szl__scene-row">
          <span className="szl__scene-app">sequence</span>
          <button
            className="szl__scene-mini szl__scene-mini--play"
            onClick={onPlayFrom}
            type="button"
            title="Play the reel from this scene"
            data-testid={`sizzle-play-from-${scene.id}`}
          >
            ▶
          </button>
          <span className="szl__spacer" />
          <button className="szl__scene-mini" onClick={() => onMoveScene(-1)} disabled={idx === 0} type="button" title="Move up">↑</button>
          <button className="szl__scene-mini" onClick={() => onMoveScene(1)} disabled={idx === sceneCount - 1} type="button" title="Move down">↓</button>
          <button className="szl__scene-mini szl__scene-mini--danger" onClick={onRemoveScene} type="button" title="Remove scene">✕</button>
        </div>
      </div>
    </li>
  );
}

// ── Legacy one-capture ("simple") scene ────────────────────────────────

export type SimpleSceneCardProps = {
  scene: SizzleScene;
  idx: number;
  sceneCount: number;
  capture: CaptureRecord | null;
  effectiveAudio: Exclude<SizzleAudioSource, "auto">;
  /** Measured voiceover length from a preview, if any, for the overrun hint. */
  measuredVoiceoverDurationSec: number | undefined;
  onEditScene: (patch: Partial<SizzleScene>) => void;
  onConvertToSequence: () => void;
  /** Seek the ONE reel player to this scene and play. */
  onPlayFrom: () => void;
  onMoveScene: (delta: number) => void;
  onRemoveScene: () => void;
};

export function SimpleSceneCard(props: SimpleSceneCardProps): ReactElement {
  const {
    scene,
    idx,
    sceneCount,
    capture,
    effectiveAudio,
    measuredVoiceoverDurationSec,
    onEditScene,
    onConvertToSequence,
    onPlayFrom,
    onMoveScene,
    onRemoveScene
  } = props;
  const isVideo = capture?.kind === "video";
  const thumb =
    capture?.edits_version !== undefined
      ? cacheUrl(scene.captureId, 320, "webp", capture.edits_version)
      : cacheUrl(scene.captureId, 320, "webp");
  return (
    <li className="szl__scene">
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
            onEditScene({ scriptLine: e.target.value })
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
                  onEditScene({
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
                  onEditScene({
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
                  onEditScene({
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
          const audioDur = measuredVoiceoverDurationSec;
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
                  onEditScene({
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
            onClick={onConvertToSequence}
            type="button"
            title="Turn this one-capture scene into a scene with clips: one voiceover, many visuals"
          >
            Convert to clips
          </button>
          <button
            className="szl__scene-mini szl__scene-mini--play"
            onClick={onPlayFrom}
            type="button"
            title="Play the reel from this scene"
            data-testid={`sizzle-play-from-${scene.id}`}
          >
            ▶
          </button>
          <button
            className="szl__scene-mini"
            onClick={() => onMoveScene(-1)}
            disabled={idx === 0}
            type="button"
            title="Move up"
          >
            ↑
          </button>
          <button
            className="szl__scene-mini"
            onClick={() => onMoveScene(1)}
            disabled={idx === sceneCount - 1}
            type="button"
            title="Move down"
          >
            ↓
          </button>
          <button
            className="szl__scene-mini szl__scene-mini--danger"
            onClick={onRemoveScene}
            type="button"
            title="Remove scene"
          >
            ✕
          </button>
        </div>
      </div>
    </li>
  );
}
