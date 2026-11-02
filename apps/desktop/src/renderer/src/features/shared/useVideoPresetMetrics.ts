// Per-(format, preset) metrics hook for the video 6-card grid.
// Mirrors `usePresetRenderMetrics` for images but returns a
// (format, preset) -> CopyButtonMetric map instead of a flat
// preset map.
//
// Each entry carries: output dimensions string, byte size label,
// and an `exact` flag distinguishing "this is from the cache row"
// (after the first encode) from "this is an estimate computed
// against the source resolution" (before any click).
//
// Main side: `video:presetMetrics` returns six entries; cache hits
// return real byte counts, cache misses return the estimator's
// guess. The renderer renders both states identically — the only
// visible diff is the "~" prefix on the estimated byte label.

import { useEffect, useRef, useState } from "react";
import type {
  VideoExportAudio,
  VideoPreset,
  VideoPresetMetric,
  VideoRange
} from "@pwrsnap/shared";
import { dispatch } from "../../lib/pwrsnap";
import { videoSegmentsDepKey } from "./video-range";
import {
  exactPresetMetrics,
  type CopyButtonMetric
} from "./CopyButton";

/** Key shape for the metric map. `"gif-low"` / `"mp4-high"` etc.
 *  Distinct from `CopyPreset` because the keyspace is 2D. */
export type VideoPresetKey = `${"gif" | "mp4"}-${VideoPreset}`;

export type VideoPresetMetricMap = Partial<Record<VideoPresetKey, CopyButtonMetric>>;

export function videoPresetKey(
  format: "gif" | "mp4",
  preset: VideoPreset
): VideoPresetKey {
  return `${format}-${preset}` as const;
}

export function useVideoPresetMetrics(
  captureId: string | null,
  /** Trim range being displayed. Passed explicitly so byte estimates
   *  re-derive from the range duration as soon as the handles move
   *  (not only after the debounced persist). Omitted → main uses the
   *  persisted `defaultRange`. */
  range?: VideoRange | undefined,
  /** Export spans when the edit has cuts, so the byte estimates follow
   *  the KEPT length rather than the outer range. */
  segments?: readonly VideoRange[] | undefined,
  /** MP4 audio choice the row is showing, so a cached encode is found
   *  under the key the next click hits and the estimate counts the AAC
   *  track only when one is kept. Omitted → the saved preference. */
  audio?: VideoExportAudio | undefined
): VideoPresetMetricMap {
  const [metrics, setMetrics] = useState<VideoPresetMetricMap>({});
  const rangeStart = range?.start;
  const rangeEnd = range?.end;
  const includeMicrophone = audio?.includeMicrophone;
  const includeSystemAudio = audio?.includeSystemAudio;
  const segmentsKey = videoSegmentsDepKey(segments);
  const segmentsRef = useRef(segments);
  segmentsRef.current = segments;

  useEffect(() => {
    if (captureId === null) {
      setMetrics({});
      return undefined;
    }

    let cancelled = false;
    setMetrics({});
    const spans = segmentsKey === "" ? undefined : segmentsRef.current;
    const req = {
      captureId,
      ...(rangeStart === undefined || rangeEnd === undefined
        ? {}
        : { range: { start: rangeStart, end: rangeEnd } }),
      ...(includeMicrophone === undefined || includeSystemAudio === undefined
        ? {}
        : { audio: { includeMicrophone, includeSystemAudio } }),
      ...(spans === undefined ? {} : { segments: spans.map((s) => ({ ...s })) })
    };
    void dispatch("video:presetMetrics", req).then((result) => {
      if (cancelled) return;
      if (!result.ok) return;
      setMetrics(metricsByKey(result.value.metrics));
    });

    // No dependency on edits_version: the video pipeline doesn't
    // have an edits-on-source story today. When that lands (see
    // plan §7), thread the version through here and refetch.
    return () => {
      cancelled = true;
    };
  }, [captureId, includeMicrophone, includeSystemAudio, rangeStart, rangeEnd, segmentsKey]);

  return metrics;
}

function metricsByKey(metrics: readonly VideoPresetMetric[]): VideoPresetMetricMap {
  const out: VideoPresetMetricMap = {};
  for (const m of metrics) {
    out[videoPresetKey(m.format, m.preset)] = exactPresetMetrics({
      widthPx: m.widthPx,
      heightPx: m.heightPx,
      byteSize: m.byteSize
    });
    // Cache-miss entries land here with `exact: true` because the
    // main-side metric already encodes the truthful state via the
    // `fromCache` field — but we want the renderer's "~" prefix on
    // estimates. Patch `exact` to match `fromCache`.
    out[videoPresetKey(m.format, m.preset)] = {
      dim: `${m.widthPx} × ${m.heightPx}`,
      bytes: formatBytesLabel(m.byteSize, !m.fromCache),
      exact: m.fromCache
    };
  }
  return out;
}

function formatBytesLabel(n: number, estimated: boolean): string {
  const prefix = estimated ? "~" : "";
  if (n < 1024) return `${prefix}${n} B`;
  if (n < 1024 * 1024) return `${prefix}${Math.round(n / 1024)} KB`;
  return `${prefix}${(n / (1024 * 1024)).toFixed(1)} MB`;
}
