// Fetches the filmstrip descriptor (`video:frames`) and the audio Blob
// (`video:audio` → fetch → Blob) for a video timeline. Shared by the
// Library video stage and the float-over mini-trim so both size their
// requests the same way and hit the same on-disk cache.
//
// Frames are re-requested when the strip width or lane height changes
// enough to change the quantized (count, frameWidth) spec — main
// quantizes too, so most resizes are cache hits.

import { useEffect, useMemo, useState } from "react";
import type { VideoFramesResult } from "@pwrsnap/shared";
import { dispatch } from "../../lib/pwrsnap";

export type VideoTimelineAssets = {
  frames: VideoFramesResult | null;
  /** `undefined` while loading, `null` when the clip has no audio. */
  audioBlob: Blob | null | undefined;
};

/** Mirror of main's quantization so we don't churn requests on
 *  sub-step width changes. Keep in sync with recording/video-frames.ts. */
const COUNT_STEP = 4;
const COUNT_MIN = 2;
const COUNT_MAX = 96;
const WIDTH_STEP = 16;
const WIDTH_MIN = 16;
const WIDTH_MAX = 320;

export function framesSpecFor(input: {
  stripWidthPx: number;
  laneHeightPx: number;
  sourceWidthPx: number;
  sourceHeightPx: number;
  devicePixelRatio: number;
}): { count: number; frameWidth: number } | null {
  if (input.stripWidthPx <= 0 || input.laneHeightPx <= 0) return null;
  const aspect =
    input.sourceWidthPx > 0 && input.sourceHeightPx > 0
      ? input.sourceWidthPx / input.sourceHeightPx
      : 16 / 9;
  // Contain-fit cell: each frame is laneHeight tall and aspect-wide.
  const cellCssW = Math.max(8, input.laneHeightPx * aspect);
  const rawCount = input.stripWidthPx / cellCssW;
  const count = Math.min(
    COUNT_MAX,
    Math.max(COUNT_MIN, Math.round(rawCount / COUNT_STEP) * COUNT_STEP)
  );
  const dpr = Math.max(1, Math.min(3, input.devicePixelRatio || 1));
  const rawW = cellCssW * dpr;
  const frameWidth = Math.min(
    WIDTH_MAX,
    Math.max(WIDTH_MIN, Math.round(rawW / WIDTH_STEP) * WIDTH_STEP)
  );
  return { count, frameWidth };
}

export function useVideoTimelineAssets(input: {
  captureId: string | null;
  stripWidthPx: number;
  laneHeightPx: number;
  sourceWidthPx: number;
  sourceHeightPx: number;
  wantAudio: boolean;
  /** Skip audio when the record already says there's no track. */
  hasAudioTrack: boolean;
}): VideoTimelineAssets {
  const { captureId, stripWidthPx, laneHeightPx, sourceWidthPx, sourceHeightPx, wantAudio, hasAudioTrack } =
    input;
  const [frames, setFrames] = useState<VideoFramesResult | null>(null);
  const [audioBlob, setAudioBlob] = useState<Blob | null | undefined>(undefined);

  const dpr = typeof window !== "undefined" ? window.devicePixelRatio : 1;
  const spec = useMemo(
    () => framesSpecFor({ stripWidthPx, laneHeightPx, sourceWidthPx, sourceHeightPx, devicePixelRatio: dpr }),
    [dpr, laneHeightPx, sourceHeightPx, sourceWidthPx, stripWidthPx]
  );
  const specKey = spec === null ? null : `${spec.count}x${spec.frameWidth}`;

  // Drop the strip only when the capture changes; a resize keeps the
  // previous strip on screen until the re-quantized one arrives (no
  // flash of empty lane).
  useEffect(() => {
    setFrames(null);
  }, [captureId]);

  useEffect(() => {
    if (captureId === null || spec === null) return;
    let cancelled = false;
    void (async () => {
      const res = await dispatch("video:frames", {
        captureId,
        count: spec.count,
        frameWidth: spec.frameWidth
      });
      if (cancelled) return;
      if (res.ok) setFrames(res.value);
    })();
    return () => {
      cancelled = true;
    };
    // Keyed on the quantized spec string, not the object, so identity
    // churn from re-measures never refetches an identical strip.
  }, [captureId, specKey]);

  useEffect(() => {
    if (!wantAudio || captureId === null) {
      setAudioBlob(null);
      return;
    }
    if (!hasAudioTrack) {
      setAudioBlob(null);
      return;
    }
    setAudioBlob(undefined);
    let cancelled = false;
    void (async () => {
      const res = await dispatch("video:audio", { captureId });
      if (cancelled) return;
      if (!res.ok || !res.value.hasAudio) {
        setAudioBlob(null);
        return;
      }
      try {
        const r = await fetch(res.value.url);
        if (!r.ok) throw new Error(`audio fetch ${r.status}`);
        const blob = await r.blob();
        if (!cancelled) setAudioBlob(blob);
      } catch {
        if (!cancelled) setAudioBlob(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [captureId, hasAudioTrack, wantAudio]);

  return { frames, audioBlob };
}
