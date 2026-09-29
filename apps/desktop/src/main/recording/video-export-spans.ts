// Which spans an export request encodes. Pure and dependency-free on
// purpose: `video:export`, `video:presetMetrics` and the drag / clipboard
// resolver all call it, and the handler tests mock the exporter module
// wholesale — this must stay reachable when they do.

import type { VideoCaptureMetadata, VideoRange } from "@pwrsnap/shared";
import {
  videoExportSpans,
  videoSegmentsOrFull,
  videoSegmentsOuterRange
} from "@pwrsnap/shared";

/**
 * What an export request actually encodes: the kept spans (merged) and
 * their outer range. `segments` wins, then `range` (one contiguous
 * span, no cuts), then the record's persisted edit. Every export entry
 * point resolves through here so the three agree on which cuts apply.
 */
export function resolveVideoExportSpans(
  video: VideoCaptureMetadata,
  request: { range?: VideoRange | undefined; segments?: readonly VideoRange[] | undefined }
): { range: VideoRange; spans: VideoRange[] } {
  let spans: VideoRange[];
  if (request.segments !== undefined) {
    spans = videoExportSpans(videoSegmentsOrFull(request.segments, video.durationSec));
  } else if (request.range !== undefined) {
    // Same clamp as `normalizeRange` in video-repo: keeps a valid
    // float verbatim, so the single-range cache key is unchanged.
    const d = video.durationSec;
    const start = Math.max(0, Math.min(request.range.start, d));
    spans = [{ start, end: Math.max(start, Math.min(request.range.end, d)) }];
  } else {
    spans = videoExportSpans(videoSegmentsOrFull(video.segments, video.durationSec));
  }
  return { range: videoSegmentsOuterRange(spans), spans };
}
