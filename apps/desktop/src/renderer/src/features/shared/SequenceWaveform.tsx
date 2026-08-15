// Display-only audio waveform rendered with wavesurfer.js (BSD-3-Clause).
// Shared by the Sizzle sequence timeline (narration) and the Library
// video timeline (source clip audio). wavesurfer owns decode → peak
// extraction → canvas render; we keep it non-interactive (no clicks,
// no cursor) and the callers overlay their own playhead / handles.
//
// Loaded by dynamic import so it is code-split out of the initial
// bundle and so jsdom unit tests (no canvas / ResizeObserver) never
// touch it. Canvas can't read CSS vars, so the accent is resolved from
// the document at mount so the waveform tracks the theme.

import { useEffect, useRef, type ReactElement } from "react";

export type SequenceWaveformProps = {
  audioBlob: Blob;
  /** Bar height in px. Sizzle uses 24; the Library timeline lane is 24 too. */
  height?: number | undefined;
  className?: string | undefined;
};

export function SequenceWaveform({
  audioBlob,
  height = 24,
  className = "szl__sequence-wave-surfer"
}: SequenceWaveformProps): ReactElement {
  const containerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    let instance: import("wavesurfer.js").default | null = null;
    let cancelled = false;
    void (async () => {
      try {
        const { default: WaveSurfer } = await import("wavesurfer.js");
        if (cancelled || containerRef.current === null) return;
        const accent =
          getComputedStyle(document.documentElement)
            .getPropertyValue("--accent")
            .trim() || "#ff8a1f";
        instance = WaveSurfer.create({
          container: containerRef.current,
          height,
          barWidth: 2,
          barGap: 2,
          barRadius: 2,
          waveColor: accent,
          progressColor: accent,
          cursorWidth: 0,
          interact: false,
          normalize: true
        });
        await instance.loadBlob(audioBlob);
      } catch {
        // jsdom (no canvas) or a decode failure — the caller's idle
        // baseline stays in place rather than a fabricated waveform.
      }
    })();
    return () => {
      cancelled = true;
      try {
        instance?.destroy();
      } catch {
        // Already torn down; nothing to clean up.
      }
    };
  }, [audioBlob, height]);
  return <div ref={containerRef} className={className} aria-hidden="true" />;
}
