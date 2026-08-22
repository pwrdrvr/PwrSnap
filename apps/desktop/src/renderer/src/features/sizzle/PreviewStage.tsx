// Per-scene preview stage for a sequence scene: the player (image or
// video of the active beat), transport, a read-only proportional strip
// over the narration waveform, and the preview's warnings. The
// horizontal timeline (plan PR 3) takes over the strip; the stage stays.
//
// Fidelity (plan §4.7 / PR 7): the stage is TWO layers. The active beat is
// the outgoing layer; in the last `d` seconds before a beat with a
// fade-like transition, that next beat is drawn on top as the incoming
// layer and the two blend with a CSS animation shaped like the export's
// xfade (fade · dip to black / white · cover-left push · slide · zoom).
// Image beats carry the export's Ken Burns (zoompan 1.0 ↔ 1.10) as a
// CSS animation too. Both animations are driven by the scene time: their
// negative `animation-delay` is the elapsed time, and they run only while
// the scene plays — so a scrub lands on the exact frame and playback is
// smooth between audio ticks. Good enough to judge a timing decision; not
// pixel parity with ffmpeg.

import { useEffect, useRef, type ReactElement, type RefObject } from "react";
import type {
  CaptureRecord,
  SizzleScene,
  SizzleSequenceBeat,
  SizzleSequencePreviewBeat,
  SizzleSequencePreviewPlan
} from "@pwrsnap/shared";
import { SequenceWaveform } from "../shared/SequenceWaveform";
import { StageLayer } from "./StageLayer";
import { beatVisualWindow, kenBurnsDirection, stageFrameAt, type StageBlend } from "./preview-blend";
import {
  fallbackSequenceBeats,
  SEQUENCE_WAVE_BARS,
  sequencePreviewVideoState
} from "./sequence-plan";
import {
  clampTime,
  formatDur,
  formatSequencePreviewWarnings,
  transitionLabel
} from "./sizzle-helpers";

