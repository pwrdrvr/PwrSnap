// The clip inspector — the right-rail drawer for the selected clip (plan
// §4.6): beside the chat, never replacing it. Timing (auto · word ·
// offset), the transition INTO the clip — type AND duration, the
// per-boundary duration the model always carried but the UI never reached
// (plan §4.7 defect 3) — video fit, reorder, remove. It replaces the
// pre-timeline form rows: the timeline is the view of the clips, the
// inspector is where a selected clip's details live.
//
// Every edit is one `onEditBeat` patch — the same path the timeline's
// word-click and drags take — so undo, the debounced write, and the live
// sync all behave the same whichever surface made the change.

import type { ReactElement } from "react";
import {
  SIZZLE_TRANSITIONS,
  sizzleTransitionDurationSec,
  sizzleTransitionType,
  type CaptureRecord,
  type SizzleBeatTiming,
  type SizzleSequenceBeat,
  type SizzleSequenceTranscriptPhrase,
  type SizzleTransitionType,
  type SizzleVideoFitPolicy
} from "@pwrsnap/shared";
import { cacheUrl } from "../../lib/pwrsnap";
import { formatSpan, formatTimecode, roundTime } from "../shared/video-range";
import { TranscriptPhrasePicker } from "./TranscriptPhrasePicker";
import {
  occurrenceForPhraseAtTime,
  occurrenceForTranscriptPhrase,
  TRANSITION_TYPE_LABELS,
  transitionWithType
} from "./sizzle-helpers";
import { anchorTimingForWord, nearestWordAnchor } from "./timeline/anchor";
import type { TimelineClip, TimelineSceneRegion } from "./timeline/timeline-model";

/** Transition durations the inspector accepts (seconds). */
export const TRANSITION_DURATION_MIN_SEC = 0.05;
export const TRANSITION_DURATION_MAX_SEC = 2;

const FIT_LABELS: ReadonlyArray<[SizzleVideoFitPolicy, string]> = [
  ["smart-fit", "Smart"],
  ["loop", "Loop"],
  ["ping-pong", "Ping-pong"],
  ["speed-to-fit", "Speed to fit"],
  ["freeze-end", "Freeze end"],
  ["trim", "Trim"]
];

export type ClipInspectorProps = {
  clip: TimelineClip;
  scene: TimelineSceneRegion;
  beat: SizzleSequenceBeat;
  capture: CaptureRecord | null;
  transcriptPhrases: SizzleSequenceTranscriptPhrase[];
  onEditBeat: (patch: Partial<SizzleSequenceBeat>) => void;
  onReorder: (delta: -1 | 1) => void;
  onRemove: () => void;
  onClose: () => void;
};

