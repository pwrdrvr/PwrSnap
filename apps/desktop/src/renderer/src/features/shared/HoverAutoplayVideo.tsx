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

import { useEffect, useRef, type ReactElement } from "react";

export type HoverAutoplayVideoProps = {
  src: string;
  /** Optional style overrides; defaults fill the parent and
   *  letterbox the source via `object-fit: contain` on a black
   *  background. */
  style?: React.CSSProperties;
};

const DEFAULT_STYLE: React.CSSProperties = {
  width: "100%",
  height: "100%",
  objectFit: "contain",
  display: "block",
  background: "#000"
};

export function HoverAutoplayVideo({ src, style }: HoverAutoplayVideoProps): ReactElement {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

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
        ref={videoRef}
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