export function SequenceTimelinePreview(props: {
  scene: SizzleScene;
  captureMap: Map<string, CaptureRecord>;
  plan: SizzleSequencePreviewPlan | undefined;
  audioBlob: Blob | undefined;
  currentTimeSec: number;
  playing: boolean;
  loading: boolean;
  onPlay: () => void;
  onSeek: (timeSec: number) => void;
}): ReactElement {
  const { scene, captureMap, plan, audioBlob, currentTimeSec, playing, loading, onPlay, onSeek } = props;
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const fallbackBeats = fallbackSequenceBeats(scene);
  const beats = plan?.beats ?? fallbackBeats;
  const fallbackDuration = Math.max(
    1,
    scene.durationOverrideSec ?? fallbackBeats.at(-1)?.endSec ?? fallbackBeats.length
  );
  const durationSec = Math.max(0.1, plan?.durationSec ?? fallbackDuration);
  const timeSec = clampTime(currentTimeSec, durationSec);
  const frame = stageFrameAt(beats, timeSec);
  const activeIndex = frame.activeIndex;
  const activeBeat = activeIndex >= 0 ? (beats[activeIndex] ?? null) : null;
  const incomingBeat = frame.blend === null ? null : (beats[frame.blend.incomingIndex] ?? null);
  const activeCapture =
    activeBeat === null ? null : captureMap.get(activeBeat.captureId) ?? null;
  const barCount = SEQUENCE_WAVE_BARS;
  const playheadLeft = `${(timeSec / durationSec) * 100}%`;
  const activeSceneBeat =
    activeBeat === null
      ? null
      : (scene.beats ?? []).find((beat) => beat.id === activeBeat.beatId) ?? null;
  // The export extends a fade-in beat's VISUAL at its head by the overlap,
  // so its video has already run `overlap` seconds by the audio start.
  // Offset the timeline time the same way so the frame matches the render.
  const activeHeadShiftSec =
    activeBeat === null ? 0 : activeBeat.startSec - beatVisualWindow(activeBeat, activeIndex).startSec;
  const activeVideoState =
    activeBeat !== null && activeCapture !== null && activeSceneBeat !== null
      ? sequencePreviewVideoState({
          beat: activeBeat,
          sceneBeat: activeSceneBeat,
          capture: activeCapture,
          timelineTimeSec: timeSec + activeHeadShiftSec
        })
      : null;
  const activeVideoBeatId = activeVideoState?.beatId ?? null;
  const shouldPlayActiveVideo = playing && (activeVideoState?.shouldPlay ?? true);

  useEffect(() => {
    const video = videoRef.current;
    if (video === null) return;
    if (!shouldPlayActiveVideo) {
      video.pause();
      return;
    }
    void video.play().catch(() => undefined);
    return () => {
      video.pause();
    };
  }, [shouldPlayActiveVideo, activeVideoBeatId]);

  useEffect(() => {
    const video = videoRef.current;
    if (video === null || activeVideoState === null) return;
    try {
      video.playbackRate = activeVideoState.playbackRate;
      const driftSec = Math.abs(video.currentTime - activeVideoState.sourceTimeSec);
      if (!shouldPlayActiveVideo || driftSec > 0.12) {
        video.currentTime = activeVideoState.sourceTimeSec;
      }
    } catch {
      // Metadata may not be ready yet. The next audio tick / beat change
      // will retry, and the render path remains authoritative.
    }
  }, [
    activeVideoState?.beatId,
    activeVideoState?.playbackRate,
    activeVideoState?.shouldPlay,
    activeVideoState?.sourceTimeSec,
    shouldPlayActiveVideo
  ]);
  const displayWarnings = formatSequencePreviewWarnings(
    plan?.warnings ?? [],
    beats.map((beat) => beat.beatId)
  );

  const seekFromPointer = (clientX: number, target: HTMLElement): void => {
    const rect = target.getBoundingClientRect();
    const ratio = rect.width <= 0 ? 0 : (clientX - rect.left) / rect.width;
    onSeek(clampTime(ratio * durationSec, durationSec));
  };

  return (
    <div className="szl__sequence-preview">
      <div className="szl__sequence-preview-stage" data-testid="sizzle-preview-stage">
        {activeBeat === null ? (
          <span className="szl__sequence-preview-empty">No clips</span>
        ) : (
          <>
            <SceneStageLayer
              key={`out:${activeBeat.beatId}`}
              role="outgoing"
              beat={activeBeat}
              index={activeIndex}
              capture={activeCapture}
              sceneBeat={activeSceneBeat}
              timeSec={timeSec}
              playing={playing}
              blend={frame.blend}
              videoRef={videoRef}
            />
            {frame.blend !== null && incomingBeat !== null ? (
              <SceneStageLayer
                key={`in:${incomingBeat.beatId}`}
                role="incoming"
                beat={incomingBeat}
                index={frame.blend.incomingIndex}
                capture={captureMap.get(incomingBeat.captureId) ?? null}
                sceneBeat={(scene.beats ?? []).find((b) => b.id === incomingBeat.beatId) ?? null}
                timeSec={timeSec}
                playing={playing}
                blend={frame.blend}
                videoRef={null}
              />
            ) : null}
          </>
        )}
      </div>
      <div className="szl__sequence-preview-controls">
        <button
          className="szl__scene-mini szl__scene-mini--play"
          onClick={onPlay}
          disabled={loading || scene.scriptLine.trim().length === 0}
          type="button"
          title={scene.scriptLine.trim().length === 0 ? "Write narration to preview" : "Preview scene"}
        >
          {loading ? "…" : playing ? "■" : "▶"}
        </button>
        <button
          className="szl__scene-mini"
          onClick={() => onSeek(0)}
          type="button"
          title="Seek to start"
        >
          ↤
        </button>
        <span className="szl__sequence-preview-time">
          {formatDur(timeSec)} / {formatDur(durationSec)}
        </span>
        <span className="szl__spacer" />
        <span className="szl__sequence-preview-quality">
          {plan === undefined
            ? "unresolved"
            : plan.timingQuality === "precise"
              ? "word timing"
              : "approx timing"}
        </span>
      </div>
      <button
        className="szl__sequence-timeline"
        type="button"
        onClick={(event) => seekFromPointer(event.clientX, event.currentTarget)}
        aria-label="Scene timeline"
      >
        {audioBlob === undefined ? (
          // No narration decoded yet — a flat dim baseline (no fabricated
          // variation) until a preview runs and wavesurfer takes over.
          <span className="szl__sequence-wave szl__sequence-wave--idle" aria-hidden="true">
            {Array.from({ length: barCount }, (_, index) => (
              <span key={index} style={{ height: "10%" }} />
            ))}
          </span>
        ) : (
          <SequenceWaveform audioBlob={audioBlob} />
        )}
        <span className="szl__sequence-track" aria-hidden="true">
          {beats.map((beat, index) => {
            const left = (beat.startSec / durationSec) * 100;
            const width = Math.max(1, ((beat.endSec - beat.startSec) / durationSec) * 100);
            const capture = captureMap.get(beat.captureId);
            const isActive = activeBeat?.beatId === beat.beatId;
            return (
              <span
                key={beat.beatId}
                className={"szl__sequence-track-beat" + (isActive ? " is-active" : "")}
                style={{ left: `${left}%`, width: `${width}%` }}
              >
                <span>{index + 1}</span>
                <small>{capture?.source_app_name ?? "Capture"}</small>
                {index > 0 ? <em>{transitionLabel(beat.transition)}</em> : null}
              </span>
            );
          })}
        </span>
        <span className="szl__sequence-playhead" style={{ left: playheadLeft }} aria-hidden="true" />
      </button>
      {displayWarnings.length ? (
        <div className="szl__sequence-warnings">
          {displayWarnings.slice(0, 3).map((warning) => (
            <span key={warning.key}>
              <strong>{warning.label}:</strong> {warning.message}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** Adapter: turns a scene-local beat into the shared stage layer's props.
 *  The layer itself is shared with the reel player so the two surfaces
 *  cannot draw the same clip differently. */
function SceneStageLayer({
  role,
  beat,
  index,
  capture,
  sceneBeat,
  timeSec,
  playing,
  blend,
  videoRef
}: {
  role: "outgoing" | "incoming";
  beat: SizzleSequencePreviewBeat;
  index: number;
  capture: CaptureRecord | null;
  /** The stored beat, for a trim the preview plan may not carry. */
  sceneBeat: SizzleSequenceBeat | null;
  timeSec: number;
  playing: boolean;
  blend: StageBlend | null;
  videoRef: RefObject<HTMLVideoElement | null> | null;
}): ReactElement {
  const visual = beatVisualWindow(beat, index);
  const visualDurationSec = Math.max(0.05, visual.endSec - visual.startSec);
  const isVideo = capture !== null && capture.kind === "video";
  return (
    <StageLayer
      role={role}
      captureId={beat.captureId}
      capture={capture}
      kenBurns={isVideo ? null : kenBurnsDirection(index)}
      kenBurnsDurationSec={visualDurationSec}
      kenBurnsElapsedSec={timeSec - visual.startSec}
      blend={
        blend === null
          ? null
          : { type: blend.type, durationSec: blend.durationSec, elapsedSec: timeSec - blend.startSec }
      }
      playing={playing}
      videoRef={videoRef ?? undefined}
      // The trim the export will cut to. `fallbackSequenceBeats` never sets
      // `mediaTrim`, so without the stored beat's copy an untrimmed first
      // frame blends in and then pops to the real one.
      posterStartSec={beat.mediaTrim?.startSec ?? sceneBeat?.mediaTrim?.startSec ?? 0}
      dataBeat={beat.beatId}
      testId={`sizzle-preview-${role}`}
    />
  );
}
