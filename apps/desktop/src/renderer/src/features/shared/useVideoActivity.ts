// On-screen activity for a video capture (`video:activity`) — the track
// behind the timeline's activity lane and its `Cut idle` chip.
//
// Main computes it once per capture with ffmpeg and caches it under the
// derived-video cache, so a remount or a second window reads a small
// JSON file rather than decoding the recording again.
//
// Returns `null` while the analysis runs and `undefined` when there is
// nothing to show — no capture, or the analysis failed. The lane is
// drawn for `null` (empty, so the strip does not jump when the track
// lands) and omitted for `undefined`.

import { useEffect, useState } from "react";
import type { VideoActivityTrack } from "@pwrsnap/shared";
import { dispatch } from "../../lib/pwrsnap";

export function useVideoActivity(
  captureId: string | null
): VideoActivityTrack | null | undefined {
  const [result, setResult] = useState<{
    captureId: string;
    track: VideoActivityTrack | undefined;
  } | null>(null);

  useEffect(() => {
    if (captureId === null) return;
    let cancelled = false;
    const land = (track: VideoActivityTrack | undefined): void => {
      if (!cancelled) setResult({ captureId, track });
    };
    void Promise.resolve(dispatch("video:activity", { captureId })).then(
      (res) =>
        land(
          res?.ok === true
            ? { sampleHz: res.value.sampleHz, magnitudes: res.value.magnitudes }
            : undefined
        ),
      () => land(undefined)
    );
    return () => {
      cancelled = true;
    };
  }, [captureId]);

  if (captureId === null) return undefined;
  if (result === null || result.captureId !== captureId) return null;
  return result.track;
}
