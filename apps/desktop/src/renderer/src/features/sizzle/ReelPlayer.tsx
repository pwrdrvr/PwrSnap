// The reel player: a stage for the WHOLE reel plus its transport, sitting
// directly above the timeline that scrubs it.
//
// This is the surface the editor was missing. The preview stage lived
// inside a sequence scene's card and a legacy one-capture scene had none
// at all, so the only way to watch a reel end to end was Render → Reveal
// in Finder. Now ▶ walks the project axis, the stage shows what the
// export will show (clip transitions AND scene transitions, Ken Burns),
// and the Render button lives here too — next to the thing it renders,
// rather than a scroll away at the bottom of the scene list.
//
// Rendering discipline (the reason this file has a subscription instead
// of a `playheadSec` prop): the head moves at display refresh, and this
// subtree sits next to 80 clips and a word ribbon. React state is told
// only about DISCRETE changes — which clip is on screen — while the head
// itself travels on a `PlayheadSource` and the timecode + the CSS
// animations follow it without a re-render. Same rule, and the same
// measured reason, as features/shared/playhead.ts.

import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import type { CaptureRecord, SizzleSequenceBeat } from "@pwrsnap/shared";
import type { PlayheadSource } from "../shared/playhead";
import { formatTimecode } from "../shared/video-range";
import { StageLayer } from "./StageLayer";
import { kenBurnsDirection } from "./preview-blend";
import { flattenReelClips, reelClipProgress, reelFrameAt, type ReelClip, type ReelFrame } from "./reel-frame";
import { sequencePreviewVideoState } from "./sequence-plan";
import type { ReelPlayback } from "./useReelPlayback";
import type { TimelineModel } from "./timeline/timeline-model";