export function ClipInspector(props: ClipInspectorProps): ReactElement {
  const { clip, scene, beat, capture, transcriptPhrases, onEditBeat, onReorder, onRemove, onClose } = props;
  const name = capture?.source_app_name ?? "Capture";
  const clipCount = scene.clips.length;
  const isFirst = clip.index === 0;
  const isFinal = clip.index === clipCount - 1;
  const timing = beat.timing;
  const tilde = clip.exact ? "" : "~";

  // Switching the timing kind pins the clip WHERE IT IS — to the nearest
  // word (+ residual) when there is a transcript, to an offset at its
  // current start otherwise — rather than resetting it to 0 / an empty
  // phrase. "Word" with no transcript yet is an empty phrase the picker
  // fills in once the narration is synthesized.
  const setKind = (next: SizzleBeatTiming["kind"]): void => {
    if (next === timing.kind) return;
    if (next === "auto") {
      onEditBeat({ timing: { kind: "auto" } });
      return;
    }
    if (next === "offset") {
      onEditBeat({ timing: { kind: "offset", startSec: roundTime(clip.localStartSec), endSec: null } });
      return;
    }
    const near = nearestWordAnchor(scene.words, clip.localStartSec);
    onEditBeat({
      timing:
        near === null
          ? { kind: "phrase", phrase: "", occurrence: null, offsetSec: 0, durationSec: null }
          : anchorTimingForWord(scene.words, near.wordIndex, roundTime(near.offsetSec))
    });
  };

  const transitionType = sizzleTransitionType(beat.transition);
  const transitionSec = sizzleTransitionDurationSec(beat.transition);
  const hardCut = transitionType === "cut" || transitionType === "none";

  return (
    <section className="szl__insp" aria-label={`Clip ${clip.index + 1} inspector`} data-testid="sizzle-clip-inspector">
      <header className="szl__insp-head">
        <span className="szl__insp-eyebrow">
          Clip {clip.index + 1} of {clipCount}
        </span>
        <span className="szl__insp-name" title={name}>
          {name}
        </span>
        <button
          type="button"
          className="szl__insp-close"
          onClick={onClose}
          aria-label="Close inspector"
          title="Close inspector (click bare track or press Esc)"
          data-testid="sizzle-inspector-close"
        >
          ✕
        </button>
      </header>

      <div className="szl__insp-body">
        <div className="szl__insp-cap">
          <ClipPoster clip={clip} capture={capture} />
          <div className="szl__insp-cap-text">
            <div className="szl__insp-cap-title">{name}</div>
            <div className="szl__insp-cap-meta" data-testid="sizzle-inspector-window">
              {capture?.kind === "video" ? "video" : "screenshot"} · on screen {tilde}
              {formatSpan(clip.durationSec)} · {formatTimecode(clip.startSec)} → {formatTimecode(clip.endSec)}
            </div>
          </div>
        </div>

        {/* ── Timing ── */}
        <div className="szl__insp-field">
          <span className="szl__insp-label">Timing</span>
          {isFirst ? (
            <p className="szl__insp-hint" data-testid="sizzle-inspector-pinned">
              Pinned at 0:00.0 — the first clip always starts with the narration.
            </p>
          ) : (
            <div className="szl__insp-seg" role="group" aria-label="Clip timing">
              {(
                [
                  ["auto", "Auto"],
                  ["phrase", "Word"],
                  ["offset", "Offset"]
                ] as const
              ).map(([kind, label]) => (
                <button
                  key={kind}
                  type="button"
                  className={timing.kind === kind ? "is-on" : ""}
                  aria-pressed={timing.kind === kind}
                  onClick={() => setKind(kind)}
                  data-testid={`sizzle-inspector-timing-${kind}`}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
          {!isFirst && timing.kind === "auto" ? (
            <p className="szl__insp-hint">
              Slots evenly between its anchored neighbours. Drag the clip, or click a word in the
              ribbon, to pin it.
            </p>
          ) : null}
          {!isFirst && timing.kind === "phrase" ? (
            <>
              <TranscriptPhrasePicker
                currentPhrase={timing.phrase}
                phrases={transcriptPhrases}
                onSelect={(phrase) =>
                  onEditBeat({
                    timing: {
                      kind: "phrase",
                      phrase: phrase.text,
                      // Count it the way the planner will resolve it; fall
                      // back to the exact-text count only when this scene has
                      // no transcript words to match against.
                      occurrence:
                        occurrenceForPhraseAtTime(scene.words, phrase.text, phrase.startSec) ??
                        occurrenceForTranscriptPhrase(phrase, transcriptPhrases),
                      offsetSec: timing.offsetSec,
                      durationSec: timing.durationSec
                    }
                  })
                }
              />
              <label className="szl__insp-num">
                <span>Offset</span>
                <input
                  type="number"
                  step={0.05}
                  value={timing.offsetSec}
                  onChange={(e) => {
                    // `Number("")` is 0, not NaN, and an <input type=number>
                    // reports "" for any transiently-unparseable entry — so
                    // without this the first keystroke of "-0.5" commits 0
                    // and wipes the sign.
                    const raw = e.target.value.trim();
                    if (raw === "") return;
                    const v = Number(raw);
                    if (!Number.isFinite(v)) return;
                    onEditBeat({ timing: { ...timing, offsetSec: v } });
                  }}
                  title="Seconds to shift from the matched word. Negative starts before it; positive after."
                  data-testid="sizzle-inspector-offset"
                />
                <i>s</i>
              </label>
              <p className="szl__insp-hint">
                {clip.unresolved
                  ? "Unresolved — the phrase does not occur in the transcript, so the clip is placed as auto until it does."
                  : clip.pendingAnchor
                    ? "Resolves once the narration is synthesized."
                    : `Starts at ${formatTimecode(clip.localStartSec)} in the narration · survives re-synthesis.`}{" "}
                Phrase anchors use timed transcript words from preview, which can differ from the written
                script.
              </p>
            </>
          ) : null}
          {!isFirst && timing.kind === "offset" ? (
            <>
              <div className="szl__insp-row">
                <label className="szl__insp-num">
                  <span>Start</span>
                  <input
                    type="number"
                    min={0}
                    step={0.1}
                    value={timing.startSec}
                    onChange={(e) => {
                      const raw = e.target.value.trim();
                      if (raw === "") return; // see the Offset field above
                      const v = Number(raw);
                      if (!Number.isFinite(v)) return;
                      onEditBeat({ timing: { ...timing, startSec: Math.max(0, v) } });
                    }}
                    title="Clip start, seconds into the narration"
                    data-testid="sizzle-inspector-start"
                  />
                  <i>s</i>
                </label>
                {isFinal ? (
                  <label className="szl__insp-num">
                    <span>End</span>
                    <input
                      type="number"
                      min={0}
                      step={0.1}
                      placeholder="auto"
                      value={timing.endSec ?? ""}
                      onChange={(e) => {
                        const raw = e.target.value.trim();
                        const v = raw === "" ? null : Number(raw);
                        if (v !== null && !Number.isFinite(v)) return;
                        onEditBeat({ timing: { ...timing, endSec: v } });
                      }}
                      title="Optional end for the final clip; blank runs to the end of the narration"
                      data-testid="sizzle-inspector-end"
                    />
                    <i>s</i>
                  </label>
                ) : null}
              </div>
              <p className="szl__insp-hint">
                A fixed time in the narration. Offsets do not follow the words if the narration is
                re-synthesized — prefer a word anchor.
                {isFinal ? "" : " Runs to the next clip's anchor."}
              </p>
            </>
          ) : null}
        </div>

        {/* ── Transition into this clip ── */}
        {!isFirst ? (
          <div className="szl__insp-field">
            <span className="szl__insp-label">Transition into this clip</span>
            <div className="szl__insp-row">
              <select
                value={transitionType}
                onChange={(e) =>
                  onEditBeat({
                    transition: transitionWithType(beat.transition, e.target.value as SizzleTransitionType)
                  })
                }
                aria-label="Transition type"
                data-testid="sizzle-inspector-transition"
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
                    onEditBeat({
                      transition: {
                        type: transitionType,
                        durationSec: Math.min(TRANSITION_DURATION_MAX_SEC, Math.max(TRANSITION_DURATION_MIN_SEC, v))
                      }
                    });
                  }}
                  title={hardCut ? "A cut has no duration" : "How long the transition takes, in seconds"}
                  data-testid="sizzle-inspector-transition-duration"
                />
                <i>s</i>
              </label>
            </div>
          </div>
        ) : null}

        {/* ── Video fit ── */}
        {capture?.kind === "video" ? (
          <div className="szl__insp-field">
            <span className="szl__insp-label">Video fit</span>
            <select
              value={beat.videoFit}
              onChange={(e) => onEditBeat({ videoFit: e.target.value as SizzleVideoFitPolicy })}
              aria-label="Video fit"
              data-testid="sizzle-inspector-fit"
            >
              {FIT_LABELS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>
        ) : null}
      </div>

      <footer className="szl__insp-foot">
        <button
          type="button"
          className="szl__scene-mini"
          onClick={() => onReorder(-1)}
          disabled={isFirst}
          title="Move clip earlier"
          data-testid="sizzle-inspector-move-earlier"
        >
          ◀
        </button>
        <button
          type="button"
          className="szl__scene-mini"
          onClick={() => onReorder(1)}
          disabled={isFinal}
          title="Move clip later"
          data-testid="sizzle-inspector-move-later"
        >
          ▶
        </button>
        <span className="szl__spacer" />
        <button
          type="button"
          className="szl__scene-mini szl__scene-mini--danger szl__insp-remove"
          onClick={onRemove}
          disabled={clipCount <= 1}
          title={clipCount <= 1 ? "A scene keeps at least one clip" : "Remove clip"}
          data-testid="sizzle-inspector-remove"
        >
          Remove clip
        </button>
      </footer>
    </section>
  );
}

function ClipPoster({ clip, capture }: { clip: TimelineClip; capture: CaptureRecord | null }): ReactElement {
  if (capture !== null && capture.kind === "video") {
    return (
      <span className="szl__insp-thumb szl__insp-thumb--video" aria-hidden="true">
        ▶
      </span>
    );
  }
  const src =
    capture !== null
      ? cacheUrl(clip.captureId, 320, "webp", capture.edits_version)
      : cacheUrl(clip.captureId, 320, "webp");
  return (
    <span className="szl__insp-thumb" aria-hidden="true">
      <img src={src} alt="" draggable={false} loading="lazy" decoding="async" />
    </span>
  );
}

