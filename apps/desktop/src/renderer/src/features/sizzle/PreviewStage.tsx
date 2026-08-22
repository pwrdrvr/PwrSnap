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

import { useEffect, useRef, type CSSProperties, type ReactElement, type RefObject } from "react";
import type {
  CaptureRecord,
  SizzleScene,
  SizzleSequencePreviewBeat,
  SizzleSequencePreviewPlan
} from "@pwrsnap/shared";
import { cacheUrl, captureSrcUrl } from "../../lib/pwrsnap";
import { SequenceWaveform } from "../shared/SequenceWaveform";
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
            <StageLayer
              key={`out:${activeBeat.beatId}`}
              role="outgoing"
              beat={activeBeat}
              index={activeIndex}
              capture={activeCapture}
              timeSec={timeSec}
              playing={playing}
              blend={frame.blend}
              videoRef={videoRef}
            />
            {frame.blend !== null && incomingBeat !== null ? (
              <StageLayer
                key={`in:${incomingBeat.beatId}`}
                role="incoming"
                beat={incomingBeat}
                index={frame.blend.incomingIndex}
                capture={captureMap.get(incomingBeat.captureId) ?? null}
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

/** A CSS animation parked at `elapsedSec` into a `durationSec` run: a
 *  negative delay seeks it, and it only runs while the scene plays. */
function timedAnimation(name: string, durationSec: number, elapsedSec: number, playing: boolean): CSSProperties {
  const dur = Math.max(0.05, durationSec);
  const at = Math.min(dur, Math.max(0, elapsedSec));
  return {
    animationName: name,
    animationDuration: `${dur.toFixed(3)}s`,
    animationDelay: `-${at.toFixed(3)}s`,
    animationTimingFunction: "linear",
    animationFillMode: "both",
    animationPlayState: playing ? "running" : "paused"
  };
}

/** One stage layer: the outgoing (active) beat, or the incoming beat
 *  blending in. The layer carries the transition animation; an image
 *  inside carries Ken Burns; a video inside is the real player for the
 *  outgoing layer and a first-frame stand-in for the incoming one. */
function StageLayer({
  role,
  beat,
  index,
  capture,
  timeSec,
  playing,
  blend,
  videoRef
}: {
  role: "outgoing" | "incoming";
  beat: SizzleSequencePreviewBeat;
  index: number;
  capture: CaptureRecord | null;
  timeSec: number;
  playing: boolean;
  blend: StageBlend | null;
  videoRef: RefObject<HTMLVideoElement | null> | null;
}): ReactElement {
  const visual = beatVisualWindow(beat, index);
  const visualDurationSec = Math.max(0.05, visual.endSec - visual.startSec);
  const elapsedSec = timeSec - visual.startSec;
  const blendStyle =
    blend !== null
      ? timedAnimation(`szl-xf-${role}-${blend.type}`, blend.durationSec, timeSec - blend.startSec, playing)
      : undefined;
  const isVideo = capture !== null && capture.kind === "video";
  const kb = capture !== null && !isVideo ? kenBurnsDirection(index) : null;
  const thumb =
    capture !== null
      ? cacheUrl(beat.captureId, 800, "webp", capture.edits_version)
      : cacheUrl(beat.captureId, 800, "webp");
  let media: ReactElement;
  if (capture === null) {
    media = <span className="szl__sequence-preview-empty">Missing capture</span>;
  } else if (isVideo) {
    media =
      role === "outgoing" && videoRef !== null ? (
        <video ref={videoRef} key={beat.beatId} src={captureSrcUrl(beat.captureId)} muted playsInline />
      ) : (
        // The incoming video's first frame: a paused player parked at its
        // source start (media fragment), never played from here.
        <video
          key={`in:${beat.beatId}`}
          src={`${captureSrcUrl(beat.captureId)}#t=${(beat.mediaTrim?.startSec ?? 0).toFixed(3)}`}
          muted
          playsInline
          preload="metadata"
        />
      );
  } else {
    media = (
      <img
        src={thumb}
        alt=""
        draggable={false}
        style={kb !== null ? timedAnimation(`szl-kb-${kb}`, visualDurationSec, elapsedSec, playing) : undefined}
        data-kb={kb ?? undefined}
      />
    );
  }
  return (
    <div
      className={
        `szl__sequence-preview-layer is-${role}` +
        (blend !== null ? ` is-${blend.type}` : "")
      }
      style={blendStyle}
      data-testid={`sizzle-preview-${role}`}
      data-beat={beat.beatId}
      data-progress={blend !== null ? blend.progress.toFixed(3) : undefined}
    >
      {media}
    </div>
  );
}