export function ReelPlayer({
  model,
  captureMap,
  beatById,
  head,
  playback,
  renderLabel,
  renderDisabled,
  renderTitle,
  onRender
}: {
  model: TimelineModel;
  captureMap: Map<string, CaptureRecord>;
  /** Stored beats by id — a video clip's trim and fit policy live there,
   *  and the stage needs them to play the right span at the right rate. */
  beatById: Map<string, SizzleSequenceBeat>;
  head: PlayheadSource;
  playback: ReelPlayback;
  /** e.g. "Render · ~0:14"; null while the reel has no renderable length. */
  renderLabel: string | null;
  renderDisabled: boolean;
  renderTitle: string | undefined;
  onRender: () => void;
}): ReactElement {
  const clips = useMemo(() => flattenReelClips(model), [model]);
  const playing = playback.playing;
  // `sec` is the head position at the moment the FRAME last changed — the
  // anchor the CSS animations were seeked from, not a live clock.
  const [view, setView] = useState<{ frame: ReelFrame; sec: number }>(() => ({
    frame: reelFrameAt(clips, head.get()),
    sec: head.get()
  }));

  useEffect(
    () =>
      head.subscribe((sec) => {
        setView((prev) => {
          const next = reelFrameAt(clips, sec);
          // While playing, a frame with the same identity needs no re-render:
          // the browser is advancing the transition and the Ken Burns on its
          // own. While paused (a scrub), every position must re-seek them.
          if (playing && sameFrameIdentity(prev.frame, next)) return prev;
          return { frame: next, sec };
        });
      }),
    [clips, head, playing]
  );

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const { frame, sec } = view;
  const active = frame.activeIndex >= 0 ? clips[frame.activeIndex] : undefined;
  const incoming = frame.blend === null ? undefined : clips[frame.blend.incomingIndex];
  const totalLabel = `${model.exact ? "" : "~"}${formatTimecode(model.totalSec)}`;

  // A video clip on stage is a REAL player, honouring the same fit policy the
  // export applies (loop / ping-pong / speed / freeze). Before the per-scene
  // stage was retired this logic lived there; the reel player is its only
  // home now, so a video clip would otherwise sit on one frozen frame.
  const activeCapture = active === undefined ? null : captureMap.get(active.clip.captureId) ?? null;
  const activeSceneBeat = active === undefined ? undefined : beatById.get(active.clip.beatId);
  const videoState =
    active !== undefined && activeCapture !== null && activeCapture.kind === "video" && activeSceneBeat !== undefined
      ? sequencePreviewVideoState({
          beat: {
            beatId: active.clip.beatId,
            captureId: active.clip.captureId,
            startSec: active.clip.localStartSec,
            endSec: active.clip.localEndSec,
            timing: active.clip.timing,
            transition: active.clip.transition,
            videoFit: active.clip.videoFit
          },
          sceneBeat: activeSceneBeat,
          capture: activeCapture,
          // Scene-local time: `sequencePreviewVideoState` works on the scene
          // axis the beat windows are expressed in.
          timelineTimeSec: sec - (model.scenes[active.sceneIndex]?.startSec ?? 0)
        })
      : null;
  const shouldPlayVideo = playing && (videoState?.shouldPlay ?? true);
  const videoBeatId = videoState?.beatId ?? null;
  useEffect(() => {
    const el = videoRef.current;
    if (el === null) return;
    if (!shouldPlayVideo) {
      el.pause();
      return;
    }
    void el.play().catch(() => undefined);
    return () => el.pause();
  }, [shouldPlayVideo, videoBeatId]);
  useEffect(() => {
    const el = videoRef.current;
    if (el === null || videoState === null) return;
    try {
      el.playbackRate = videoState.playbackRate;
      if (!shouldPlayVideo || Math.abs(el.currentTime - videoState.sourceTimeSec) > 0.12) {
        el.currentTime = videoState.sourceTimeSec;
      }
    } catch {
      // Metadata not ready; the next tick re-seeks.
    }
  }, [videoState?.beatId, videoState?.playbackRate, videoState?.sourceTimeSec, shouldPlayVideo]);

  return (
    <section className="szl__reel" aria-label="Reel player" data-testid="sizzle-reel-player">
      <div className="szl__reel-stage" data-testid="sizzle-reel-stage">
        {active === undefined ? (
          <span className="szl__sequence-preview-empty">No clips yet</span>
        ) : (
          <>
            <StageLayer
              key={`out:${active.clip.beatId}`}
              role="outgoing"
              captureId={active.clip.captureId}
              capture={captureMap.get(active.clip.captureId) ?? null}
              kenBurns={
                captureMap.get(active.clip.captureId)?.kind === "video"
                  ? null
                  : kenBurnsDirection(active.reelIndex)
              }
              kenBurnsDurationSec={Math.max(0.05, active.endSec - active.startSec)}
              kenBurnsElapsedSec={reelClipProgress(active, sec) * (active.endSec - active.startSec)}
              blend={
                frame.blend === null
                  ? null
                  : {
                      type: frame.blend.type,
                      durationSec: frame.blend.durationSec,
                      elapsedSec: sec - frame.blend.startSec
                    }
              }
              playing={playing}
              videoRef={videoRef}
              dataBeat={active.clip.beatId}
              testId="sizzle-reel-outgoing"
            />
            {frame.blend !== null && incoming !== undefined ? (
              <StageLayer
                key={`in:${incoming.clip.beatId}`}
                role="incoming"
                captureId={incoming.clip.captureId}
                capture={captureMap.get(incoming.clip.captureId) ?? null}
                kenBurns={
                  captureMap.get(incoming.clip.captureId)?.kind === "video"
                    ? null
                    : kenBurnsDirection(incoming.reelIndex)
                }
                kenBurnsDurationSec={Math.max(0.05, incoming.endSec - incoming.startSec)}
                kenBurnsElapsedSec={Math.max(0, sec - incoming.startSec)}
                posterStartSec={posterStartSecFor(incoming, beatById)}
                blend={{
                  type: frame.blend.type,
                  durationSec: frame.blend.durationSec,
                  elapsedSec: sec - frame.blend.startSec
                }}
                playing={playing}
                dataBeat={incoming.clip.beatId}
                testId="sizzle-reel-incoming"
              />
            ) : null}
          </>
        )}
      </div>

      <div className="szl__reel-transport">
        <button
          type="button"
          className="szl__reel-play"
          onClick={playback.toggle}
          disabled={model.totalSec <= 0}
          title={playing ? "Pause" : "Play the whole reel"}
          aria-label={playing ? "Pause reel" : "Play reel"}
          data-testid="sizzle-reel-play"
        >
          {playing ? "■" : "▶"}
        </button>
        <span className="szl__reel-time" data-testid="sizzle-reel-time">
          <PlayheadClock head={head} />
          <span className="szl__reel-total"> / {totalLabel}</span>
        </span>
        {active !== undefined ? (
          <span className="szl__reel-where" data-testid="sizzle-reel-where">
            Scene {active.sceneIndex + 1} · clip {active.clip.index + 1}
          </span>
        ) : null}
        <button
          type="button"
          className={"szl__reel-mute" + (playback.muted ? " is-muted" : "")}
          onClick={playback.toggleMuted}
          title={playback.muted ? "Unmute" : "Mute"}
          aria-label={playback.muted ? "Unmute reel" : "Mute reel"}
          aria-pressed={playback.muted}
          data-testid="sizzle-reel-mute"
        >
          {playback.muted || playback.volume === 0 ? "\u{1F507}" : "\u{1F509}"}
        </button>
        <input
          className="szl__reel-volume"
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={playback.muted ? 0 : playback.volume}
          onChange={(event) => playback.setVolume(Number(event.target.value))}
          title="Narration volume"
          aria-label="Narration volume"
          data-testid="sizzle-reel-volume"
        />
        {!playback.activeSceneHasAudio ? (
          // Say WHY it is silent. Estimated scenes have no audio file in
          // existence, and a clip-audio scene has none to preview — without
          // this the player just looks broken.
          <span className="szl__reel-silent" data-testid="sizzle-reel-silent">
            no narration audio
          </span>
        ) : null}
        <span className="szl__spacer" />
        <button
          className="szl__btn-primary"
          onClick={onRender}
          type="button"
          disabled={renderDisabled}
          title={renderTitle}
          data-testid="sizzle-render"
        >
          {renderLabel ?? "Render"}
        </button>
      </div>
    </section>
  );
}

/** The running timecode, written straight to the DOM so a moving head
 *  never re-renders the player. */
function PlayheadClock({ head }: { head: PlayheadSource }): ReactElement {
  const ref = useRef<HTMLElement | null>(null);
  useEffect(
    () =>
      head.subscribe((sec) => {
        const el = ref.current;
        if (el !== null) el.textContent = formatTimecode(sec);
      }),
    [head]
  );
  return <b ref={ref}>{formatTimecode(head.get())}</b>;
}

/** Where an incoming video's still should sit: the frame the export cuts to. */
function posterStartSecFor(clip: ReelClip, beatById: Map<string, SizzleSequenceBeat>): number {
  return beatById.get(clip.clip.beatId)?.mediaTrim?.startSec ?? 0;
}

function sameFrameIdentity(a: ReelFrame, b: ReelFrame): boolean {
  if (a.activeIndex !== b.activeIndex) return false;
  if ((a.blend === null) !== (b.blend === null)) return false;
  return a.blend === null || b.blend === null || a.blend.incomingIndex === b.blend.incomingIndex;
}
