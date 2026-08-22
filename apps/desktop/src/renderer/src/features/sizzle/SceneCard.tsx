// The per-scene cards in the editor's scene list: the sequence scene
// (narration textarea, clip rows, preview stage) and the legacy
// one-capture "simple" scene, plus the transition chip between scenes.
// Form rows here are the pre-timeline UI; plan PR 3 adds the horizontal
// timeline above them and PR 6 retires them for the clip inspector.

import type { ReactElement } from "react";
import {
  SIZZLE_TRANSITIONS,
  type CaptureRecord,
  type SizzleAudioSource,
  type SizzleBeatTiming,
  type SizzleScene,
  type SizzleSequenceBeat,
  type SizzleSequencePreviewPlan,
  type SizzleSequenceTranscriptPhrase,
  type SizzleTransitionType,
  type SizzleVideoFitPolicy
} from "@pwrsnap/shared";
import { cacheUrl, captureSrcUrl } from "../../lib/pwrsnap";
import { SequenceTimelinePreview } from "./PreviewStage";
import { TranscriptPhrasePicker } from "./TranscriptPhrasePicker";
import {
  formatDur,
  occurrenceForTranscriptPhrase,
  sceneTransitionFromType,
  transitionFromType,
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
              transition: sceneTransitionFromType(e.target.value as SizzleTransitionType)
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
  transcriptPhrases: SizzleSequenceTranscriptPhrase[];
  plan: SizzleSequencePreviewPlan | undefined;
  audioBlob: Blob | undefined;
  currentTimeSec: number;
  playing: boolean;
  loading: boolean;
  onEditScene: (patch: Partial<SizzleScene>) => void;
  onEditBeat: (beatId: string, patch: Partial<SizzleSequenceBeat>) => void;
  onReorderBeat: (from: number, to: number) => void;
  onRemoveBeat: (beatId: string) => void;
  onPickSequenceBeat: () => void;
  onSplitIntoScenes: () => void;
  onMoveScene: (delta: number) => void;
  onRemoveScene: () => void;
  onPreviewScene: () => void;
  onSeekPreview: (timeSec: number) => void;
};

export function SequenceSceneCard(props: SequenceSceneCardProps): ReactElement {
  const {
    scene,
    idx,
    sceneCount,
    captureMap,
    transcriptPhrases,
    plan,
    audioBlob,
    currentTimeSec,
    playing,
    loading,
    onEditScene,
    onEditBeat,
    onReorderBeat,
    onRemoveBeat,
    onPickSequenceBeat,
    onSplitIntoScenes,
    onMoveScene,
    onRemoveScene,
    onPreviewScene,
    onSeekPreview
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
        {/* The pre-timeline clip rows. The timeline above is now the view
            of the clips; these stay reachable under a disclosure until the
            clip inspector (plan PR 6) takes over timing / fit / transition. */}
        <details className="szl__advanced" data-testid={`sizzle-clip-rows-${scene.id}`}>
          <summary className="szl__advanced-summary">
            Clip rows <span className="szl__advanced-hint">timing · fit · transition · reorder</span>
          </summary>
          <div className="szl__sequence-beats">
            {beats.map((beat, beatIdx) => (
              <SequenceBeatRow
                key={beat.id}
                beat={beat}
                beatIdx={beatIdx}
                beatCount={beats.length}
                capture={captureMap.get(beat.captureId) ?? null}
                transcriptPhrases={transcriptPhrases}
                onEditBeat={(patch) => onEditBeat(beat.id, patch)}
                onReorderBeat={onReorderBeat}
                onRemoveBeat={() => onRemoveBeat(beat.id)}
              />
            ))}
          </div>
          <div className="szl__scene-hint">
            One voiceover across {beats.length} clip{beats.length === 1 ? "" : "s"}. Clips cut at their anchors; auto clips share the time between anchored neighbours. Phrase anchors use timed transcript words from preview, which can differ from the written script.
          </div>
        </details>
        <SequenceTimelinePreview
          scene={scene}
          captureMap={captureMap}
          plan={plan}
          audioBlob={audioBlob}
          currentTimeSec={currentTimeSec}
          playing={playing}
          loading={loading}
          onPlay={onPreviewScene}
          onSeek={onSeekPreview}
        />
        <div className="szl__scene-row">
          <span className="szl__scene-app">sequence</span>
          <span className="szl__spacer" />
          <button className="szl__scene-mini" onClick={() => onMoveScene(-1)} disabled={idx === 0} type="button" title="Move up">↑</button>
          <button className="szl__scene-mini" onClick={() => onMoveScene(1)} disabled={idx === sceneCount - 1} type="button" title="Move down">↓</button>
          <button className="szl__scene-mini szl__scene-mini--danger" onClick={onRemoveScene} type="button" title="Remove scene">✕</button>
        </div>
      </div>
    </li>
  );
}

