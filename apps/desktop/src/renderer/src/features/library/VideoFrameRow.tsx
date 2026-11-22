// The FRAME row above a video's GIF / MP4 export cards: the still under the
// playhead, at the recording's own resolution, copied or kept as a snap.
//
// It needs a playhead, so it shows only while a video stage is showing this
// capture (Focus or Reel). In the grid there is no head to point at, and a
// row that copied "frame 0:00.000" of a clip the user is not looking at
// would be a guess.

import type { ReactElement } from "react";
import {
  formatFrameTime,
  runVideoFrameAction,
  useVideoFrameActionStatus,
  useVideoFramePosition
} from "../shared/video-frame-actions";

export function VideoFrameRow({
  captureId,
  widthPx,
  heightPx
}: {
  captureId: string;
  widthPx: number;
  heightPx: number;
}): ReactElement | null {
  const timeSec = useVideoFramePosition(captureId);
  const status = useVideoFrameActionStatus();
  if (timeSec === null) return null;
  const busy = status !== null && status.captureId === captureId && status.phase === "working" ? status.kind : null;
  return (
    <div className="psl__copy-row-group psl__frame-row" data-testid="psl-copy-row-frame">
      <div className="psl__copy-format-eyebrow">
        <span className="psl__copy-format-eyebrow-label">
          Frame · <span className="psl__frame-row-time">{formatFrameTime(timeSec)}</span>
        </span>
        <span className="psl__copy-format-eyebrow-line" />
        <span className="psl__frame-row-dims">
          {widthPx} × {heightPx}
        </span>
      </div>
      <div className="psl__frame-row-actions">
        <button
          type="button"
          className="psl__frame-btn"
          data-testid="psl-frame-copy"
          disabled={busy !== null}
          aria-busy={busy === "copy"}
          data-tip="Copy the frame under the playhead"
          data-tip-detail="A PNG at the recording’s full resolution"
          onClick={() => void runVideoFrameAction(captureId, "copy")}
        >
          {busy === "copy" ? "Copying…" : "Copy PNG"}
        </button>
        <button
          type="button"
          className="psl__frame-btn"
          data-testid="psl-frame-save"
          disabled={busy !== null}
          aria-busy={busy === "save"}
          data-tip="Save the frame under the playhead as a snap"
          data-tip-detail="A new capture in the Library, timed to when the frame was on screen"
          onClick={() => void runVideoFrameAction(captureId, "save")}
        >
          {busy === "save" ? "Saving…" : "Save as Snap"}
        </button>
      </div>
    </div>
  );
}
