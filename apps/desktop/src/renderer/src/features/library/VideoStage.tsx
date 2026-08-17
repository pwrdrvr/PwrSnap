// Video stage — the `kind === "video"` arm of the Library Focus / Reel
// stage. Replaces the bare `<video controls>` with:
//
//   • a chromeless <video> (our transport, no ⋮ download / PiP menu),
//   • `VideoTransport` (play/pause · timecode · loop-in-range · mute ·
//     fullscreen) with key hints in the button titles,
//   • `VideoTimeline` (filmstrip + waveform + playhead + in/out handles),
//   • a keyboard model (space, J/K/L, ←/→ frame, ⇧←/⇧→ 1 s, I/O,
//     Home/End) that is active only while the stage has focus and no
//     text input does — see `video-transport-keys.ts`.
//
// The trim range is owned by `useVideoTrimRange` (local + debounced
// `video:setDefaultRange`), instantiated ONCE at the Library level and
// passed in as `trim` — the DetailRail's export cards read that same
// live object, so a click during the persist debounce can't export a
// stale range.
//
// Plan: docs/plans/2026-08-15-001-feat-video-transport-trim-plan.md

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement
} from "react";
import type { CaptureRecord, VideoCaptureMetadata } from "@pwrsnap/shared";
import { captureSrcUrl } from "../../lib/pwrsnap";
import { VideoTimeline } from "../shared/VideoTimeline";
import { useVideoTimelineAssets } from "../shared/useVideoTimelineAssets";
import type { UseVideoTrimRange } from "../shared/useVideoTrimRange";
import {
  clampTime,
  DEFAULT_FRAME_STEP_SEC,
  formatTimecode,
  MIN_RANGE_SEC,
  roundTime,
  stepTime
} from "../shared/video-range";
import { VideoTransport } from "./VideoTransport";
import {
  isTextEntryTarget,
  nextShuttleRate,
  transportIntentForKey,
  type TransportIntent
} from "./video-transport-keys";

export type VideoStageProps = {
  record: CaptureRecord;
  video: VideoCaptureMetadata;
  /** The window's shared trim-range instance (Library owns it; the
   *  DetailRail's export cards read the same object). Deliberately NOT
   *  instantiated here: a stage-local copy leaves the rail exporting
   *  the persisted `defaultRange`, which lags the timeline by the
   *  persist debounce plus an IPC round-trip. */
  trim: UseVideoTrimRange;
  /** True in Reel mode. Reel is a BROWSING surface — ←/→ walk the
   *  filmstrip between captures — so the stage does not grab focus on
   *  mount there. Focus mode is a single-capture surface with nothing
   *  else competing for the keyboard, so it still autofocuses and the
   *  transport owns the arrows immediately.
   *
   *  Frame stepping is not lost in Reel: the stage's keydown handler
   *  only runs when focus is already inside it, and one click on the
   *  video puts it there (see `onPointerDownCapture`). Until then the
   *  keydown targets `document.body`, never reaches this subtree, and
   *  the Library's window-level handler navigates as it should. */
  reel?: boolean;
};

const FILM_LANE_H = 56;