function SequenceBeatRow({
  beat,
  beatIdx,
  beatCount,
  capture,
  transcriptPhrases,
  onEditBeat,
  onReorderBeat,
  onRemoveBeat
}: {
  beat: SizzleSequenceBeat;
  beatIdx: number;
  beatCount: number;
  capture: CaptureRecord | null;
  transcriptPhrases: SizzleSequenceTranscriptPhrase[];
  onEditBeat: (patch: Partial<SizzleSequenceBeat>) => void;
  onReorderBeat: (from: number, to: number) => void;
  onRemoveBeat: () => void;
}): ReactElement {
  const beatThumb =
    capture?.edits_version !== undefined
      ? cacheUrl(beat.captureId, 320, "webp", capture.edits_version)
      : cacheUrl(beat.captureId, 320, "webp");
  const timingKind = beat.timing.kind;
  const phraseText = beat.timing.kind === "phrase" ? beat.timing.phrase : "";
  const isFirstBeat = beatIdx === 0;
  const isFinalBeat = beatIdx === beatCount - 1;
  return (
    <div
      className="szl__sequence-beat"
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
      }}
      onDrop={(e) => {
        e.preventDefault();
        const from = Number.parseInt(
          e.dataTransfer.getData("text/plain"),
          10
        );
        if (Number.isInteger(from)) {
          onReorderBeat(from, beatIdx);
        }
      }}
    >
      <span
        className="szl__sequence-beat-grip"
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData("text/plain", String(beatIdx));
          e.dataTransfer.effectAllowed = "move";
        }}
        title="Drag to reorder clips (or use the ↑/↓ buttons)"
        aria-hidden="true"
      >
        ⠿
      </span>
      <span className="szl__sequence-beat-num">{beatIdx + 1}</span>
      <span className="szl__sequence-beat-thumb">
        {capture !== null ? (
          capture.kind === "video" ? (
            <video src={captureSrcUrl(beat.captureId)} muted playsInline preload="metadata" />
          ) : (
            <img src={beatThumb} alt="" />
          )
        ) : (
          <span>missing</span>
        )}
      </span>
      <span className="szl__sequence-beat-title">
        {capture?.source_app_name ?? beat.captureId}
      </span>
      <select
        value={timingKind}
        disabled={isFirstBeat}
        onChange={(e) => {
          const kind = e.target.value as SizzleBeatTiming["kind"];
          onEditBeat({
            timing:
              kind === "offset"
                ? { kind: "offset", startSec: 0, endSec: null }
                : kind === "phrase"
                  ? { kind: "phrase", phrase: "", occurrence: null, offsetSec: 0, durationSec: null }
                  : { kind: "auto" }
          });
        }}
        title={
          isFirstBeat
            ? "The first beat always starts at 0"
            : "When this beat appears: Auto (evenly spaced between anchors), a timed transcript Phrase, or an explicit Offset"
        }
      >
        <option value="auto">Auto</option>
        <option value="offset">Offset</option>
        <option value="phrase">Phrase</option>
      </select>
      {isFirstBeat ? (
        // The first beat is always pinned to 0 by the
        // planner; show that instead of its (inert)
        // anchor inputs — its stored kind is parked.
        <span className="szl__sequence-beat-pinned">starts at 0</span>
      ) : beat.timing.kind === "offset" ? (
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
                onEditBeat({
                  timing: {
                    kind: "offset",
                    startSec: Math.max(0, v),
                    endSec: beat.timing.kind === "offset" ? beat.timing.endSec : null
                  }
                });
              }}
              title={isFirstBeat ? "The first clip always starts at 0" : "Clip start seconds"}
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
                onEditBeat({
                  timing: {
                    kind: "offset",
                    startSec: beat.timing.kind === "offset" ? beat.timing.startSec : 0,
                    endSec: v
                  }
                });
              }}
              title={isFinalBeat ? "Optional final clip end seconds" : "Non-final clips end automatically at the next clip’s anchor"}
            />
          </label>
        </>
      ) : beat.timing.kind === "phrase" ? (
        <>
          <TranscriptPhrasePicker
            currentPhrase={phraseText}
            phrases={transcriptPhrases}
            onSelect={(phrase) =>
              onEditBeat({
                timing: {
                  kind: "phrase",
                  phrase: phrase.text,
                  occurrence: occurrenceForTranscriptPhrase(phrase, transcriptPhrases),
                  offsetSec: beat.timing.kind === "phrase" ? beat.timing.offsetSec : 0,
                  durationSec: beat.timing.kind === "phrase" ? beat.timing.durationSec : null
                }
              })
            }
          />
          <label className="szl__sequence-time-field">
            <span>Offset</span>
            <input
              className="szl__sequence-time"
              type="number"
              step={0.1}
              value={beat.timing.offsetSec}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (!Number.isFinite(v)) return;
                onEditBeat({
                  timing: {
                    kind: "phrase",
                    phrase: beat.timing.kind === "phrase" ? beat.timing.phrase : "",
                    occurrence: beat.timing.kind === "phrase" ? beat.timing.occurrence : null,
                    offsetSec: v,
                    durationSec: beat.timing.kind === "phrase" ? beat.timing.durationSec : null
                  }
                });
              }}
              title="Seconds to shift from the matched phrase start. Negative starts before the phrase; positive starts after it."
            />
          </label>
        </>
      ) : null}
      <select
        value={beat.videoFit}
        onChange={(e) =>
          onEditBeat({
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
          onEditBeat({
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
        onClick={() => onReorderBeat(beatIdx, beatIdx - 1)}
        disabled={beatIdx === 0}
        type="button"
        title="Move clip up"
      >
        ↑
      </button>
      <button
        className="szl__scene-mini"
        onClick={() => onReorderBeat(beatIdx, beatIdx + 1)}
        disabled={beatIdx === beatCount - 1}
        type="button"
        title="Move clip down"
      >
        ↓
      </button>
      <button
        className="szl__scene-mini szl__scene-mini--danger"
        onClick={onRemoveBeat}
        disabled={beatCount <= 1}
        type="button"
        title="Remove clip"
      >
        ✕
      </button>
    </div>
  );
}

// ── Legacy one-capture ("simple") scene ────────────────────────────────

export type SimpleSceneCardProps = {
  scene: SizzleScene;
  idx: number;
  sceneCount: number;
  capture: CaptureRecord | null;
  effectiveAudio: Exclude<SizzleAudioSource, "auto">;
  previewDisabled: boolean;
  previewTitle: string;
  previewLoading: boolean;
  previewing: boolean;
  /** Measured voiceover length from a preview, if any, for the overrun hint. */
  measuredVoiceoverDurationSec: number | undefined;
  onEditScene: (patch: Partial<SizzleScene>) => void;
  onConvertToSequence: () => void;
  onPreviewScene: () => void;
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
    previewDisabled,
    previewTitle,
    previewLoading,
    previewing,
    measuredVoiceoverDurationSec,
    onEditScene,
    onConvertToSequence,
    onPreviewScene,
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
            onClick={onPreviewScene}
            disabled={previewDisabled}
            type="button"
            title={previewTitle}
          >
            {previewLoading ? "…" : previewing ? "■" : "▶"}
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
