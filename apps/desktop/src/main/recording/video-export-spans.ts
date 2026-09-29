// Which spans an export request encodes. Pure and dependency-free on
// purpose: `video:export`, `video:presetMetrics` and the drag / clipboard
// resolver all call it, and the handler tests mock the exporter module
// wholesale — this must stay reachable when they do.

import type { VideoCaptureMetadata, VideoRange } from "@pwrsnap/shared";
import {
  ok,
  err,
  normalizeVideoSegments,
  type Result,
  type PwrSnapError,
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
): Result<{ range: VideoRange; spans: VideoRange[] }, PwrSnapError> {
  let spans: VideoRange[];
  if (request.segments !== undefined) {
    spans = videoExportSpans(normalizeVideoSegments(request.segments, video.durationSec));
    if (spans.length === 0) {
      return err({
        kind: "validation",
        code: "invalid_segments",
        message: "Nothing to export: every requested span is outside the recording or shorter than 0.1 seconds."
      });
    }
  } else if (request.range !== undefined) {
    // Same clamp as `normalizeRange` in video-repo: keeps a valid
    // float verbatim, so the single-range cache key is unchanged.
    const d = video.durationSec;
    const start = Math.max(0, Math.min(request.range.start, d));
    spans = [{ start, end: Math.max(start, Math.min(request.range.end, d)) }];
  } else {
    spans = videoExportSpans(videoSegmentsOrFull(video.segments, video.durationSec));
  }
  return ok({ range: videoSegmentsOuterRange(spans), spans });
}
