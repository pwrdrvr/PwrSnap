// Native <video> with a hover-to-play behaviour layered on top of
// the browser's standard controls. Mouse-enter calls `.play()`;
// mouse-leave pauses without rewinding so the next hover resumes
// from where the user left off. The `muted` attribute is required
// for `.play()` to succeed without a prior user gesture (Chromium
// blocks unmuted programmatic playback under the autoplay policy);
// users who want sound can click the volume control in the native
// chrome.
//
// Shared between the post-capture float-over toast and the tray
// popover's "last recording" preview so the two surfaces feel
// like siblings.
//
// Takes the CAPTURE, not a URL, and resolves what to load itself. Both
// consumers render native controls over a `muted` element, so both are one
// click from audible — and a recording whose audible track is not the one a
// player takes needs a prepared rendition or it plays silence. Owning that
// here is what keeps the two surfaces from drifting: this is the audible
// preview component, so the resolution cannot be forgotten at a call site.

import { useCallback, useEffect, useRef, type ReactElement } from "react";
import type { RecordedAudioTrackFacts } from "@pwrsnap/shared";
import { useVideoPlaybackSrc } from "./useVideoPlaybackSrc";

export type HoverAutoplayVideoProps = {
  /** The recording to play. */
  captureId: string;
  /**
   * Its recorded audio track facts, used to decide whether resolving the
   * playback URL is worth a round trip at all. `null` when the capture
   * carries no video metadata — then the capture URL is all there is.
   */
  video: RecordedAudioTrackFacts | null | undefined;
  /** Optional style overrides; defaults fill the parent and
   *  letterbox the source via `object-fit: contain` on a black
   *  background. */
  style?: React.CSSProperties;
  /** Optional handle on the underlying element so a caller can drive
   *  `currentTime` — the float-over uses it to park the preview on the
   *  frame under the trim handle being dragged. */
  videoRef?: React.MutableRefObject<HTMLVideoElement | null> | undefined;
};

const DEFAULT_STYLE: React.CSSProperties = {
  width: "100%",
  height: "100%",
  objectFit: "contain",
  display: "block",
  background: "#000"
};

export function HoverAutoplayVideo({
  captureId,
  video,
  style,
  videoRef: externalVideoRef
}: HoverAutoplayVideoProps): ReactElement {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  // Where to put the user back after a playback-URL swap.
  //
  // Assigning `src` runs the media load algorithm: the element stops and
  // rewinds to 0, and fires no `pause`. Just pausing is not enough here —
  // preparing a rendition can take seconds on a large recording, so the
  // swap routinely lands while someone is already watching, and the hover
  // listeners are on the CONTAINER, so no `mouseenter` re-fires to restart
  // it while the pointer sits still. Without this the preview dies at
  // frame 0 until the user leaves and comes back.
  const resumeAfterSwapRef = useRef<{ time: number; playing: boolean } | null>(null);
  const src = useVideoPlaybackSrc({
    captureId,
    video,
    onBeforeSwap: () => {
      const el = videoRef.current;
      if (el === null) return;
      resumeAfterSwapRef.current = { time: el.currentTime, playing: !el.paused };
    }
  });
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Restore across the swap. `loadedmetadata` is the first point the new
  // source can accept a seek.
  useEffect(() => {
    const el = videoRef.current;
    if (el === null) return;
    const onLoaded = (): void => {
      const resume = resumeAfterSwapRef.current;
      resumeAfterSwapRef.current = null;
      if (resume === null) return;
      if (resume.time > 0) el.currentTime = resume.time;
      if (resume.playing) void el.play().catch(() => undefined);
    };
    el.addEventListener("loadedmetadata", onLoaded);
    return () => el.removeEventListener("loadedmetadata", onLoaded);
  }, []);

  // Mirror the element into the caller's ref so both the internal
  // hover-play effect and the caller see the same node.
  //
  // Memoized because React detaches and reattaches a ref whose identity
  // changed on every render — and the float-over re-renders at 60 Hz
  // while its auto-dismiss countdown ticks, which would mean 60
  // null-then-element round trips per second through both refs.
  const setVideoEl = useCallback(
    (el: HTMLVideoElement | null): void => {
      videoRef.current = el;
      if (externalVideoRef !== undefined) externalVideoRef.current = el;
    },
    [externalVideoRef]
  );

  useEffect(() => {
    const container = containerRef.current;
    const video = videoRef.current;
    if (container === null || video === null) return;
    const onEnter = (): void => {
      // Swallow the autoplay-policy rejection — if Chromium blocks
      // playback for any reason (e.g. document not yet activated),
      // the native controls still let the user start manually.
      void video.play().catch(() => undefined);
    };
    const onLeave = (): void => {
      video.pause();
    };
    container.addEventListener("mouseenter", onEnter);
    container.addEventListener("mouseleave", onLeave);
    return () => {
      container.removeEventListener("mouseenter", onEnter);
      container.removeEventListener("mouseleave", onLeave);
    };
  }, []);

  return (
    <div
      ref={containerRef}
      data-hover-autoplay
      style={{ width: "100%", height: "100%", display: "block" }}
    >
      <video
        ref={setVideoEl}
        src={src}
        controls
        playsInline
        muted
        preload="metadata"
        style={{ ...DEFAULT_STYLE, ...(style ?? {}) }}
      />
    </div>
  );
}
