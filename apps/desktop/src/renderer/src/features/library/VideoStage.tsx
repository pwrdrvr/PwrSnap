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
import { usePlayheadSource } from "../shared/playhead";
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

// ── how fast the playhead is allowed to move ────────────────────────
//
// PR #446 took React off the playhead path; React is now absent from
// renderer profiles during playback. What was left is not JS at all —
// it is compositor frame production. ANY DOM mutation inside a frame
// makes Chromium produce a compositor frame at that vsync, so a head
// that moves every rAF pins frame production at the DISPLAY's rate
// (120 Hz on ProMotion) instead of the ~48 Hz these VFR screen
// recordings actually decode at. Measured A/B on a real capture, window
// forced visible, display confirmed at 120 fps:
//
//   | variant                            | GPU proc | renderer |
//   | video alone (native loop attr)     |   6.0 %  |   5.2 %  |
//   | + JS seek loop (loop-in-range)     |   7.9 %  |   6.2 %  |
//   | + filmstrip image, head FROZEN     |   8.4 %  |   6.2 %  |
//   | + head moving every rAF (120 Hz)   |  18.1 %  |  14.1 %  |
//   | + head throttled to ~30 Hz         |  11.4 %  |   9.1 %  |
//
// The moving head cost more than decoding and compositing the video
// itself. Raster runs in the GPU process under out-of-process
// rasterization, which is why it lands there and not in the renderer.
//
// Ruled out by measurement — do not retry these:
//   • `will-change: transform` / `translateZ(0)` layer promotion on the
//     head and/or the strip: 19.3 % vs 18.1 %, i.e. nothing.
//   • The rounded border + `overflow: hidden` on `.psl__video-frame`:
//     no measurable effect.
//   • wavesurfer: built with `interact: false`, `cursorWidth: 0`, and
//     never bound to the media element — it is static during playback.

/** Ceiling on head publishes while playing. A 1 px line and a tenths-of-
 *  a-second timecode gain nothing above ~30 Hz. */
const PLAYHEAD_MIN_PUBLISH_MS = 33;

/** Floor, once `requestVideoFrameCallback` is doing the driving. rVFC
 *  fires once per DECODED frame, which is exactly the right rate —
 *  there is no reason to move the head faster than the picture. But
 *  these are VFR screen recordings: a stretch where nothing on screen
 *  moved can go a long time between frames, and the head would visibly
 *  stall even though the clock is running. The rAF loop covers that
 *  gap.
 *
 *  50 ms, NOT the 100 ms the timecode's own tenths resolution suggests:
 *  sampling a signal at its own period cannot reproduce it. rAF is
 *  quantized to vsync, so a 100 ms floor yields real gaps of 100–108 ms,
 *  which beat against `floor(sec * 10)` and drop a tenth outright every
 *  couple of seconds — the readout visibly jumps 0:04.1 → 0:04.3. Two
 *  publishes per tenth is the cheapest rate that always lands one. */
