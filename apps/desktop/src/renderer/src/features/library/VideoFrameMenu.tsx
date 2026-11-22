// The video stage's right-click menu (Copy Frame / Save Frame as Snap /
// Copy Frame Time) and the status pill that reports what a frame action
// did. Both live INSIDE the stage: in Focus mode the stage is a modal
// <dialog>, and anything rendered outside it sits underneath.
//
// The rows act on the frame under the playhead at the moment of the
// right-click, which is what the menu's own label names — not wherever
// playback has drifted to by the time a row is chosen.

import { useEffect, useRef, type ReactElement } from "react";
import { closeWhenFocusLeaves } from "../shared/close-when-focus-leaves";
import { useContextMenuDismiss } from "../shared/useContextMenuDismiss";
import {
  clearVideoFrameActionStatus,
  formatFrameTime,
  runVideoFrameAction,
  useVideoFrameActionStatus
} from "../shared/video-frame-actions";

export type VideoFrameMenuState = { x: number; y: number; timeSec: number };

const MENU_WIDTH = 220;
const MENU_HEIGHT = 3 * 32 + 22;

/** Keep the menu inside the viewport. Pure. */
export function placeVideoFrameMenu(
  x: number,
  y: number,
  viewport: { width: number; height: number }
): { x: number; y: number } {
  return {
    x: Math.max(8, Math.min(x, viewport.width - MENU_WIDTH - 8)),
    y: Math.max(8, Math.min(y, viewport.height - MENU_HEIGHT - 8))
  };
}

export function VideoFrameMenu({
  captureId,
  menu,
  onClose
}: {
  captureId: string;
  menu: VideoFrameMenuState;
  onClose: () => void;
}): ReactElement {
  const rootRef = useRef<HTMLDivElement | null>(null);
  useContextMenuDismiss(rootRef, onClose);
  const label = formatFrameTime(menu.timeSec);
  const run = (kind: "copy" | "save" | "copyTime") => () => {
    onClose();
    void runVideoFrameAction(captureId, kind, menu.timeSec);
  };
  return (
    <div
      ref={rootRef}
      className="psl__context-menu psl__video-frame-menu"
      role="menu"
      tabIndex={-1}
      aria-label={`Frame at ${label}`}
      style={{ left: `${menu.x}px`, top: `${menu.y}px`, minWidth: `${MENU_WIDTH}px` }}
      onContextMenu={(event) => event.preventDefault()}
      onBlur={closeWhenFocusLeaves(onClose)}
      data-testid="video-frame-menu"
    >
      <button type="button" role="menuitem" tabIndex={-1} className="psl__context-menu-row" onClick={run("copy")}>
        Copy Frame
      </button>
      <button type="button" role="menuitem" tabIndex={-1} className="psl__context-menu-row" onClick={run("save")}>
        Save Frame as Snap
      </button>
      <div className="psl__context-menu-sep" role="separator" />
      <button type="button" role="menuitem" tabIndex={-1} className="psl__context-menu-row" onClick={run("copyTime")}>
        {`Copy Frame Time (${label})`}
      </button>
    </div>
  );
}

const STATUS_LINGER_MS = 2_600;

/** What the last frame action did, for this capture. Clears itself. */
export function VideoFrameStatusPill({ captureId }: { captureId: string }): ReactElement | null {
  const status = useVideoFrameActionStatus();
  const mine = status !== null && status.captureId === captureId ? status : null;
  useEffect(() => {
    if (mine === null || mine.phase === "working") return;
    const seq = mine.seq;
    const timer = window.setTimeout(() => clearVideoFrameActionStatus(seq), STATUS_LINGER_MS);
    return () => window.clearTimeout(timer);
  }, [mine]);
  if (mine === null) return null;
  return (
    <div
      className="psl__video-frame-status"
      data-phase={mine.phase}
      role={mine.phase === "failed" ? "alert" : "status"}
      aria-live="polite"
      data-testid="video-frame-status"
    >
      {mine.message}
    </div>
  );
}