export function VideoStage({
  record,
  video,
  trim,
  reel = false
}: VideoStageProps): ReactElement {
  const captureId = record.id;
  const durationSec = video.durationSec;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [loopInRange, setLoopInRange] = useState(true);
  const [currentTime, setCurrentTime] = useState(0);
  const [stripWidth, setStripWidth] = useState(0);
  const shuttleRef = useRef<{ direction: -1 | 1; rate: number; raf: number; last: number } | null>(
    null
  );

  const { range, setRange } = trim;
  const rangeRef = useRef(range);
  rangeRef.current = range;
  const loopRef = useRef(loopInRange);
  loopRef.current = loopInRange;

  const assets = useVideoTimelineAssets({
    captureId,
    stripWidthPx: stripWidth,
    laneHeightPx: FILM_LANE_H,
    sourceWidthPx: record.width_px,
    sourceHeightPx: record.height_px,
    wantAudio: true,
    hasAudioTrack: video.hasSystemAudio || video.hasMicrophoneAudio
  });

  // ── playback plumbing ───────────────────────────────────────────────

  const stopShuttle = useCallback((): void => {
    const s = shuttleRef.current;
    if (s !== null) {
      cancelAnimationFrame(s.raf);
      shuttleRef.current = null;
    }
  }, []);

  const seek = useCallback(
    (sec: number): void => {
      const el = videoRef.current;
      const t = roundTime(clampTime(sec, durationSec));
      if (el !== null) el.currentTime = t;
      setCurrentTime(t);
    },
    [durationSec]
  );

  const pause = useCallback((): void => {
    stopShuttle();
    const el = videoRef.current;
    if (el !== null) {
      el.pause();
      el.playbackRate = 1;
    }
    setPlaying(false);
  }, [stopShuttle]);

  const play = useCallback((): void => {
    stopShuttle();
    const el = videoRef.current;
    if (el === null) return;
    const r = rangeRef.current;
    // Play from the in-point when the head sits outside the range with
    // loop-in-range on, or when parked at the very end.
    if (loopRef.current && (el.currentTime < r.start - 0.01 || el.currentTime >= r.end - 0.01)) {
      el.currentTime = r.start;
    } else if (el.currentTime >= durationSec - 0.01) {
      el.currentTime = loopRef.current ? r.start : 0;
    }
    el.playbackRate = 1;
    void el.play().catch(() => undefined);
  }, [durationSec, stopShuttle]);

  // Scrubbing the timeline (body scrub or a trim handle) pauses for the
  // duration of the gesture and restores playback on release. Without
  // this, a drag started while playing fights itself — the element keeps
  // advancing between the seeks, so the frame under the handle is never
  // the frame you're looking at and the playhead wanders off on its own.
  // Deliberately keyed off the element's own `playing` state, so a drag
  // started while paused stays paused.
  const resumeAfterDragRef = useRef(false);
  const playingRef = useRef(playing);
  playingRef.current = playing;
  const [pendingResume, setPendingResume] = useState(false);
  const onTimelineInteracting = useCallback(
    (interacting: boolean): void => {
      if (interacting) {
        resumeAfterDragRef.current = playingRef.current;
        pause();
        return;
      }
      if (!resumeAfterDragRef.current) return;
      resumeAfterDragRef.current = false;
      setPendingResume(true);
    },
    [pause]
  );

  // Resume AFTER the commit, never inline in the drag-end callback.
  // `play()`'s loop-in-range check reads `rangeRef`, which is assigned
  // during render — so in the same synchronous tick it still holds the
  // range as of the last commit. That matters for Escape-cancel, which
  // restores the range and ends the drag in one tick: playing inline
  // would test the head against the ABANDONED range and snap it to the
  // in-point the user just backed out of.
  useEffect(() => {
    if (!pendingResume) return;
    setPendingResume(false);
    play();
  }, [pendingResume, play]);

  // Reverse shuttle emulation: Chromium doesn't honor negative
  // playbackRate, so J steps `currentTime` backwards each frame.
  const shuttle = useCallback(
    (direction: -1 | 1): void => {
      const el = videoRef.current;
      if (el === null) return;
      const rate = nextShuttleRate(
        shuttleRef.current === null
          ? playing && direction === 1
            ? { direction: 1, rate: el.playbackRate }
            : null
          : { direction: shuttleRef.current.direction, rate: shuttleRef.current.rate },
        direction
      );
      stopShuttle();
      if (direction === 1) {
        el.playbackRate = rate;
        if (el.paused) void el.play().catch(() => undefined);
        shuttleRef.current = { direction, rate, raf: 0, last: 0 };
        return;
      }
      el.pause();
      const tick = (now: number): void => {
        const s = shuttleRef.current;
        if (s === null || s.direction !== -1) return;
        const dt = s.last === 0 ? 0 : (now - s.last) / 1000;
        s.last = now;
        const next = Math.max(0, el.currentTime - dt * s.rate);
        el.currentTime = next;
        setCurrentTime(roundTime(next));
        if (next <= 0) {
          shuttleRef.current = null;
          return;
        }
        s.raf = requestAnimationFrame(tick);
      };
      shuttleRef.current = { direction, rate, raf: requestAnimationFrame(tick), last: 0 };
    },
    [playing, stopShuttle]
  );

  const runIntent = useCallback(
    (intent: TransportIntent): void => {
      const el = videoRef.current;
      const now = el?.currentTime ?? currentTime;
      switch (intent.type) {
        case "togglePlay": {
          const isPlaying = el !== null ? !el.paused : playing;
          if (isPlaying || shuttleRef.current !== null) pause();
          else play();
          return;
        }
        case "pause":
          pause();
          return;
        case "shuttle":
          shuttle(intent.direction);
          return;
        case "step":
          pause();
          seek(stepTime(now, intent.frames * DEFAULT_FRAME_STEP_SEC, durationSec));
          return;
        case "seekBy":
          seek(stepTime(now, intent.seconds, durationSec));
          return;
        case "setIn": {
          // In past the current out drags out along (keeps MIN gap).
          const start = roundTime(now);
          setRange({ start, end: Math.max(rangeRef.current.end, start + MIN_RANGE_SEC) }, true);
          return;
        }
        case "setOut": {
          const end = roundTime(now);
          setRange({ start: Math.min(rangeRef.current.start, end - MIN_RANGE_SEC), end }, true);
          return;
        }
        case "seekStart":
          seek(0);
          return;
        case "seekEnd":
          pause();
          seek(durationSec);
          return;
        default:
          return;
      }
    },
    [currentTime, durationSec, pause, play, playing, seek, setRange, shuttle]
  );

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (isTextEntryTarget(e.target)) return;
    // A focused transport button keeps native space/enter activation.
    if ((e.key === " " || e.key === "Enter") && (e.target as HTMLElement).tagName === "BUTTON") return;
    const intent = transportIntentForKey(e);
    if (intent === null) return;
    e.preventDefault();
    e.stopPropagation();
    runIntent(intent);
  };

  // Element event → state.
  useEffect(() => {
    const el = videoRef.current;
    if (el === null) return;
    const onPlay = (): void => setPlaying(true);
    const onPause = (): void => setPlaying(false);
    const onEnded = (): void => {
      setPlaying(false);
      stopShuttle();
    };
    const onLoaded = (): void => {
      setMuted(el.muted);
    };
    el.addEventListener("play", onPlay);
    el.addEventListener("pause", onPause);
    el.addEventListener("ended", onEnded);
    el.addEventListener("loadedmetadata", onLoaded);
    return () => {
      el.removeEventListener("play", onPlay);
      el.removeEventListener("pause", onPause);
      el.removeEventListener("ended", onEnded);
      el.removeEventListener("loadedmetadata", onLoaded);
    };
  }, [captureId, stopShuttle]);

  // Smooth playhead: rAF while playing (timeupdate is ~4 Hz), plus the
  // loop-in-range wrap.
  useEffect(() => {
    const el = videoRef.current;
    if (el === null || !playing) return;
    let raf = 0;
    const tick = (): void => {
      const r = rangeRef.current;
      let t = el.currentTime;
      if (loopRef.current && t >= r.end - 0.005) {
        el.currentTime = r.start;
        t = r.start;
      }
      setCurrentTime(roundTime(t));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  // Capture switch: reset transient state.
  useEffect(() => {
    stopShuttle();
    setPlaying(false);
    setCurrentTime(0);
  }, [captureId, stopShuttle]);

  // Focus the stage on mount so the keyboard model is live immediately
  // — Focus mode ONLY. Focus is a single-capture surface with nothing
  // else that wants focus, so claiming the arrows is free there.
  //
  // Reel is not: it's a browsing surface whose whole point is walking
  // captures with ←/→ (Library's window keydown handler). Autofocusing
  // here handed every arrow press to the transport — the stage's
  // handler `stopPropagation`s a matched intent, and React's root-
  // container delegation means that stops the native event before it
  // reaches the window listener — so prev/next-capture navigation died
  // the moment a video scrolled into the reel. Frame stepping still
  // works in Reel once the user clicks into the video, which focuses
  // the root and routes keydowns through this subtree.
  useEffect(() => {
    if (reel) return;
    rootRef.current?.focus({ preventScroll: true });
  }, [captureId, reel]);

  useEffect(() => () => stopShuttle(), [stopShuttle]);

  const toggleMute = (): void => {
    const el = videoRef.current;
    if (el === null) return;
    el.muted = !el.muted;
    setMuted(el.muted);
  };

  const toggleFullscreen = (): void => {
    const el = videoRef.current;
    if (el === null) return;
    if (document.fullscreenElement !== null) {
      void document.exitFullscreen().catch(() => undefined);
      return;
    }
    void el.requestFullscreen?.().catch(() => undefined);
  };

  const onStripWidth = useCallback((w: number) => setStripWidth(w), []);

  return (
    <div
      ref={rootRef}
      className="psl__video-stage"
      tabIndex={0}
      onKeyDown={onKeyDown}
      onPointerDownCapture={() => {
        // Clicking anywhere in the stage arms the keyboard model.
        const root = rootRef.current;
        if (root !== null && !root.contains(document.activeElement)) {
          root.focus({ preventScroll: true });
        }
      }}
      aria-label={`Video player, ${formatTimecode(durationSec)}`}
      data-testid="video-stage"
    >
      <div className="psl__video-frame">
        <video
          ref={videoRef}
          className="psl__video-el"
          src={captureSrcUrl(captureId)}
          playsInline
          preload="metadata"
          onClick={() => runIntent({ type: "togglePlay" })}
          onDoubleClick={toggleFullscreen}
        />
      </div>
      <VideoTransport
        playing={playing}
        currentTime={currentTime}
        durationSec={durationSec}
        loopInRange={loopInRange}
        muted={muted}
        onTogglePlay={() => runIntent({ type: "togglePlay" })}
        onToggleLoop={() => setLoopInRange((v) => !v)}
        onToggleMute={toggleMute}
        onFullscreen={toggleFullscreen}
      />
      <VideoTimeline
        durationSec={durationSec}
        currentTime={currentTime}
        range={range}
        frames={assets.frames}
        audioBlob={assets.audioBlob}
        onSeek={(sec) => {
          seek(sec);
        }}
        onRangeChange={setRange}
        onWidthChange={onStripWidth}
        onInteractingChange={onTimelineInteracting}
        label="Recording timeline"
      />
    </div>
  );
}