const PLAYHEAD_MAX_GAP_MS = 50;

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
  // `currentTime` is the DISCRETE head — seek, pause, capture switch.
  // The per-frame head rides `playhead` instead, straight to the two
  // DOM nodes that draw it, because re-rendering this subtree at 60 Hz
  // is the single largest renderer cost of a playing video. See
  // `shared/playhead.ts` and
  // docs/solutions/2026-08-20-video-stage-playhead-cpu.md.
  const [currentTime, setCurrentTime] = useState(0);
  const playhead = usePlayheadSource();
  const [stripWidth, setStripWidth] = useState(0);
  const shuttleRef = useRef<{ direction: -1 | 1; rate: number; raf: number; last: number } | null>(
    null
  );

  const { range, setRange } = trim;
  const rangeRef = useRef(range);
  rangeRef.current = range;
  const loopRef = useRef(loopInRange);
  loopRef.current = loopInRange;

  // Whole-clip loops wrap in the media pipeline via the element's own
  // `loop` attribute — no JS seek per iteration, and (the reason this
  // exists) no dependence on the rAF wrap observing the end at all.
  //
  // The wrap below fires at `range.end - 5 ms`, and `range.end` comes
  // from the persisted `durationSec`, which is WALL-CLOCK elapsed
  // recording time (`recording-service.ts`), not the encoded media
  // duration. Wall clock always runs long — recorder startup, the
  // dropped tail, the final partial GOP — so for a real recording the
  // threshold sits PAST where the media actually ends and the rAF tick
  // never reaches it. Measured on a 2 s file whose row claimed 2.3 s:
  // loop-in-range played once and parked at the end, paused.
  //
  // Exact bounds, deliberately, rather than `isFullRange`: that 50 ms
  // tolerance is for the "FULL CLIP" label, not for playback. Native
  // looping always wraps the WHOLE media, so adopting it for a range
  // trimmed a few px inside the ends would silently discard those
  // in/out points. Every whole-clip range the app produces
  // (`fullRange`, the recorder's seed) is exact, so the common case
  // still gets it; anything hand-trimmed falls to the wrap + the
  // `ended` recovery below.
  const nativeLoop = loopInRange && range.start <= 0 && range.end >= durationSec;
  const nativeLoopRef = useRef(nativeLoop);
  nativeLoopRef.current = nativeLoop;

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

  /** Publish a discrete head position to BOTH channels. Every
   *  non-playback move goes through here so the two never drift. */
  const publishTime = useCallback(
    (sec: number): void => {
      const t = roundTime(clampTime(sec, durationSec));
      playhead.set(t);
      setCurrentTime(t);
    },
    [durationSec, playhead]
  );

  /** Settle React state on whatever the element landed on. Called
   *  wherever continuous motion stops — the rAF loops only publish to
   *  `playhead`, so without this the discrete head would stay wherever
   *  playback began. */
  const settleTime = useCallback((): void => {
    const el = videoRef.current;
    if (el === null) return;
    publishTime(el.currentTime);
  }, [publishTime]);

  const seek = useCallback(
    (sec: number): void => {
      const el = videoRef.current;
      const t = roundTime(clampTime(sec, durationSec));
      if (el !== null) el.currentTime = t;
      publishTime(t);
    },
    [durationSec, publishTime]
  );

  const pause = useCallback((): void => {
    stopShuttle();
    const el = videoRef.current;
    if (el !== null) {
      el.pause();
      el.playbackRate = 1;
    }
    setPlaying(false);
    settleTime();
  }, [settleTime, stopShuttle]);

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
    // Publish the snap BEFORE handing off to the element. If `play()`
    // rejects — a decode failure on a damaged capture, an autoplay
    // block — no `play` event fires, neither frame loop below starts,
    // and nothing else would ever correct the head; the transport would
    // go on reading the pre-snap position while the element sits at the
    // in-point.
    //
    // Straight through `settleTime`, not the loop's throttled
    // `publish`: that rate limit is scoped to the playback effect and
    // governs continuous motion. A discrete jump must never be
    // swallowed.
    settleTime();
    void el.play().catch(() => undefined);
  }, [durationSec, settleTime, stopShuttle]);

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
        playhead.set(roundTime(next));
        if (next <= 0) {
          shuttleRef.current = null;
          settleTime();
          return;
        }
        s.raf = requestAnimationFrame(tick);
      };
      shuttleRef.current = { direction, rate, raf: requestAnimationFrame(tick), last: 0 };
    },
    [playhead, playing, settleTime, stopShuttle]
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
    const onPause = (): void => {
      setPlaying(false);
      settleTime();
    };
    const onEnded = (): void => {
      // Same drift as above, for a TRIMMED range whose out-point is the
      // clip end: the rAF wrap can't reach `range.end`, so the media
      // ends first and loop-in-range would just stop. Wrap here instead.
      // (A full-clip loop never gets here — `loop` is on the element.)
      //
      // The target is checked against the ELEMENT's duration, not the
      // persisted one, precisely because the two disagree. A `start`
      // past the real end clamps straight back to the end and re-fires
      // `ended`, so an unguarded replay spins: measured 61 `ended` /
      // 62 `play()` calls in 6 s against a 2 s file whose row claimed
      // 12.5 s. `el.duration` is NaN until metadata loads, hence the
      // fallback.
      const wrapTo = rangeRef.current.start;
      const mediaEnd = Number.isFinite(el.duration) ? el.duration : Number.POSITIVE_INFINITY;
      if (loopRef.current && shuttleRef.current === null && wrapTo < mediaEnd - 0.01) {
        el.currentTime = wrapTo;
        playhead.set(roundTime(wrapTo));
        void el.play().catch(() => undefined);
        return;
      }
      setPlaying(false);
      stopShuttle();
      settleTime();
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
  }, [captureId, playhead, settleTime, stopShuttle]);

  // Smooth playhead: a frame loop while playing (timeupdate is ~4 Hz),
  // plus the loop-in-range wrap.
  //
  // Two rates, deliberately, and they are not the same rate:
  //
  //   • The WRAP CHECK runs every animation frame. It has to — being a
  //     frame late on the out-point is visible — and it costs nothing
  //     at the compositor because setting `el.currentTime` mutates the
  //     media pipeline, not the DOM.
  //   • The PUBLISH is throttled. It is the only thing here that
  //     touches the DOM, and that is what drives the whole rendering
  //     pipeline — see `PLAYHEAD_MIN_PUBLISH_MS`.
  //
  // Publishes to `playhead` ONLY. `setCurrentTime` here re-rendered the
  // transport and the timeline — ~180 elements, one tick span per
  // minute of source — on every animation frame; the two subscribers
  // write their own nodes instead. React state settles on `pause` /
  // `ended` / seek.
  useEffect(() => {
    const el = videoRef.current;
    if (el === null || !playing) return;

    let raf = 0;
    let vfc = 0;
    let lastPublishMs = Number.NEGATIVE_INFINITY;
    // Flips on the first `requestVideoFrameCallback`, after which the
    // rAF loop stops publishing except to cover a gap. Latching on the
    // callback rather than on feature detection matters: rVFC EXISTS on
    // every Chromium `HTMLVideoElement` but only FIRES when frames are
    // actually being presented. Detecting the method and handing it the
    // job would stall the head wherever it doesn't fire (jsdom, a
    // suspended surface, an element with no decodable frames).
    let vfcDriving = false;

    /** Publish unless one landed less than `minGapMs` ago. `0` forces —
     *  used for discrete jumps, which must never be swallowed. */
    const publish = (nowMs: number, sec: number, minGapMs: number): void => {
      if (nowMs - lastPublishMs < minGapMs) return;
      lastPublishMs = nowMs;
      playhead.set(roundTime(sec));
    };

    const tick = (nowMs: number): void => {
      const r = rangeRef.current;
      let t = el.currentTime;
      if (!nativeLoopRef.current && loopRef.current && t >= r.end - 0.005) {
        el.currentTime = r.start;
        // The wrap is a discrete jump, not continuous motion — a
        // throttled head would keep drawing the far end for a beat
        // after the picture had already snapped back.
        publish(nowMs, r.start, 0);
      } else {
        publish(nowMs, t, vfcDriving ? PLAYHEAD_MAX_GAP_MS : PLAYHEAD_MIN_PUBLISH_MS);
      }
      raf = requestAnimationFrame(tick);
    };

    const onVideoFrame = (nowMs: number): void => {
      vfcDriving = true;
      // Deliberately `el.currentTime`, not the callback's
      // `meta.mediaTime`. rVFC's value here is WHEN it fires — once per
      // presented frame, which is what limits the rate to the media's —
      // not what it reports. `mediaTime` is the truer head by less than
      // one frame, which is below what a 1 px line and a tenths
      // timecode can show, and trusting it needs a staleness heuristic:
      // a frame decoded just before a loop wrap arrives AFTER the wrap
      // put the head back at the in-point, so publishing its
      // `mediaTime` flicks the head to the far end. Any magnitude
      // threshold for that stops working once the trimmed range is
      // shorter than the threshold, and `MIN_RANGE_SEC` is 0.1 s.
      publish(nowMs, el.currentTime, PLAYHEAD_MIN_PUBLISH_MS);
      vfc = el.requestVideoFrameCallback(onVideoFrame);
    };

    raf = requestAnimationFrame(tick);
    if (typeof el.requestVideoFrameCallback === "function") {
      vfc = el.requestVideoFrameCallback(onVideoFrame);
    }
    return () => {
      cancelAnimationFrame(raf);
      if (vfc !== 0 && typeof el.cancelVideoFrameCallback === "function") {
        el.cancelVideoFrameCallback(vfc);
      }
    };
  }, [playhead, playing]);

  // Capture switch: reset transient state.
  useEffect(() => {
    stopShuttle();
    setPlaying(false);
    setCurrentTime(0);
    playhead.set(0);
  }, [captureId, playhead, stopShuttle]);

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
          loop={nativeLoop}
          onClick={() => runIntent({ type: "togglePlay" })}
          onDoubleClick={toggleFullscreen}
        />
      </div>
      <VideoTransport
        playing={playing}
        currentTime={currentTime}
        playhead={playhead}
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
        playhead={playhead}
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
