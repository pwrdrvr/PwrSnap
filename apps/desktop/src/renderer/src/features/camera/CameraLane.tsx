// The camera lane — one row of the timeline strip, showing where the
// camera track sits against the screen recording. It IS the sync control:
// drag the camera's span sideways and the presenter moves earlier or
// later; the toolbar's ‹ › and ⌥←/⌥→ nudge it a frame at a time.
//
// The span sits at `offsetSec + syncOffsetSec` (when the camera's first
// frame plays) and is `durationSec` long, so a camera that started late or
// stopped early is visibly shorter than the screen.

import { useRef, useState, type PointerEvent as ReactPointerEvent, type ReactElement } from "react";
import {
  formatSyncOffset,
  PRESENTER_SYNC_LIMIT_SEC,
  type AvatarStyle,
  type CameraTrackMetadata
} from "@pwrsnap/shared";
import { PresenterIcon } from "./PresenterIcons";

export type CameraLaneModel = {
  readonly track: CameraTrackMetadata;
  readonly style: AvatarStyle;
  readonly selected: boolean;
  readonly stripUrl: string | null;
  readonly missing: boolean;
  readonly onSelect: () => void;
  /** A finished drag — the new sync offset, in seconds. */
  readonly onSyncChange: (syncOffsetSec: number) => void;
};

export const CAMERA_LANE_H = 30;

type Drag = { pointerId: number; startX: number; start: number; moved: boolean };

export function CameraLane({
  lane,
  durationSec,
  width
}: {
  readonly lane: CameraLaneModel;
  readonly durationSec: number;
  readonly width: number;
}): ReactElement {
  const { track, style } = lane;
  const [draftSync, setDraftSync] = useState<number | null>(null);
  const drag = useRef<Drag | null>(null);
  const sync = draftSync ?? style.syncOffsetSec ?? 0;
  const startSec = track.offsetSec + sync;
  const pct = (sec: number): string => `${(Math.max(0, Math.min(durationSec, sec)) / durationSec) * 100}%`;
  const left = pct(startSec);
  const right = `calc(100% - ${pct(startSec + track.durationSec)})`;
  const ghost = draftSync !== null ? { left: pct(track.offsetSec + (style.syncOffsetSec ?? 0)), right: `calc(100% - ${pct(track.offsetSec + (style.syncOffsetSec ?? 0) + track.durationSec)})` } : null;

  const badge = lane.missing
    ? { tone: "is-bad", text: "Camera file missing" }
    : track.timing === "estimated"
      ? { tone: "is-warn", text: "Camera · timing estimated" }
      : !style.visible
        ? { tone: "", text: "Camera · hidden" }
        : { tone: "", text: "Camera" };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return;
    // The strip under the lane scrubs; the span is ours.
    e.stopPropagation();
    e.preventDefault();
    lane.onSelect();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { pointerId: e.pointerId, startX: e.clientX, start: style.syncOffsetSec ?? 0, moved: false };
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId || width <= 0) return;
    const dx = e.clientX - d.startX;
    if (!d.moved && Math.abs(dx) < 3) return;
    d.moved = true;
    const next = d.start + (dx / width) * durationSec;
    const clamped = Math.max(-PRESENTER_SYNC_LIMIT_SEC, Math.min(PRESENTER_SYNC_LIMIT_SEC, next));
    // Whole frames, so a drag and the ‹ › buttons land on the same values.
    setDraftSync(Math.round(clamped * 30) / 30);
  };
  const finish = (commit: boolean) => (e: ReactPointerEvent<HTMLDivElement>): void => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    drag.current = null;
    const value = draftSync;
    setDraftSync(null);
    if (commit && d.moved && value !== null) lane.onSyncChange(Math.round(value * 1000) / 1000);
  };

  return (
    <div
      className={
        "vtl__camera" +
        (lane.selected ? " is-selected" : "") +
        (!style.visible ? " is-hidden" : "") +
        (lane.missing ? " is-missing" : "")
      }
      style={{ height: `${CAMERA_LANE_H}px` }}
      data-testid="video-timeline-camera"
    >
      {ghost !== null ? <div className="vtl__camera-ghost" style={ghost} aria-hidden="true" /> : null}
      {!lane.missing ? (
        <div
          className={"vtl__camera-span" + (lane.stripUrl === null ? " is-loading" : "")}
          style={{
            left,
            right,
            ...(lane.stripUrl !== null ? { backgroundImage: `url(${lane.stripUrl})` } : {})
          }}
          role="slider"
          tabIndex={-1}
          aria-label="Camera sync"
          aria-valuemin={-PRESENTER_SYNC_LIMIT_SEC}
          aria-valuemax={PRESENTER_SYNC_LIMIT_SEC}
          aria-valuenow={sync}
          aria-valuetext={formatSyncOffset(sync)}
          data-presenter-ui=""
          data-tip="Drag to sync the camera"
          data-tip-detail="⌥← ⌥→ moves it one frame"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={finish(true)}
          onPointerCancel={finish(false)}
          data-testid="video-timeline-camera-span"
        />
      ) : null}
      <span
        className={`vtl__camera-badge ${badge.tone}`}
        style={{ left: lane.missing ? "6px" : `calc(${left} + 5px)` }}
      >
        <PresenterIcon name={lane.missing ? "warn" : style.visible ? "camera" : "eyeOff"} size={11} />
        {badge.text}
      </span>
      {draftSync !== null ? (
        <span
          className="vtl__camera-tip"
          style={{ left: pct((Math.max(0, startSec) + Math.min(durationSec, startSec + track.durationSec)) / 2) }}
        >
          {formatSyncOffset(draftSync)}
        </span>
      ) : null}
    </div>
  );
}
