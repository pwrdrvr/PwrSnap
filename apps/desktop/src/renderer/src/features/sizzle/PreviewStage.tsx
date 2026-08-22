// Per-scene preview stage for a sequence scene: the player (image or
// video of the active beat), transport, a read-only proportional strip
// over the narration waveform, and the preview's warnings. The
// horizontal timeline (plan PR 3) takes over the strip; the stage stays.

import { useEffect, useRef, type ReactElement } from "react";
import type { CaptureRecord, SizzleScene, SizzleSequencePreviewPlan } from "@pwrsnap/shared";
import { cacheUrl, captureSrcUrl } from "../../lib/pwrsnap";
import { SequenceWaveform } from "../shared/SequenceWaveform";
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
  const activeBeat =
    beats.find((beat) => timeSec >= beat.startSec && timeSec < beat.endSec) ??
    beats.at(-1) ??
    null;
  const activeCapture =
    activeBeat === null ? null : captureMap.get(activeBeat.captureId) ?? null;
  const activeThumb =
    activeCapture?.edits_version !== undefined && activeBeat !== null
      ? cacheUrl(activeBeat.captureId, 800, "webp", activeCapture.edits_version)
      : activeBeat !== null
        ? cacheUrl(activeBeat.captureId, 800, "webp")
        : "";
  const barCount = SEQUENCE_WAVE_BARS;
  const playheadLeft = `${(timeSec / durationSec) * 100}%`;
  const activeSceneBeat =
    activeBeat === null
      ? null
      : (scene.beats ?? []).find((beat) => beat.id === activeBeat.beatId) ?? null;
  const activeVideoState =
    activeBeat !== null && activeCapture !== null && activeSceneBeat !== null
      ? sequencePreviewVideoState({
          beat: activeBeat,
          sceneBeat: activeSceneBeat,
          capture: activeCapture,
          timelineTimeSec: timeSec
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
      <div className="szl__sequence-preview-stage">
        {activeBeat === null ? (
          <span className="szl__sequence-preview-empty">No clips</span>
        ) : activeCapture?.kind === "video" ? (
          <video
            ref={videoRef}
            key={activeBeat.beatId}
            src={captureSrcUrl(activeBeat.captureId)}
            muted
            playsInline
          />
        ) : activeCapture !== null ? (
          <img src={activeThumb} alt="" />
        ) : (
          <span className="szl__sequence-preview-empty">Missing capture</span>
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
